import { Injectable, Logger } from '@nestjs/common';
import { Client, Attribute, Change } from 'ldapts';
import {
  AdConfig,
  AdUserDto,
  AdUserEntry,
  AdGroupEntry,
  AdHealthCheckResult,
} from './ad.interface';
import { CONNECTOR_TIMEOUT_MS } from '@infrastructure/config/defaults';
import { resolveHostForConnect } from '@infrastructure/url-validation/ssrf-guard';
import { maskPersonalData } from '../../../activities/deprovision-failure';

/** LDAP result code: the bind's credentials were refused. */
const LDAP_INVALID_CREDENTIALS = 49;
/** LDAP result code: entry already exists */
const LDAP_ALREADY_EXISTS = 68;
/** LDAP result codes for a membership removal of a value the group does not hold. */
const LDAP_NO_SUCH_ATTRIBUTE = 16;
const LDAP_UNWILLING_TO_PERFORM = 53;
const LDAP_NO_SUCH_OBJECT = 32;
/** userAccountControl ACCOUNTDISABLE flag, and the value of a normal enabled account. */
const UAC_ACCOUNTDISABLE = 0x2;
const UAC_NORMAL_ACCOUNT = 512;
/** AD's diagnostic for removing a non-member (ERROR_MEMBER_NOT_IN_GROUP, 1377 = 0x561). */
const AD_MEMBER_NOT_IN_GROUP = /\b0*561:/;

/**
 * LDAP client for Active Directory. Handles connect, bind, add, search.
 * Never logs passwords. Uses LDAPS by default.
 */
/**
 * The first value of an attribute as ldapts gives it: one value as itself (a string, or a Buffer
 * for a binary attribute), several as an array, a requested attribute the entry lacks as [].
 */
function firstValue<T>(value: unknown): T | undefined {
  return (Array.isArray(value) ? value[0] : value) as T | undefined;
}

/**
 * What a failed health check answers: whether the directory refused the service account, or no
 * connection was made. The reason itself (the guard naming the address a host resolves to, LDAP
 * diagnostics) is logged, never answered: an operator can test any host from the connector form,
 * and the answer would map internal names to addresses.
 */
function healthCheckError(e: unknown): string {
  if ((e as { code?: unknown } | null)?.code === LDAP_INVALID_CREDENTIALS) {
    return 'The directory refused the service account sign-in: check the service account and password';
  }
  return (
    'Could not connect to the directory: check the host, port and LDAPS setting ' +
    '(EuroID connects only to public addresses)'
  );
}

@Injectable()
export class AdClient {
  private readonly logger = new Logger(AdClient.name);

  /**
   * Bind to AD with service account. Call before any operation.
   */
  async bind(config: AdConfig): Promise<void> {
    const client = await this.connect(config);
    await client.bind(config.serviceAccount, config.password);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- stashing reference on Client for lifecycle tracking; ldapts has no extensible type
    (client as any)._adClientRef = client;
  }

  /**
   * Unbind and close connection. Call after operations.
   */
  async unbind(_config: AdConfig): Promise<void> {
    // Client is created per-operation; unbind is implicit when client goes out of scope
    // For health check we create a transient client
  }

  /**
   * Create a bound client for a sequence of operations.
   * Caller must call client.unbind() when done.
   */
  async createBoundClient(config: AdConfig): Promise<Client> {
    const client = await this.connect(config);
    await client.bind(config.serviceAccount, config.password);
    return client;
  }

  /**
   * An LDAP client for the configured host, connecting to the address the SSRF guard vetted, not
   * to the name again (a second resolution could answer another address: DNS rebinding, hunt
   * 01 F17). LDAPS checks the certificate against the host name (`servername`); plain LDAP gets no
   * TLS options, since ldapts would then use TLS.
   */
  private async connect(config: AdConfig): Promise<Client> {
    const { address, servername } = await resolveHostForConnect(config.host);
    const useLdaps = config.useLdaps !== false;
    const port = config.port ?? (useLdaps ? 636 : 389);
    const host = address.includes(':') ? `[${address}]` : address;
    return new Client({
      url: `${useLdaps ? 'ldaps' : 'ldap'}://${host}:${port}`,
      timeout: CONNECTOR_TIMEOUT_MS,
      ...(useLdaps && servername ? { tlsOptions: { servername } } : {}),
    });
  }

