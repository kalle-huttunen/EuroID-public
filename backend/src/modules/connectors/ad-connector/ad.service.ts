import { Injectable, Logger } from '@nestjs/common';
import { ConnectorException } from '@shared/exceptions/domain-exceptions';
import { IConnector } from '../connector.interface';
import type { CredentialState } from '../credential-management.interface';
import { AdClient } from './ad.client';
import {
  AdConfig,
  AdUserDto,
  Entitlement,
  ProvisioningIntent,
  IAdConnector,
  isInsideBaseDn,
} from './ad.interface';
import { toAdUser, toDn } from './ad.mapper';
import { escapeLdapFilter } from './ad-utils';
import { StandardUserDto } from '@shared/dtos/standard-user.dto';
import { ProvisioningResult } from '@shared/dtos/provisioning-result.dto';
import type { TargetAccount } from '@shared/interfaces/provisioning.interface';
import type { DeprovisionResult } from '@shared/types/deprovision';
import type { PamAccountResult } from '@shared/types/pam-session';
import { NoSuchObjectError } from 'ldapts';
import { maskPersonalData } from '../../../activities/deprovision-failure';

const AD_SYSTEM = 'ad';

/** LDAP result code: entry already exists (LDAP_ALREADY_EXISTS) */
const LDAP_ALREADY_EXISTS = 68;

function classifyLdapError(error: unknown): { code: number | null; isAlreadyExists: boolean } {
  const code = (error as { code?: number })?.code ?? null;
  const msg = (error as Error)?.message ?? String(error);
  const isAlreadyExists =
    code === LDAP_ALREADY_EXISTS || /(?:^|\D)68(?:\D|$)/.test(msg) || /already\s+exists/i.test(msg);
  return { code, isAlreadyExists };
}

/** objectGUID bytes as the GUID AD shows (first three groups little-endian); undefined if not 16. */
function formatObjectGuid(bytes: Buffer): string | undefined {
  if (bytes.length !== 16) return undefined;
  const hex = (from: number, to: number, littleEndian = false): string => {
    const part = Buffer.from(bytes.subarray(from, to));
    return (littleEndian ? part.reverse() : part).toString('hex');
  };
  return [hex(0, 4, true), hex(4, 6, true), hex(6, 8, true), hex(8, 10), hex(10, 16)].join('-');
}

/**
 * Active Directory connector. Provisions users via LDAP/LDAPS with Base DN partitioning.
 * Implements IConnector for plugin registry; config is passed from Blueprint/ConnectorConfig.
 */
/** userAccountControl ACCOUNTDISABLE flag. */
const UAC_ACCOUNTDISABLE = 0x2;

/**
 * Whether a userAccountControl value leaves the account enabled: ACCOUNTDISABLE not set,
 * whatever other flags it has (66050 is disabled with a password that never expires). An entry
 * without the attribute reads as a normal enabled account (512).
 */
function isUacEnabled(raw: string | undefined): boolean {
  return (parseInt(raw ?? '512', 10) & UAC_ACCOUNTDISABLE) === 0;
}

@Injectable()
export class AdService implements IConnector, IAdConnector {
  private readonly logger = new Logger(AdService.name);

  constructor(private readonly client: AdClient) {}

  /**
   * IConnector.create — requires config. Use provision(config, user, intent) instead.
   */
  async create(
    _user: StandardUserDto,
    _intent?: unknown,
  ): Promise<{ targetUserId: string } | string> {
    throw new ConnectorException(
      'AdService requires config. Use provision(config, user, intent) instead.',
    );
  }

  /**
   * Discover groups under search base. IConnector + IAdConnector.
   * Returns [] when config is missing or invalid.
   */
  async discover(config?: AdConfig | unknown): Promise<Entitlement[]> {
    const cfg = this.resolveAdConfig(config);
    if (!cfg) return [];
    const searchBase = cfg.userSearchBase?.trim() || cfg.rootBaseDn?.trim() || cfg.baseDn?.trim();
    if (!searchBase) return [];
    return this.discoverInternal({ ...cfg, _effectiveSearchBase: searchBase });
  }

