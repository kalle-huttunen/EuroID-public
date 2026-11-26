import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConnectorException } from '@shared/exceptions/domain-exceptions';
import { ISCIMConnector, SCIMConnectorConfig, SCIMHealthStatus } from './scim.interface';
import type { ConnectorCapability } from '../plugin/connector-manifest.interface';
import { SCIMClient } from './scim.client';
import { SCIMMapper } from './scim.mapper';
import { StandardUserDto } from '@shared/dtos/standard-user.dto';
import { ProvisioningResult } from '@shared/dtos/provisioning-result.dto';
import { Entitlement, TargetAccount } from '@shared/interfaces/provisioning.interface';
import { SCIMUser, SCIMPatchOp, SCIMError, type SCIMListResponse } from '@shared/scim';
import { SCIM_SCHEMAS } from '@shared/scim';
import type { DeprovisionResult } from '@shared/types/deprovision';
import type { PamAccountResult } from '@shared/types/pam-session';
import { maskEmail, maskLogin } from '../../identity/identity-pii';

const SCIM_SYSTEM = 'scim';
/** Resources asked for per page of a SCIM list; a server may return fewer. */
const SCIM_PAGE_SIZE = 100;

/**
 * Orchestrator for SCIM outbound operations.
 *
 * Follows the 5-file connector pattern:
 *   Mapper (pure logic) → Client (HTTP) → Service (orchestration)
 *
 * Key behaviours:
 * - Idempotent provision: looks up by userName before creating
 * - Deactivation vs deletion: configurable via deprovisionStrategy
 * - Discovery: lists SCIM Groups as entitlements
 */
@Injectable()
export class SCIMService implements ISCIMConnector {
  private readonly logger = new Logger(SCIMService.name);

  constructor(
    private readonly client: SCIMClient,
    private readonly mapper: SCIMMapper,
  ) {}

  /**
   * Provision a user to a SCIM-compliant target system (idempotent).
   *
   * 1. Map StandardUserDto → SCIMUser
   * 2. Check if user already exists (filter: userName eq "...")
   * 3. If exists → PUT update. If not → POST create.
   */
  async provision(config: SCIMConnectorConfig, user: StandardUserDto): Promise<ProvisioningResult> {
    const scimUser = this.mapper.toSCIMUser(user);
    const userName = scimUser.userName;
    // Usually the email, else a login: masked in the logs either way
    const who = userName.includes('@') ? maskEmail(userName) : maskLogin(userName);

    this.logger.log(`[PROVISION] Starting for ${who} at ${config.baseUrl}`);

    // Idempotency: check if user already exists by userName
    const existing = await this.findUserByUserName(config, userName);

    let result: SCIMUser;

    if (existing) {
      // User exists → update
      this.logger.log(`[PROVISION] User ${who} already exists (${existing.id}) — updating`);
      result = await this.client.updateUser(config, existing.id ?? userName, scimUser);
      this.logger.log(`[PROVISION] Updated user ${who}`);
    } else {
      // User does not exist → create
      this.logger.log(`[PROVISION] User ${who} not found — creating`);
      result = await this.client.createUser(config, scimUser);
      this.logger.log(`[PROVISION] Created user ${who} with ID ${result.id}`);
    }

    return {
      targetUserId: result.id || existing?.id || userName,
    };
  }

  /**
   * Deprovision a user from a SCIM target system.
   *
   * Strategy depends on config.deprovisionStrategy:
   *   - 'deactivate' (default): PATCH to set active=false
   *   - 'delete': DELETE the user resource
   */
  async deprovision(config: SCIMConnectorConfig, externalId: string): Promise<void> {
    const strategy = config.deprovisionStrategy || 'deactivate';
    this.logger.log(`[DEPROVISION] ${strategy} user ${externalId} at ${config.baseUrl}`);

    if (strategy === 'delete') {
      await this.client.deleteUser(config, externalId);
      this.logger.log(`[DEPROVISION] Deleted user ${externalId}`);
    } else {
      // Deactivate: PATCH to set active=false
      const patchOp: SCIMPatchOp = {
        schemas: [SCIM_SCHEMAS.PATCH_OP],
        Operations: [{ op: 'replace', path: 'active', value: false }],
      };
      await this.client.patchUser(config, externalId, patchOp);
      this.logger.log(`[DEPROVISION] Deactivated user ${externalId}`);
    }
  }