  /**
   * Add user with password. AD requires unicodePwd via modify (UTF-16LE).
   * On LDAP 68 (already exists), returns existing DN — idempotent.
   * When the add succeeds and setting the password fails (no LDAPS, a password the domain
   * policy refuses), the entry just added is deleted again and the password error thrown: an
   * account left without its password would be found by the retry (LDAP 68, or the own-account
   * lookup) and taken as provisioned. A failed delete is logged; the error is the same.
   */
  async addUser(
    config: AdConfig,
    dn: string,
    attributes: AdUserDto,
    password: string,
  ): Promise<{ dn: string }> {
    const client = await this.createBoundClient(config);
    try {
      const entry = this.toLdapEntry(attributes);
      try {
        await client.add(dn, entry);
      } catch (e: unknown) {
        const code = (e as { code?: number })?.code;
        if (code === LDAP_ALREADY_EXISTS) {
          this.logger.log(
            `User already exists at ${maskPersonalData(dn)}, returning success (idempotent)`,
          );
          return { dn };
        }
        throw e;
      }
      // Set password via modify (AD requires this for unicodePwd)
      const unicodePwd = Buffer.from(`"${password}"`, 'utf16le');
      try {
        await client.modify(
          dn,
          new Change({
            operation: 'replace',
            modification: new Attribute({ type: 'unicodePwd', values: [unicodePwd] }),
          }),
        );
      } catch (e: unknown) {
        await client.del(dn).catch((delError: unknown) => {
          this.logger.error(
            `Could not delete ${maskPersonalData(dn)} after its password was refused; it ` +
              `stays without a password: ${delError instanceof Error ? delError.message : String(delError)}`,
          );
        });
        throw e;
      }
      return { dn };
    } finally {
      await client.unbind();
    }
  }