  /**
   * Health check — bind + unbind. IConnector + IAdConnector.
   * Returns false when config is missing or invalid.
   */
  async healthCheck(config?: AdConfig | unknown): Promise<boolean> {
    const cfg = this.resolveAdConfig(config);
    return cfg ? this.client.healthCheck(cfg) : false;
  }

  /**
   * List all users from AD (for orphan detection / reconciliation).
   * Maps AD entries to TargetAccount shape for consistency with Entra.
   */
  async listUsers(config: AdConfig): Promise<TargetAccount[]> {
    const resolved = this.resolveAdConfig(config);
    if (!resolved) return [];
    const baseDn =
      resolved.userSearchBase?.trim() ||
      resolved.rootBaseDn?.trim() ||
      resolved.baseDn?.trim() ||
      '';
    if (!baseDn) return [];
    const entries = await this.client.searchUsers(resolved, baseDn, '(objectClass=user)');
    return entries.map((e) => {
      const accountEnabled = isUacEnabled(e.userAccountControl);
      const objectGuid = e.objectGUID ? formatObjectGuid(e.objectGUID) : undefined;
      return {
        id: e.dn,
        userPrincipalName: e.userPrincipalName ?? e.mail ?? e.dn,
        mail: e.mail,
        displayName: undefined,
        accountEnabled,
        ...(objectGuid && { objectGuid }),
      };
    });
  }

  private isValidAdConfig(c: unknown): c is AdConfig {
    return !!c && typeof (c as AdConfig).host === 'string';
  }

  /** Resolve config with backward compat: baseDn → rootBaseDn. Validate scoping. */
  private resolveAdConfig(c: unknown): AdConfig | null {
    if (!this.isValidAdConfig(c)) return null;
    const cfg = c as AdConfig;
    const rootBaseDn = cfg.rootBaseDn?.trim() || cfg.baseDn?.trim();
    if (!rootBaseDn) return null;
    const userSearchBase = cfg.userSearchBase?.trim();
    if (userSearchBase && !isInsideBaseDn(userSearchBase, rootBaseDn)) {
      throw new ConnectorException(
        'User Search Base is not inside Root Base DN. Scoping validation failed.',
      );
    }
    return {
      ...cfg,
      rootBaseDn: rootBaseDn || cfg.rootBaseDn,
      userSearchBase: userSearchBase || undefined,
    };
  }

  /**
   * Provision user to AD. Requires pre-resolved samAccountName, userPrincipalName, and password on call.
   * Dumb pipe: maps fields and calls LDAP. Group operations and credential generation are handled by the activity layer.
   * `commonName`: the CN to create the account under when the caller found the person's name taken
   * in the OU (default: the display name).
   */
  async provision(
    config: AdConfig,
    user: StandardUserDto,
    _intent?: ProvisioningIntent,
    password?: string,
    commonName?: string,
  ): Promise<ProvisioningResult> {
    const sAMAccountName = user.samAccountName;
    const userPrincipalName = user.userPrincipalName;
    if (!sAMAccountName || !userPrincipalName) {
      throw new ConnectorException(
        'AD connector requires pre-resolved samAccountName and userPrincipalName. Use AdActivities.provisionUserToAd.',
      );
    }
    if (!password) {
      throw new ConnectorException(
        'AD connector requires a pre-generated password. Use CredentialGenerationService in the activity layer.',
      );
    }

    const resolved = this.resolveAdConfig(config);
    if (!resolved) throw new ConnectorException('AD config invalid: missing host or base DN');

    const adUser = toAdUser(user, resolved, sAMAccountName, userPrincipalName, commonName);
    const dn = toDn(user, resolved, sAMAccountName, commonName);

    const resultDn = await this.createUser(resolved, adUser, dn, password);

    return {
      targetUserId: resultDn,
      generatedAttributes: {
        mail: adUser.mail,
        userPrincipalName: adUser.userPrincipalName,
        samAccountName: adUser.sAMAccountName,
        distinguishedName: resultDn,
      },
    };
  }

