import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  HttpStatus,
} from '@nestjs/common';
import { ConnectorException } from '@shared/exceptions/domain-exceptions';
import { ConfigService } from '@nestjs/config';
import type { ProvisioningOperationResult } from '@shared/dtos/provisioning-result.dto';
import { EntraClient } from './entra.client';
import { followGraphPages, type GraphPage } from './entra-graph-pages';
import { EntraConfig, ProvisioningIntent } from './entra.interface';
import { SKU_CACHE_TTL_MS } from '@infrastructure/config/defaults';
import { GUID_REGEX, MAX_GROUP_NAME_LENGTH, escapeODataStringLiteral } from './entra.constants';
import { changeResult, failedChange } from './entra-change-result';
import type { GraphSku, GraphRoleAssignment } from './entra.types';
import { maskEmails } from '../../../activities/deprovision-failure';

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const skuNotFound = (skuName: string) =>
  new ConnectorException(`License SKU "${skuName}" not found`);

/**
 * Entra ID entitlement management: groups, directory roles, licenses, and user state operations.
 * Dumb pipe: executes explicit add/remove operations. No governance filtering — that's the Brain's job.
 * The sync methods report each operation (entra-change-result.ts) and never throw for one.
 */
@Injectable()
export class EntraEntitlementsService {
  private readonly logger = new Logger(EntraEntitlementsService.name);
  /** SKU part number -> skuId, per config (`EntraClient.credentialScope`), never shared. */
  private readonly skuCache = new Map<string, { map: Map<string, string>; expiresAt: number }>();

  constructor(
    private readonly client: EntraClient,
    private readonly config: ConfigService,
  ) {}

  // --- Group Operations ---