  private toLdapEntry(attrs: AdUserDto): Record<string, string | string[]> {
    const entry: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null) continue;
      if (k === 'objectClass') {
        entry.objectClass = (v as string[]).length ? (v as string[]) : ['user'];
      } else if (k === 'userAccountControl') {
        entry.userAccountControl = String(v);
      } else if (Array.isArray(v)) {
        entry[k] = v;
      } else {
        entry[k] = String(v);
      }
    }
    return entry;
  }

  /**
   * Search users under baseDn. Filter by mail or sAMAccountName if provided.
   */
  async searchUsers(config: AdConfig, baseDn: string, filter?: string): Promise<AdUserEntry[]> {
    const client = await this.createBoundClient(config);
    try {
      const f = filter || '(objectClass=user)';
      const { searchEntries } = await client.search(baseDn, {
        scope: 'sub',
        filter: f,
        attributes: [
          'dn',
          'sAMAccountName',
          'mail',
          'userPrincipalName',
          'userAccountControl',
          'objectGUID',
        ],
        explicitBufferAttributes: ['objectGUID'],
      });
      return searchEntries.map((e: Record<string, unknown>) => {
        return {
          dn: e.dn as string,
          sAMAccountName: firstValue<string>(e.sAMAccountName),
          mail: firstValue<string>(e.mail),
          userPrincipalName: firstValue<string>(e.userPrincipalName),
          userAccountControl: firstValue<string>(e.userAccountControl),
          // One value comes as a Buffer; none as []
          ...(Buffer.isBuffer(e.objectGUID) && { objectGUID: e.objectGUID }),
        };
      });
    } finally {
      await client.unbind();
    }
  }

  /**
   * Search groups under baseDn for discovery.
   */
  async searchGroups(config: AdConfig, baseDn: string): Promise<AdGroupEntry[]> {
    const client = await this.createBoundClient(config);
    try {
      const { searchEntries } = await client.search(baseDn, {
        scope: 'sub',
        filter: '(objectClass=group)',
        attributes: ['dn', 'cn', 'name', 'objectSid'],
      });
      return searchEntries.map((e: Record<string, unknown>) => {
        const rawSid = firstValue<Buffer | string>(e.objectSid);
        return {
          dn: e.dn as string,
          cn: firstValue<string>(e.cn),
          name: firstValue<string>(e.name) ?? firstValue<string>(e.cn),
          ...(rawSid !== undefined && rawSid !== null && { objectSid: rawSid }),
        };
      });
    } finally {
      await client.unbind();
    }
  }

  /**
   * Add user to group (modify group's member attribute).
   */
  async addUserToGroup(config: AdConfig, userDn: string, groupDn: string): Promise<void> {
    const client = await this.createBoundClient(config);
    try {
      await client.modify(
        groupDn,
        new Change({
          operation: 'add',
          modification: new Attribute({ type: 'member', values: [userDn] }),
        }),
      );
    } catch (e: unknown) {
      const msg = (e as Error)?.message ?? String(e);
      if (msg.includes('already exists') || msg.includes('constraint')) {
        return;
      }
      throw e;
    } finally {
      await client.unbind();
    }
  }

  /**
   * Remove user from group.
   */
  async removeUserFromGroup(config: AdConfig, userDn: string, groupDn: string): Promise<void> {
    const client = await this.createBoundClient(config);
    try {
      await client.modify(
        groupDn,
        new Change({
          operation: 'delete',
          modification: new Attribute({ type: 'member', values: [userDn] }),
        }),
      );
    } catch (e: unknown) {
      const msg = (e as Error)?.message ?? String(e);
      if (msg.includes('no such attribute') || msg.includes('No such')) {
        return;
      }
      throw e;
    } finally {
      await client.unbind();
    }
  }

  /**
   * Health check: bind + unbind. Returns boolean for simple check.
   */
  async healthCheck(config: AdConfig): Promise<boolean> {
    const result = await this.healthCheckEnriched(config);
    return result.connected;
  }

  /**
   * Enriched health check for UI: bind, validate root/user base, count groups.
   */
  async healthCheckEnriched(config: AdConfig): Promise<AdHealthCheckResult> {
    try {
      const client = await this.createBoundClient(config);
      const rootBaseDn = config.rootBaseDn?.trim() || config.baseDn?.trim();
      const userSearchBase = config.userSearchBase?.trim() || rootBaseDn;

      let rootBaseDnValid = false;
      let userSearchBaseValid = false;
      let groupCount = 0;

      if (rootBaseDn) {
        try {
          await client.search(rootBaseDn, {
            scope: 'base',
            filter: '(objectClass=*)',
            attributes: ['dn'],
          });
          rootBaseDnValid = true;
        } catch {
          rootBaseDnValid = false;
        }
      } else {
        rootBaseDnValid = true;
      }

      if (userSearchBase && rootBaseDnValid) {
        try {
          const { searchEntries } = await client.search(userSearchBase, {
            scope: 'sub',
            filter: '(objectClass=group)',
            attributes: ['dn'],
          });
          userSearchBaseValid = true;
          groupCount = searchEntries.length;
        } catch {
          userSearchBaseValid = false;
        }
      } else if (rootBaseDnValid) {
        userSearchBaseValid = true;
      }

      await client.unbind();
      return {
        connected: true,
        rootBaseDnValid,
        userSearchBaseValid,
        groupCount,
      };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn(`[AD Health] Failed: ${msg}`);
      return { connected: false, error: healthCheckError(e) };
    }
  }

  // ── Credential state (dumb pipe, read only: no password reset) ────────────

  /**
   * Get credential state from AD: pwdLastSet, userAccountControl.
   */
  async getCredentialState(
    config: AdConfig,
    userDn: string,
  ): Promise<{ pwdLastSet?: string; userAccountControl?: string }> {
    const client = await this.createBoundClient(config);
    try {
      const { searchEntries } = await client.search(userDn, {
        scope: 'base',
        filter: '(objectClass=user)',
        attributes: ['pwdLastSet', 'userAccountControl'],
      });
      const entry = searchEntries[0] as Record<string, unknown> | undefined;
      return {
        pwdLastSet: firstValue<string>(entry?.pwdLastSet),
        userAccountControl: firstValue<string>(entry?.userAccountControl),
      };
    } finally {
      await client.unbind();
    }
  }

  /**
   * Disable user: set ACCOUNTDISABLE (0x2) in its userAccountControl and keep its other flags
   * (DONT_EXPIRE_PASSWORD and the like, which a later enable keeps too). An entry without a
   * readable userAccountControl gets 514 (normal account, disabled).
   */
  async disableUser(config: AdConfig, userDn: string): Promise<void> {
    await this.setAccountDisabled(config, userDn, true);
  }

  /**
   * Enable user: clear ACCOUNTDISABLE (0x2) in its userAccountControl and keep its other flags.
   * An entry without a readable userAccountControl gets 512 (normal account). A privileged
   * session enables a linked admin account this way; disableUser sets the flag again at its end.
   */
  async enableUser(config: AdConfig, userDn: string): Promise<void> {
    await this.setAccountDisabled(config, userDn, false);
  }

  /** Read the entry's userAccountControl and write it back with ACCOUNTDISABLE set or cleared. */
  private async setAccountDisabled(
    config: AdConfig,
    userDn: string,
    disabled: boolean,
  ): Promise<void> {
    const client = await this.createBoundClient(config);
    try {
      const { searchEntries } = await client.search(userDn, {
        scope: 'base',
        filter: '(objectClass=*)',
        attributes: ['userAccountControl'],
      });
      const raw = firstValue<string>(
        (searchEntries[0] as Record<string, unknown> | undefined)?.userAccountControl,
      );
      const parsed = raw === undefined ? NaN : parseInt(raw, 10);
      const current = Number.isNaN(parsed) ? UAC_NORMAL_ACCOUNT : parsed;
      const value = disabled ? current | UAC_ACCOUNTDISABLE : current & ~UAC_ACCOUNTDISABLE;
      await client.modify(
        userDn,
        new Change({
          operation: 'replace',
          modification: new Attribute({ type: 'userAccountControl', values: [String(value)] }),
        }),
      );
    } finally {
      await client.unbind();
    }
  }

  // ── Group membership (access review revocation) ─────────────────────

  /**
   * Direct group memberships (memberOf DNs) of the entry at `dn`; null when no entry has that
   * DN (the account was deleted, moved or renamed).
   */
  async getMemberOf(config: AdConfig, dn: string): Promise<string[] | null> {
    const client = await this.createBoundClient(config);
    try {
      const { searchEntries } = await client.search(dn, {
        scope: 'base',
        filter: '(objectClass=*)',
        attributes: ['memberOf'],
      });
      const entry = searchEntries[0] as Record<string, unknown> | undefined;
      if (!entry) return null;
      const memberOf = entry.memberOf;
      if (memberOf === undefined || memberOf === null) return [];
      return (Array.isArray(memberOf) ? memberOf : [memberOf]).map((v) => String(v));
    } catch (e: unknown) {
      if ((e as { code?: number })?.code === LDAP_NO_SUCH_OBJECT) return null;
      throw e;
    } finally {
      await client.unbind();
    }
  }

  /**
   * Remove `userDn` from the group's `member` values, saying whether a membership was removed.
   * `not-member` when the directory answers that the group does not hold the value (OpenLDAP:
   * noSuchAttribute; AD: unwillingToPerform with 00000561). Other errors propagate; unlike
   * removeUserFromGroup nothing is swallowed by message text.
   */
  async removeGroupMember(
    config: AdConfig,
    userDn: string,
    groupDn: string,
  ): Promise<'removed' | 'not-member'> {
    const client = await this.createBoundClient(config);
    try {
      await client.modify(
        groupDn,
        new Change({
          operation: 'delete',
          modification: new Attribute({ type: 'member', values: [userDn] }),
        }),
      );
      return 'removed';
    } catch (e: unknown) {
      const code = (e as { code?: number })?.code;
      const message = e instanceof Error ? e.message : String(e);
      if (
        code === LDAP_NO_SUCH_ATTRIBUTE ||
        (code === LDAP_UNWILLING_TO_PERFORM && AD_MEMBER_NOT_IN_GROUP.test(message))
      ) {
        return 'not-member';
      }
      throw e;
    } finally {
      await client.unbind();
    }
  }
}