  /**
   * Create user in AD. Dumb pipe: maps attributes and calls LDAP addUser.
   * Idempotent: on LDAP 68 (already exists), returns existing DN. Whatever holds the DN answers
   * so: the caller checks it is the account it meant (provisionUserToAd compares the UPN).
   */
  async createUser(
    config: AdConfig,
    adUser: AdUserDto,
    dn: string,
    password: string,
  ): Promise<string> {
    const resolved = this.resolveAdConfig(config);
    if (!resolved) throw new ConnectorException('AD config invalid: missing host or base DN');

    try {
      const res = await this.client.addUser(resolved, dn, adUser, password);
      return res.dn;
    } catch (e: unknown) {
      if (classifyLdapError(e).isAlreadyExists) {
        this.logger.log(
          `User already exists at ${maskPersonalData(dn)}, returning success (idempotent)`,
        );
        return dn;
      }
      throw e;
    }
  }

  /**
   * Add user to group. Dumb pipe: delegates to LDAP client.
   */
  async addUserToGroup(config: AdConfig, userDn: string, groupDn: string): Promise<void> {
    const resolved = this.resolveAdConfig(config);
    if (!resolved) throw new ConnectorException('AD config invalid: missing host or base DN');
    await this.client.addUserToGroup(resolved, userDn, groupDn);
  }

  private async discoverInternal(
    config: AdConfig & { _effectiveSearchBase?: string },
  ): Promise<Entitlement[]> {
    const searchBase =
      config._effectiveSearchBase ??
      config.userSearchBase?.trim() ??
      config.rootBaseDn?.trim() ??
      config.baseDn ??
      '';
    const groups = await this.client.searchGroups(config, searchBase);
    const entitlements: Entitlement[] = groups.map((g) => {
      const ent: Entitlement = {
        nativeId: g.dn,
        name: g.name ?? g.cn ?? g.dn,
        type: 'Group' as const,
        system: AD_SYSTEM,
      };
      // Return raw RID as metadata — PAM tier classification is handled by the Brain (PamFilterService)
      const rid = this.extractRidFromObjectSid(g.objectSid);
      if (rid) {
        ent.metadata = { rid };
      }
      return ent;
    });
    this.logger.log(`[AD DISCOVER] Found ${entitlements.length} groups under ${searchBase}`);
    return entitlements;
  }

  /** Extract RID from objectSid (binary Buffer or S-1-5-... string). */
  private extractRidFromObjectSid(obj: unknown): string | null {
    if (Buffer.isBuffer(obj) && obj.length >= 4) {
      return String(obj.readUInt32LE(obj.length - 4));
    }
    if (typeof obj === 'string' && /^S-1-5(-\d+)+$/.test(obj)) {
      const parts = obj.split('-');
      return parts[parts.length - 1] ?? null;
    }
    return null;
  }

  async deprovision(config: AdConfig, externalId: string): Promise<boolean> {
    await this.client.disableUser(config, externalId);
    return true;
  }

  /**
   * Offboarding: disable the account with this DN (the written-back id). LDAP "no such object"
   * (result code 32) for that DN means the account is already gone; other errors propagate.
   */
  async deprovisionUser(config: AdConfig, dn: string): Promise<DeprovisionResult> {
    try {
      await this.client.disableUser(config, dn);
    } catch (err: unknown) {
      if (err instanceof NoSuchObjectError || (err as { code?: unknown })?.code === 32) {
        return { outcome: 'already-gone', detail: 'no such object' };
      }
      throw err;
    }
    return { outcome: 'deprovisioned', detail: 'disabled' };
  }