  /**
   * Offboarding deprovision with idempotent outcomes. Uses the stored SCIM id: a 404 there means
   * already gone. Without one (accounts provisioned before the id was written back) the user is
   * looked up by every identifier provisioning used: `userName eq` each of `userNames` (the UPN,
   * else the email), then `emails.value eq` each of `emails`. A returned resource counts only
   * when it carries the filtered value (a server that ignores the filter returns other users).
   * No match is a failure an admin must check (422, not retried), never "already gone": the
   * account may live on under another name. Lookup errors propagate.
   */
  async deprovisionUser(
    config: SCIMConnectorConfig,
    user: { id?: string; userNames?: string[]; emails?: string[] },
  ): Promise<DeprovisionResult> {
    const id = user.id ?? (await this.findDeprovisionTarget(config, user));
    if (!id) {
      throw new ConnectorException(
        'No SCIM user has the userName or email EuroID provisioned with, and no SCIM id is ' +
          'stored: the account may exist under another name. Check the target, remove the ' +
          'account there and mark it removed manually.',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    try {
      await this.deprovision(config, id);
    } catch (e: unknown) {
      if (e instanceof SCIMError && e.getStatus() === 404) {
        return { outcome: 'already-gone', detail: 'no such user' };
      }
      throw e;
    }
    const deleted = config.deprovisionStrategy === 'delete';
    return { outcome: 'deprovisioned', detail: deleted ? 'deleted' : 'deactivated' };
  }

  /**
   * A privileged session: set the user's `active` through the SCIM patch path (PATCH replace
   * active), by the stored SCIM id, else looked up as deprovisionUser does (userName, then
   * emails). No such user (404 on the id, or no match) is not-found; other errors propagate.
   */
  async setActive(
    config: SCIMConnectorConfig,
    user: { id?: string; userNames?: string[]; emails?: string[] },
    active: boolean,
  ): Promise<PamAccountResult> {
    const id = user.id ?? (await this.findDeprovisionTarget(config, user));
    if (!id) return { outcome: 'not-found', detail: 'no such user' };
    const patchOp: SCIMPatchOp = {
      schemas: [SCIM_SCHEMAS.PATCH_OP],
      Operations: [{ op: 'replace', path: 'active', value: active }],
    };
    try {
      await this.client.patchUser(config, id, patchOp);
    } catch (e: unknown) {
      if (e instanceof SCIMError && e.getStatus() === 404) {
        return { outcome: 'not-found', detail: 'no such user' };
      }
      throw e;
    }
    return { outcome: 'done', detail: active ? 'activated' : 'deactivated' };
  }

  /**
   * Delete the user resource (DELETE /Users/{id}), whatever deprovisionStrategy says: an orphan
   * delete removes the account. By the stored SCIM id, else looked up as deprovisionUser does
   * (userName, then emails). No match is not-found, a 404 on the delete already-gone; other
   * errors propagate.
   */
  async deleteUser(
    config: SCIMConnectorConfig,
    user: { id?: string; userNames?: string[]; emails?: string[] },
  ): Promise<{ outcome: 'done' | 'already-gone' | 'not-found' }> {
    const id = user.id ?? (await this.findDeprovisionTarget(config, user));
    if (!id) return { outcome: 'not-found' };
    try {
      await this.client.deleteUser(config, id);
    } catch (e: unknown) {
      if (e instanceof SCIMError && e.getStatus() === 404) return { outcome: 'already-gone' };
      throw e;
    }
    return { outcome: 'done' };
  }

  /**
   * Discover entitlements (SCIM Groups) from the target system.
   * Returns groups formatted as Entitlement objects for the catalog.
   */
  async discover(config: SCIMConnectorConfig): Promise<Entitlement[]> {
    this.logger.log(`[DISCOVER] Listing groups from ${config.baseUrl}`);

    const groups = await this.everyPage((startIndex, count) =>
      this.client.listGroups(config, undefined, startIndex, count),
    );

    const entitlements: Entitlement[] = groups.map((g) => ({
      nativeId: g.id || g.displayName,
      name: g.displayName,
      type: 'Group' as const,
      system: SCIM_SYSTEM,
      origin: 'EXTERNAL' as const,
      governanceLevel: 'OPEN' as const,
    }));

    this.logger.log(`[DISCOVER] Found ${entitlements.length} groups`);
    return entitlements;
  }

  /**
   * Validate capabilities from ServiceProviderConfig (filter, patch, bulk).
   * On error, returns static capabilities.
   */
  async validateCapabilities(config?: unknown): Promise<ConnectorCapability[]> {
    const staticCaps: ConnectorCapability[] = [
      'discover',
      'provision',
      'deprovision',
      'healthCheck',
    ];
    try {
      const cfg = this.coerceConfig(config);
      if (!cfg) return staticCaps;
      const spc = await this.client.getServiceProviderConfig(cfg);
      const caps: ConnectorCapability[] = ['healthCheck'];
      const filterSupported = (spc.filter as { supported?: boolean })?.supported !== false;
      if (filterSupported) caps.push('discover');
      caps.push('provision', 'deprovision');
      return caps;
    } catch {
      return staticCaps;
    }
  }

  private coerceConfig(config?: unknown): SCIMConnectorConfig | null {
    if (!config || typeof config !== 'object') return null;
    const c = config as Record<string, unknown>;
    if (!c.baseUrl || typeof c.baseUrl !== 'string') return null;
    return {
      baseUrl: c.baseUrl,
      authType: (c.authType as SCIMConnectorConfig['authType']) || 'bearer',
      bearerToken: c.bearerToken as string | undefined,
      username: c.username as string | undefined,
      password: c.password as string | undefined,
      oauth2TokenUrl: c.oauth2TokenUrl as string | undefined,
      clientId: c.clientId as string | undefined,
      clientSecret: c.clientSecret as string | undefined,
      deprovisionStrategy: c.deprovisionStrategy as SCIMConnectorConfig['deprovisionStrategy'],
    };
  }

  /**
   * Health check: GET /ServiceProviderConfig
   */
  async healthCheck(config: SCIMConnectorConfig): Promise<SCIMHealthStatus> {
    this.logger.log(`[HEALTH] Checking ${config.baseUrl}`);

    try {
      const healthy = await this.client.healthCheck(config);
      return { healthy };
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.warn(`[HEALTH] Check failed: ${message}`);
      return { healthy: false, error: message };
    }
  }

  /**
   * Get user by userName (typically email) for reconciliation fetchUserFromSystem.
   */
  async getUserByEmail(config: SCIMConnectorConfig, email: string): Promise<TargetAccount | null> {
    const u = await this.findUserByUserName(config, email);
    if (!u) return null;
    return {
      id: u.id ?? '',
      userPrincipalName: u.userName ?? u.emails?.[0]?.value ?? u.id ?? '',
      mail: u.emails?.[0]?.value ?? u.userName,
      displayName: u.displayName,
      accountEnabled: u.active !== false,
    };
  }

  /**
   * List all users from SCIM target (for orphan detection / reconciliation).
   * Paginates through results and maps to TargetAccount shape.
   */
  async listUsers(config: SCIMConnectorConfig): Promise<TargetAccount[]> {
    const users = await this.everyPage((startIndex, count) =>
      this.client.listUsers(config, undefined, startIndex, count),
    );
    return users.map((u) => ({
      id: u.id ?? '',
      userPrincipalName: u.userName ?? u.emails?.[0]?.value ?? u.id ?? '',
      mail: u.emails?.[0]?.value ?? u.userName,
      displayName: u.displayName,
      accountEnabled: u.active !== false,
    }));
  }

  /**
   * Every resource of a SCIM list, page by page (RFC 7644 section 3.4.2.4): the next page starts
   * after the resources the server returned, which may be fewer than asked for (servers cap
   * `count`). It ends with an empty page, at `totalResults`, or, from a server that reports no
   * total, with a page shorter than asked for.
   */
  private async everyPage<T>(
    fetchPage: (startIndex: number, count: number) => Promise<SCIMListResponse<T>>,
  ): Promise<T[]> {
    const all: T[] = [];
    let startIndex = 1;
    for (;;) {
      const response = await fetchPage(startIndex, SCIM_PAGE_SIZE);
      const resources = response?.Resources ?? [];
      all.push(...resources);
      startIndex += resources.length;
      const total = response?.totalResults;
      if (resources.length === 0) return all;
      if (total != null ? startIndex > total : resources.length < SCIM_PAGE_SIZE) return all;
    }
  }

  // --- Group membership (access review revocation, mover) ---

  /**
   * The id of the user whose `userName` is one of `userNames`, else whose `emails.value` is one
   * of `emails`; a returned user counts only when it carries the value (a server that ignores
   * the filter returns others). Null when none matches.
   */
  async findUserIdByIdentifiers(
    config: SCIMConnectorConfig,
    user: { userNames?: string[]; emails?: string[] },
  ): Promise<string | null> {
    const same = (a: string | undefined, b: string) => a?.toLowerCase() === b.toLowerCase();
    const lookups = [
      ...unique(user.userNames).map((value) => ({
        filter: `userName eq "${escapeFilterValue(value)}"`,
        matches: (u: SCIMUser) => same(u.userName, value),
      })),
      ...unique(user.emails).map((value) => ({
        filter: `emails.value eq "${escapeFilterValue(value)}"`,
        matches: (u: SCIMUser) => (u.emails ?? []).some((e) => same(e.value, value)),
      })),
    ];
    for (const { filter, matches } of lookups) {
      const found = (await this.client.listUsers(config, filter, 1, 1))?.Resources?.[0];
      if (found?.id && matches(found)) return found.id;
    }
    return null;
  }

  /**
   * The user's group memberships from its `groups` attribute (RFC 7643 §4.1.2, read-only):
   * `null` when the target has no such user (404), `undefined` when the target does not return
   * the attribute (membership then cannot be read from the user).
   */
  async getUserGroups(
    config: SCIMConnectorConfig,
    userId: string,
  ): Promise<SCIMUserGroup[] | null | undefined> {
    let user: SCIMUser & { groups?: SCIMUserGroup[] };
    try {
      user = await this.client.getUser(config, userId);
    } catch (e: unknown) {
      if (e instanceof SCIMError && e.getStatus() === 404) return null;
      throw e;
    }
    if (!Array.isArray(user?.groups)) return undefined;
    return user.groups.filter((g) => typeof g?.value === 'string');
  }

  /**
   * Remove the user from the group: PATCH /Groups/{id} with
   * `remove members[value eq "<userId>"]` (RFC 7644 §3.5.2.2). `not-member` when the target
   * answers 404 for the group or `noTarget` (the filter matched no member).
   */
  async removeGroupMember(
    config: SCIMConnectorConfig,
    groupId: string,
    userId: string,
  ): Promise<'removed' | 'not-member'> {
    const patch: SCIMPatchOp = {
      schemas: [SCIM_SCHEMAS.PATCH_OP],
      Operations: [{ op: 'remove', path: `members[value eq "${escapeFilterValue(userId)}"]` }],
    };
    try {
      await this.client.patchGroup(config, groupId, patch);
      return 'removed';
    } catch (e: unknown) {
      if (e instanceof SCIMError && (e.getStatus() === 404 || e.scimType === 'noTarget')) {
        return 'not-member';
      }
      throw e;
    }
  }

  /**
   * Add the user to the group (mover): PATCH /Groups/{id} with `add members` and the user's id
   * as value (RFC 7644 §3.5.2.1). `already-member` when the target answers 409 (uniqueness):
   * RFC 7644 lets an add of an existing value change nothing, some servers refuse it instead.
   * A missing group (404) and other errors propagate.
   */
  async addGroupMember(
    config: SCIMConnectorConfig,
    groupId: string,
    userId: string,
  ): Promise<'added' | 'already-member'> {
    const patch: SCIMPatchOp = {
      schemas: [SCIM_SCHEMAS.PATCH_OP],
      Operations: [{ op: 'add', path: 'members', value: [{ value: userId }] }],
    };
    try {
      await this.client.patchGroup(config, groupId, patch);
      return 'added';
    } catch (e: unknown) {
      if (e instanceof SCIMError && e.getStatus() === 409) return 'already-member';
      throw e;
    }
  }

  // --- Private Helpers ---

  /** The id of the user whose userName or email is one of the given values, if any. */
  private async findDeprovisionTarget(
    config: SCIMConnectorConfig,
    user: { userNames?: string[]; emails?: string[] },
  ): Promise<string | undefined> {
    const same = (a: string | undefined, b: string) => a?.toLowerCase() === b.toLowerCase();
    const lookups = [
      ...unique(user.userNames).map((value) => ({
        filter: `userName eq "${escapeFilterValue(value)}"`,
        matches: (u: SCIMUser) => same(u.userName, value),
      })),
      ...unique(user.emails).map((value) => ({
        filter: `emails.value eq "${escapeFilterValue(value)}"`,
        matches: (u: SCIMUser) => (u.emails ?? []).some((e) => same(e.value, value)),
      })),
    ];
    for (const { filter, matches } of lookups) {
      const found = (await this.client.listUsers(config, filter, 1, 1))?.Resources?.[0];
      if (found?.id && matches(found)) return found.id;
      if (found) this.logger.warn(`[DEPROVISION] Ignoring a user that does not match the filter`);
    }
    return undefined;
  }

  /**
   * The user whose userName is `userName` (SCIM filter: userName eq "value"), compared without
   * case; null when the server returns none. A returned user with another userName is not it (a
   * server that ignores the filter returns others). A failed lookup throws: taken for "no such
   * user", it would create a duplicate account, or tell reconciliation the account is missing.
   */
  private async findUserByUserName(
    config: SCIMConnectorConfig,
    userName: string,
  ): Promise<SCIMUser | null> {
    const response = await this.client.listUsers(
      config,
      `userName eq "${escapeFilterValue(userName)}"`,
      1,
      1,
    );
    const found = response?.Resources?.[0];
    if (!found) return null;
    if (found.userName?.toLowerCase() === userName.toLowerCase()) return found;
    this.logger.warn('[PROVISION] Ignoring a user that does not match the userName filter');
    return null;
  }
}

/** One entry of a SCIM user's `groups` attribute. `type` is "direct" or "indirect" (nested). */
export interface SCIMUserGroup {
  value: string;
  display?: string;
  type?: string;
}

/** Non-empty values, each once (case-insensitive), in order. */
function unique(values: Array<string | undefined> | undefined): string[] {
  const seen = new Set<string>();
  return (values ?? []).filter((v): v is string => {
    if (!v || seen.has(v.toLowerCase())) return false;
    seen.add(v.toLowerCase());
    return true;
  });
}

/** A SCIM filter string literal: backslash and double quote escaped. */
function escapeFilterValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// ── TASK 107 RECAP ──
// Added: validateCapabilities() — fetches ServiceProviderConfig, returns healthCheck/discover/provision/deprovision.
// coerceConfig() helper for raw config → SCIMConnectorConfig. Falls back to static on error.