  /**
   * The group's object id: a GUID as it is, a display name looked up in Graph. Null when no group
   * has the name (or it is longer than Entra allows); a failed lookup propagates. Display names
   * are not unique in Entra ID: a name two or more groups have fails (422), since taking one of
   * them could grant the wrong group.
   */
  async resolveGroupId(nameOrId: string, config?: EntraConfig): Promise<string | null> {
    if (!nameOrId) return null;
    const trimmed = String(nameOrId).trim();
    if (GUID_REGEX.test(trimmed)) {
      return trimmed;
    }
    if (trimmed.length > MAX_GROUP_NAME_LENGTH) {
      this.logger.warn(`[GROUP SYNC] Group name exceeds ${MAX_GROUP_NAME_LENGTH} chars, rejecting`);
      return null;
    }
    const escaped = escapeODataStringLiteral(trimmed);
    const filterValue = `displayName eq '${escaped}'`;
    const response = await this.client.get<{ value: Array<{ id: string }> }>(
      `/groups?$filter=${encodeURIComponent(filterValue)}&$select=id`,
      config,
    );
    const groups = response.value ?? [];
    if (groups.length > 1) {
      throw new ConnectorException(
        `More than one Entra ID group has the display name "${trimmed}": name the group by its ` +
          'object id in the policy',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    return groups[0]?.id ?? null;
  }

  /** The user's direct memberships, every page (listUserMemberships); none for a 404. */
  async getUserGroupMemberships(
    userId: string,
    config?: EntraConfig,
  ): Promise<Array<{ id: string; displayName?: string }>> {
    const memberships = await this.listUserMemberships(userId, config);
    return memberships.map(({ id, displayName }) => ({ id, displayName }));
  }

  async getUserGroups(userId: string, config?: EntraConfig): Promise<string[]> {
    const memberships = await this.getUserGroupMemberships(userId, config);
    return memberships.map((g) => g.id);
  }

  /**
   * Execute explicit group operations (add/remove, by group id or display name) and report each:
   * applied, unchanged (already a member, or not one), or failed with the reason (Graph refused
   * it or could not be asked, or no group has the name). Every operation is attempted. Dumb pipe:
   * no delta calculation, no governance filtering; the caller decides which groups to add/remove
   * and what a failed one means.
   */
  async syncGroupMemberships(
    userId: string,
    groupOps: ProvisioningIntent['operations'],
    config?: EntraConfig,
  ): Promise<ProvisioningOperationResult[]> {
    this.logger.log(
      `[GROUP SYNC] Executing ${groupOps.length} group operations for user ${userId}`,
    );
    const results: ProvisioningOperationResult[] = [];
    for (const op of groupOps) {
      try {
        const groupId = await this.resolveGroupId(op.targetId, config);
        if (!groupId) {
          throw new ConnectorException(
            `No Entra ID group has the id or display name "${op.targetId}"`,
            HttpStatus.UNPROCESSABLE_ENTITY,
          );
        }
        const changed =
          op.action === 'remove'
            ? (await this.removeGroupMember(userId, groupId, config)) === 'removed'
            : (await this.addGroupMember(userId, groupId, config)) === 'added';
        results.push(changeResult(op, changed ? 'applied' : 'unchanged'));
      } catch (e: unknown) {
        this.logger.error(
          `[GROUP SYNC] Failed ${op.action} on group ${op.targetId}: ${messageOf(e)}`,
        );
        results.push(failedChange(op, e));
      }
    }
    return results;
  }

  async addToGroup(objectId: string, groupId: string, config?: EntraConfig): Promise<boolean> {
    await this.addGroupMember(objectId, groupId, config);
    return true;
  }

  /**
   * Add a user to a group, saying whether Graph added a membership. `already-member` is Graph's
   * 400 "One or more added object references already exist".
   */
  async addGroupMember(
    objectId: string,
    groupId: string,
    config?: EntraConfig,
  ): Promise<'added' | 'already-member'> {
    try {
      await this.client.post(
        `/groups/${groupId}/members/$ref`,
        { '@odata.id': `https://graph.microsoft.com/v1.0/directoryObjects/${objectId}` },
        config,
      );
      return 'added';
    } catch (e: unknown) {
      const msg = messageOf(e);
      if (
        msg.includes('already exist') ||
        msg.includes('One or more added object references already exist')
      ) {
        return 'already-member';
      }
      throw e;
    }
  }

  async removeFromGroup(objectId: string, groupId: string, config?: EntraConfig): Promise<boolean> {
    try {
      await this.client.delete(`/groups/${groupId}/members/${objectId}/$ref`, config);
      return true;
    } catch (e: unknown) {
      if (e instanceof NotFoundException) {
        this.logger.warn(`User ${objectId} was not a member of group ${groupId}`);
        return true;
      }
      throw e;
    }
  }

  /**
   * The user's direct memberships, every page: groups, directory roles and administrative
   * units. `odataType` is Graph's `@odata.type` (e.g. `#microsoft.graph.group`), so a caller can
   * tell a group from a directory role. A user Graph does not know (404) has none.
   */
  async listUserMemberships(
    userId: string,
    config?: EntraConfig,
  ): Promise<Array<{ id: string; displayName?: string; odataType?: string }>> {
    type Membership = { id: string; displayName?: string; '@odata.type'?: string };
    let first: GraphPage<Membership>;
    try {
      first = await this.client.get<GraphPage<Membership>>(
        `/users/${encodeURIComponent(userId)}/memberOf?$select=id,displayName`,
        config,
      );
    } catch (e: unknown) {
      if (e instanceof NotFoundException) return [];
      throw e;
    }
    const entries = await followGraphPages(this.client, first, config);
    return entries.map((m) => ({
      id: m.id,
      displayName: m.displayName,
      odataType: m['@odata.type'],
    }));
  }

  /**
   * Remove a user from a group, saying whether Graph removed a membership. `not-member` is
   * Graph's 404: no such membership, group or user, so the membership does not exist.
   * (removeFromGroup answers true for both.)
   */
  async removeGroupMember(
    objectId: string,
    groupId: string,
    config?: EntraConfig,
  ): Promise<'removed' | 'not-member'> {
    try {
      await this.client.delete(
        `/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(objectId)}/$ref`,
        config,
      );
      return 'removed';
    } catch (e: unknown) {
      if (e instanceof NotFoundException) return 'not-member';
      throw e;
    }
  }

  // --- Directory Role Operations ---

  /**
   * Execute explicit directory role operations (add/remove, by role definition id) and report
   * each: applied, unchanged (already assigned, or no assignment to remove), or failed with the
   * reason. Every operation is attempted. Dumb pipe: no delta calculation, no governance
   * filtering; the caller decides which roles to add/remove and what a failed one means.
   */
  async syncDirectoryRoles(
    userId: string,
    roleOps: ProvisioningIntent['operations'],
    config?: EntraConfig,
  ): Promise<ProvisioningOperationResult[]> {
    this.logger.log(`[ROLE SYNC] Executing ${roleOps.length} role operations for user ${userId}`);
    const results: ProvisioningOperationResult[] = [];
    for (const op of roleOps) {
      try {
        const changed =
          op.action === 'remove'
            ? await this.unassignDirectoryRole(userId, op.targetId, config)
            : (await this.assignDirectoryRole(userId, op.targetId, config)) !== '';
        results.push(changeResult(op, changed ? 'applied' : 'unchanged'));
      } catch (e: unknown) {
        this.logger.error(
          `[ROLE SYNC] Failed ${op.action} on role ${op.targetId}: ${messageOf(e)}`,
        );
        results.push(failedChange(op, e));
      }
    }
    return results;
  }

  /** Remove the user's assignment of the role; false when it has none (or it was already gone). */
  private async unassignDirectoryRole(
    userId: string,
    roleDefinitionId: string,
    config?: EntraConfig,
  ): Promise<boolean> {
    // The assignment id, by principalId and roleDefinitionId
    const filter = `principalId eq '${userId}' and roleDefinitionId eq '${roleDefinitionId}'`;
    const res = await this.client.get<{ value: GraphRoleAssignment[] }>(
      `/roleManagement/directory/roleAssignments?$filter=${encodeURIComponent(filter)}`,
      config,
    );
    const assignment = res.value?.[0];
    return assignment ? this.removeDirectoryRole(assignment.id, config) : false;
  }

  async assignDirectoryRole(
    userId: string,
    roleDefinitionId: string,
    config?: EntraConfig,
  ): Promise<string> {
    try {
      const res = await this.client.post<GraphRoleAssignment>(
        '/roleManagement/directory/roleAssignments',
        {
          principalId: userId,
          roleDefinitionId,
          directoryScopeId: '/',
        },
        config,
      );
      return res.id;
    } catch (e: unknown) {
      if (e instanceof ConflictException) {
        this.logger.warn(`[ROLE SYNC] Role ${roleDefinitionId} already assigned to user ${userId}`);
        return '';
      }
      throw e;
    }
  }

  /** Delete a role assignment; false when Graph no longer has it (404, already removed). */
  async removeDirectoryRole(assignmentId: string, config?: EntraConfig): Promise<boolean> {
    try {
      await this.client.delete(`/roleManagement/directory/roleAssignments/${assignmentId}`, config);
      return true;
    } catch (e: unknown) {
      if (e instanceof NotFoundException) {
        this.logger.warn(`[ROLE SYNC] Role assignment ${assignmentId} already removed`);
        return false;
      }
      throw e;
    }
  }

  // --- License Operations ---

  /**
   * Execute explicit license operations (add/remove, by SKU part number) and report each: applied,
   * unchanged (the user already has the license, or does not; a removal of a SKU the tenant does
   * not have, which no user can hold), or failed with the reason (adding a SKU the tenant does
   * not have, or Graph refused the assignment, e.g. a license the user gets through a group). The user's licenses are read once; each change is its own assignLicense
   * call (addLicenses or removeLicenses), so one refusal leaves the others made.
   */
  async syncLicenses(
    userId: string,
    licenseOps: ProvisioningIntent['operations'],
    config?: EntraConfig,
  ): Promise<ProvisioningOperationResult[]> {
    let assigned: Set<string>;
    try {
      assigned = await this.assignedSkuIds(userId, config);
    } catch (e: unknown) {
      this.logger.error(
        `[LICENSE SYNC] Could not read the licenses of user ${userId}: ${messageOf(e)}`,
      );
      return licenseOps.map((op) => failedChange(op, e));
    }
    const results: ProvisioningOperationResult[] = [];
    for (const op of licenseOps) {
      try {
        const add = op.action !== 'remove';
        const skuId = await this.findSkuId(op.targetId, config);
        if (!skuId && !add) {
          // A user cannot hold a license of a SKU the tenant does not have: nothing to remove
          results.push(changeResult(op, 'unchanged'));
          continue;
        }
        if (!skuId) throw skuNotFound(op.targetId);
        if (assigned.has(skuId.toLowerCase()) === add) {
          results.push(changeResult(op, 'unchanged'));
          continue;
        }
        await this.client.post(
          `/users/${encodeURIComponent(userId)}/assignLicense`,
          add
            ? { addLicenses: [{ skuId, disabledPlans: [] }], removeLicenses: [] }
            : { addLicenses: [], removeLicenses: [skuId] },
          config,
        );
        if (add) assigned.add(skuId.toLowerCase());
        else assigned.delete(skuId.toLowerCase());
        results.push(changeResult(op, 'applied'));
      } catch (e: unknown) {
        this.logger.error(
          `[LICENSE SYNC] Failed ${op.action} of license ${op.targetId}: ${messageOf(e)}`,
        );
        results.push(failedChange(op, e));
      }
    }
    return results;
  }

  /** The skuIds (lowercase) of the user's assigned licenses (Graph user.assignedLicenses). */
  private async assignedSkuIds(userId: string, config?: EntraConfig): Promise<Set<string>> {
    const user = await this.client.get<{ assignedLicenses?: Array<{ skuId?: string }> }>(
      `/users/${encodeURIComponent(userId)}?$select=assignedLicenses`,
      config,
    );
    return new Set(
      (user.assignedLicenses ?? [])
        .map((license) => license.skuId?.toLowerCase())
        .filter((skuId): skuId is string => !!skuId),
    );
  }

  private async resolveSkuId(skuName: string, config?: EntraConfig): Promise<string> {
    const id = await this.findSkuId(skuName, config);
    if (!id) throw skuNotFound(skuName);
    return id;
  }

  /** The skuId of the tenant's SKU with this part number, or undefined when it has none. */
  private async findSkuId(skuName: string, config?: EntraConfig): Promise<string | undefined> {
    const now = Date.now();
    const scope = this.client.credentialScope(config);
    let skus = this.skuCache.get(scope);
    if (!skus || skus.expiresAt < now) {
      const allSkus = await this.client.get<{ value: GraphSku[] }>('/subscribedSkus', config);
      const map = new Map<string, string>(
        allSkus.value
          .filter(
            (s: GraphSku): s is GraphSku & { skuPartNumber: string; skuId: string } =>
              !!(s.skuPartNumber && s.skuId),
          )
          .map((s) => [s.skuPartNumber, s.skuId] as [string, string]),
      );
      skus = { map, expiresAt: now + SKU_CACHE_TTL_MS };
      this.skuCache.set(scope, skus);
    }
    return skus.map.get(skuName);
  }

  async assignLicense(objectId: string, skuName: string, config?: EntraConfig): Promise<boolean> {
    const skuId = await this.resolveSkuId(skuName, config);
    await this.client.post(
      `/users/${objectId}/assignLicense`,
      { addLicenses: [{ skuId, disabledPlans: [] }], removeLicenses: [] },
      config,
    );
    return true;
  }

  // --- User State Operations ---

  async disableUser(objectId: string, config?: EntraConfig): Promise<boolean> {
    await this.client.patch(`/users/${objectId}`, { accountEnabled: false }, config);
    return true;
  }

  async enableUser(objectId: string, config?: EntraConfig): Promise<boolean> {
    await this.client.patch(`/users/${objectId}`, { accountEnabled: true }, config);
    return true;
  }

  async patchUser(
    objectId: string,
    patch: { accountEnabled?: boolean },
    config?: EntraConfig,
  ): Promise<void> {
    await this.client.patch(`/users/${objectId}`, patch, config);
  }

  async deleteUser(upn: string, config?: EntraConfig): Promise<boolean> {
    try {
      await this.client.delete(`/users/${encodeURIComponent(upn)}`, config);
      this.logger.log(`Deleted user ${maskEmails(upn)}`);
      return true;
    } catch (e: unknown) {
      if (e instanceof NotFoundException) {
        this.logger.warn(`User ${maskEmails(upn)} not found — nothing to delete`);
        return false;
      }
      throw e;
    }
  }
}