  /**
   * A privileged session: enable (clear ACCOUNTDISABLE) or disable (514) the account with this DN
   * (the written-back id). LDAP "no such object" for the DN is not-found; other errors propagate.
   */
  async setUserEnabled(config: AdConfig, dn: string, enabled: boolean): Promise<PamAccountResult> {
    try {
      if (enabled) await this.client.enableUser(config, dn);
      else await this.client.disableUser(config, dn);
    } catch (err: unknown) {
      if (err instanceof NoSuchObjectError || (err as { code?: unknown })?.code === 32) {
        return { outcome: 'not-found', detail: 'no such object' };
      }
      throw err;
    }
    return { outcome: 'done', detail: enabled ? 'enabled' : 'disabled' };
  }

  // ── Credential state (read only, no password reset) ─────────────────

  async getCredentialState(config: AdConfig, externalId: string): Promise<CredentialState> {
    const resolved = this.resolveAdConfig(config);
    if (!resolved) throw new ConnectorException('AD config missing for getCredentialState');
    const raw = await this.client.getCredentialState(resolved, externalId);
    const pwdLastSet = raw.pwdLastSet ? this.fileTimeToDate(raw.pwdLastSet) : undefined;
    const uac = raw.userAccountControl ? parseInt(raw.userAccountControl, 10) : 0;
    return {
      passwordLastSet: pwdLastSet,
      passwordNeverExpires: (uac & 0x10000) !== 0, // DONT_EXPIRE_PASSWD
      accountEnabled: (uac & UAC_ACCOUNTDISABLE) === 0,
    };
  }

  /** Convert Windows FILETIME (100ns since 1601-01-01) to JS Date. */
  private fileTimeToDate(filetime: string): Date {
    const ft = BigInt(filetime);
    const epochDiff = BigInt('116444736000000000'); // 100ns between 1601 and 1970
    const ms = Number((ft - epochDiff) / BigInt(10000));
    return new Date(ms);
  }

  /**
   * Get user by email or UPN (for reconciliation fetchUserFromSystem).
   */
  async getUserByEmail(config: AdConfig, email: string): Promise<TargetAccount | null> {
    const resolved = this.resolveAdConfig(config);
    if (!resolved) return null;
    const baseDn =
      resolved.userSearchBase?.trim() ||
      resolved.rootBaseDn?.trim() ||
      resolved.baseDn?.trim() ||
      '';
    if (!baseDn) return null;
    const escaped = escapeLdapFilter(email);
    const filter = `(|(mail=${escaped})(userPrincipalName=${escaped}))`;
    const users = await this.client.searchUsers(resolved, baseDn, filter);
    const e = users[0];
    if (!e) return null;
    const accountEnabled = isUacEnabled(e.userAccountControl);
    return {
      id: e.dn,
      userPrincipalName: e.userPrincipalName ?? e.mail ?? e.dn,
      mail: e.mail,
      displayName: undefined,
      accountEnabled,
    };
  }

  // ── Group membership (access review revocation) ──────────────────────

  /** Direct group DNs of the user at `userDn`; null when no entry has that DN. */
  async getUserGroupDns(config: AdConfig, userDn: string): Promise<string[] | null> {
    const resolved = this.resolveAdConfig(config);
    if (!resolved) throw new ConnectorException('AD config invalid: missing host or base DN');
    return this.client.getMemberOf(resolved, userDn);
  }

  /** Remove the user from the group; `not-member` when the group did not hold the user. */
  async removeGroupMember(
    config: AdConfig,
    userDn: string,
    groupDn: string,
  ): Promise<'removed' | 'not-member'> {
    const resolved = this.resolveAdConfig(config);
    if (!resolved) throw new ConnectorException('AD config invalid: missing host or base DN');
    return this.client.removeGroupMember(resolved, userDn, groupDn);
  }
}
