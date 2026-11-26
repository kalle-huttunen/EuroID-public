/**
 * OktaProvisioningService — User lifecycle operations.
 *
 * Handles user creation (with 409 idempotency), updates, deprovisioning, intent operations
 * (assign_group, assign_app) and group membership. No credential operations: it resets no
 * password and reads no credential state or MFA factors.
 *
 * Dumb pipe: no business logic.
 */

import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConnectorException } from '@shared/exceptions/domain-exceptions';
import { OktaClient } from './okta.client';
import { OktaMapper } from './okta.mapper';
import { OktaConfig, OktaGroup, OktaProvisioningIntent, OktaUser } from './okta.interface';
import { StandardUserDto } from '@shared/dtos/standard-user.dto';
import { ProvisioningResult } from '@shared/dtos/provisioning-result.dto';
import type { DeprovisionResult } from '@shared/types/deprovision';
import { maskEmail } from '../../identity/identity-pii';
import type { PamAccountResult, PamAccountStatus } from '@shared/types/pam-session';
import { isLinkedAdminProfile } from '@shared/utils/linked-admin-profile';

/** Okta's error body (developer.okta.com, Error codes). */
interface OktaErrorBody {
  errorCode?: string;
  errorCauses?: Array<{ errorSummary?: string }>;
}

/** Okta statuses of a user who can sign in, or whose owner can finish activation or recovery. */
const OKTA_SIGN_IN_STATUSES: readonly string[] = [
  'ACTIVE',
  'PROVISIONED',
  'RECOVERY',
  'PASSWORD_EXPIRED',
  'LOCKED_OUT',
];
/** Okta statuses a disable leaves as they are: users who cannot sign in. */
const OKTA_NO_SIGN_IN_STATUSES: readonly string[] = ['SUSPENDED', 'STAGED', 'DEPROVISIONED'];

@Injectable()
export class OktaProvisioningService {
  private readonly logger = new Logger(OktaProvisioningService.name);

  constructor(
    private readonly client: OktaClient,
    private readonly mapper: OktaMapper,
  ) {}

  /**
   * Provision a user to Okta. Idempotent: a user Okta already has (409, or 400 E0000001 for a
   * login taken) is updated instead. A linked admin account (PAM) is created STAGED, so it
   * cannot sign in before a privileged session activates it (setUserEnabled); anyone else is
   * created activated. Then the intent operations (group/app assignments) and the default
   * group, also for an existing user (the add is idempotent): a retry after a first attempt
   * that created the user and failed later must still add it.
   */
  async provision(
    config: OktaConfig,
    user: StandardUserDto,
    intent?: OktaProvisioningIntent,
  ): Promise<ProvisioningResult> {
    const profile = this.mapper.toOktaProfile(user);
    let oktaUserId: string;

    try {
      // Try to create user
      const created = await this.client.createUser(config, profile, !isLinkedAdminProfile(user));
      oktaUserId = created.id;
      this.logger.log(
        `[PROVISION] Created Okta user ${maskEmail(user.email)} with ID ${oktaUserId}`,
      );
    } catch (err: unknown) {
      // The user already exists: update it instead (Safety Rule 7)
      if (this.isConflictError(err)) {
        this.logger.log(`[PROVISION] User ${maskEmail(user.email)} already exists — updating`);
        const existing = await this.client.getUser(config, user.email);
        oktaUserId = existing.id;
        await this.client.updateUser(config, oktaUserId, profile);
      } else {
        throw err;
      }
    }

    // Process intent operations (group/app assignments)
    if (intent?.operations?.length) {
      await this.processIntentOperations(config, oktaUserId, intent);
    }

    // Assign to default group if configured
    if (config.defaultGroupId) {
      try {
        await this.client.addUserToGroup(config, config.defaultGroupId, oktaUserId);
        this.logger.log(
          `[PROVISION] Added ${maskEmail(user.email)} to default group ${config.defaultGroupId}`,
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`[PROVISION] Failed to add to default group: ${message}`);
      }
    }

    return {
      targetUserId: oktaUserId,
      // Okta does not generate work email — it uses the email provided
    };
  }

  /**
   * Update an existing Okta user's profile.
   */
  async updateUser(config: OktaConfig, oktaUserId: string, user: StandardUserDto): Promise<void> {
    const profile = this.mapper.toOktaUpdatePayload(user);
    await this.client.updateUser(config, oktaUserId, profile);
    this.logger.log(`[UPDATE] Updated Okta user ${oktaUserId}`);
  }

  /**
   * Deprovision: deactivate then delete user from Okta.
   * Idempotent: 404 on deactivate/delete = user already gone.
   */
  async deprovision(config: OktaConfig, oktaUserId: string): Promise<void> {
    try {
      await this.client.deactivateUser(config, oktaUserId);
      this.logger.log(`[DEPROVISION] Deactivated Okta user ${oktaUserId}`);
    } catch (err: unknown) {
      // 404 = user already deactivated or deleted
      if (!this.isNotFoundError(err)) throw err;
      this.logger.log(`[DEPROVISION] User ${oktaUserId} already deactivated/deleted`);
    }

    try {
      await this.client.deleteUser(config, oktaUserId);
      this.logger.log(`[DEPROVISION] Deleted Okta user ${oktaUserId}`);
    } catch (err: unknown) {
      // 404 = user already deleted
      if (!this.isNotFoundError(err)) throw err;
      this.logger.log(`[DEPROVISION] User ${oktaUserId} already deleted`);
    }
  }

  /**
   * Deactivate user (disable without delete — for offboarding).
   */
  async deactivateUser(config: OktaConfig, oktaUserId: string): Promise<void> {
    try {
      await this.client.deactivateUser(config, oktaUserId);
      this.logger.log(`[DEACTIVATE] Deactivated Okta user ${oktaUserId}`);
    } catch (err: unknown) {
      if (!this.isNotFoundError(err)) throw err;
      this.logger.warn(`[DEACTIVATE] User ${oktaUserId} not found`);
    }
  }

  /**
   * Offboarding. Deactivates the user (Okta ends its sessions and app access); with
   * deprovisionStrategy 'delete' then deletes it. Finds it by the stored Okta id (404 there
   * means already gone), else by login (GET /users/{login}; provisioning sets login = email).
   * A login lookup miss is a failure an admin must check (422, not retried), never "already
   * gone": the login may have changed since provisioning.
   *
   * The user's status is read first, so a rerun never deactivates a user that is already
   * DEPROVISIONED: Okta documents deactivate for users that are not DEPROVISIONED and delete
   * for users that are (a delete on any other user only deactivates it). An already
   * deactivated user is already gone, or with 'delete' is deleted now.
   */
  async offboardUser(
    config: OktaConfig,
    user: { oktaUserId?: string; login: string },
  ): Promise<DeprovisionResult> {
    let found: OktaUser;
    try {
      found = await this.client.getUser(config, user.oktaUserId ?? user.login);
    } catch (err: unknown) {
      if (!this.isNotFoundError(err)) throw err;
      if (user.oktaUserId) return { outcome: 'already-gone', detail: 'no such user' };
      throw new ConnectorException(
        'No Okta user has the login EuroID provisioned with (the email), and no Okta id is ' +
          'stored: the login may have changed. Check Okta, deactivate the user there and mark ' +
          'it removed manually.',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    const oktaUserId = user.oktaUserId ?? found.id;
    const wasDeactivated = found.status === 'DEPROVISIONED';

    if (!wasDeactivated) {
      try {
        await this.client.deactivateUser(config, oktaUserId);
      } catch (err: unknown) {
        if (!this.isNotFoundError(err)) throw err;
        return { outcome: 'already-gone', detail: 'no such user' };
      }
    }
    if (config.deprovisionStrategy !== 'delete') {
      return wasDeactivated
        ? { outcome: 'already-gone', detail: 'already deactivated' }
        : { outcome: 'deprovisioned', detail: 'deactivated' };
    }

    try {
      await this.client.deleteUser(config, oktaUserId);
    } catch (err: unknown) {
      if (!this.isNotFoundError(err)) throw err;
      if (wasDeactivated) return { outcome: 'already-gone', detail: 'no such user' };
    }
    this.logger.log(`[DEPROVISION] Deactivated and deleted Okta user ${oktaUserId}`);
    return wasDeactivated
      ? { outcome: 'deprovisioned', detail: 'deleted (was already deactivated)' }
      : { outcome: 'deprovisioned', detail: 'deactivated and deleted' };
  }

  // ── Group membership (access review revocation, mover) ──

  /** The Okta id of the user whose login is `login`; null when Okta has none (404). */
  async findUserIdByLogin(config: OktaConfig, login: string): Promise<string | null> {
    try {
      return (await this.client.getUser(config, login)).id;
    } catch (err: unknown) {
      if (this.isNotFoundError(err)) return null;
      throw err;
    }
  }

  /**
   * A privileged session: enable (unsuspend) or disable (suspend) the user, found by its stored
   * id, else by login. Okta suspends only an ACTIVE user and unsuspends only a SUSPENDED one, so
   * the user's status decides:
   * - enable: SUSPENDED is unsuspended; STAGED (a linked admin account as provision creates it)
   *   is activated, which emails its owner the activation link; a status that can sign in or is
   *   waiting for its owner (ACTIVE, PROVISIONED, RECOVERY, PASSWORD_EXPIRED, LOCKED_OUT) is done
   *   as it is; DEPROVISIONED cannot be enabled here (422).
   * - disable: ACTIVE is suspended; SUSPENDED, STAGED and DEPROVISIONED cannot sign in, done as
   *   they are; PROVISIONED fails (422): its owner can still finish activation, which Okta cannot
   *   suspend before, so the session keeps the target state `enabled` and the hourly sweep tries
   *   again until the user is ACTIVE; any other status (RECOVERY, PASSWORD_EXPIRED, LOCKED_OUT)
   *   cannot be suspended (422, for an admin to check in Okta).
   * No such user (404) is not-found.
   */
  async setUserEnabled(
    config: OktaConfig,
    user: { oktaUserId?: string; login: string },
    enabled: boolean,
  ): Promise<PamAccountResult> {
    let found: OktaUser;
    try {
      found = await this.client.getUser(config, user.oktaUserId ?? user.login);
    } catch (err: unknown) {
      if (this.isNotFoundError(err)) return { outcome: 'not-found', detail: 'no such user' };
      throw err;
    }
    const status = found.status;
    const id = user.oktaUserId ?? found.id;
    if (enabled) {
      if (status === 'SUSPENDED') {
        await this.client.unsuspendUser(config, id);
        return { outcome: 'done', detail: 'unsuspended' };
      }
      if (status === 'STAGED') {
        await this.client.activateUser(config, id);
        return {
          outcome: 'done',
          detail: 'activated: its owner finishes the activation Okta emailed',
        };
      }
      if (OKTA_SIGN_IN_STATUSES.includes(status)) {
        return { outcome: 'done', detail: `already ${status.toLowerCase()}` };
      }
      throw new ConnectorException(
        `The Okta user is ${status}: EuroID cannot enable it. Activate it in Okta.`,
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    if (status === 'ACTIVE') {
      await this.client.suspendUser(config, id);
      return { outcome: 'done', detail: 'suspended' };
    }
    if (OKTA_NO_SIGN_IN_STATUSES.includes(status)) {
      return { outcome: 'done', detail: `already ${status.toLowerCase()}` };
    }
    if (status === 'PROVISIONED') {
      // Its owner can still finish the activation Okta emailed and sign in, and Okta cannot
      // suspend it before: failing keeps the session's target state `enabled`, so the hourly
      // sweep (PrivilegedSessionService.convergeStandingState) runs this again until it can
      throw new ConnectorException(
        'The Okta user is PROVISIONED: its owner has not finished the activation Okta emailed, ' +
          'and Okta suspends only an ACTIVE user. The hourly sweep suspends it once its owner ' +
          'has activated it.',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    throw new ConnectorException(
      `The Okta user is ${status}: Okta suspends only an ACTIVE user. Check it in Okta.`,
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }

  /**
   * The user's status and when it last changed, read only; null when Okta has no such user
   * (404). The hourly PAM sweep reads it before it starts a disable-only run.
   */
  async getUserStatus(
    config: OktaConfig,
    user: { oktaUserId?: string; login: string },
  ): Promise<PamAccountStatus | null> {
    try {
      const found = await this.client.getUser(config, user.oktaUserId ?? user.login);
      return {
        status: found.status,
        ...(found.statusChanged ? { statusChanged: found.statusChanged } : {}),
      };
    } catch (err: unknown) {
      if (this.isNotFoundError(err)) return null;
      throw err;
    }
  }

  /** The user's direct groups; null when Okta has no such user (404). */
  async listUserGroups(config: OktaConfig, oktaUserId: string): Promise<OktaGroup[] | null> {
    try {
      return await this.client.listUserGroups(config, oktaUserId);
    } catch (err: unknown) {
      if (this.isNotFoundError(err)) return null;
      throw err;
    }
  }

  /** DELETE /groups/{groupId}/users/{userId}. Only OKTA_GROUP memberships can be removed. */
  async removeGroupMember(config: OktaConfig, groupId: string, oktaUserId: string): Promise<void> {
    await this.client.removeUserFromGroup(config, groupId, oktaUserId);
  }

  /** PUT /groups/{groupId}/users/{userId} (mover). Only OKTA_GROUP memberships can be added. */
  async addGroupMember(config: OktaConfig, groupId: string, oktaUserId: string): Promise<void> {
    await this.client.addUserToGroup(config, groupId, oktaUserId);
  }

  // ── Intent Processing ──

  /**
   * Process provisioning intent operations (group/app/role assignments).
   */
  private async processIntentOperations(
    config: OktaConfig,
    oktaUserId: string,
    intent: OktaProvisioningIntent,
  ): Promise<void> {
    for (const op of intent.operations) {
      try {
        switch (op.type) {
          case 'group':
            if (op.action === 'add') {
              await this.client.addUserToGroup(config, op.targetId, oktaUserId);
            } else {
              await this.client.removeUserFromGroup(config, op.targetId, oktaUserId);
            }
            break;
          case 'app':
            if (op.action === 'add') {
              await this.client.assignAppToUser(config, op.targetId, oktaUserId);
            } else {
              await this.client.unassignAppFromUser(config, op.targetId, oktaUserId);
            }
            break;
          case 'role':
            // Okta admin roles are managed via the Groups API (role groups)
            // For now, treat role operations as group operations
            this.logger.warn(
              `[INTENT] Role operations mapped to group API. targetId=${op.targetId}`,
            );
            if (op.action === 'add') {
              await this.client.addUserToGroup(config, op.targetId, oktaUserId);
            } else {
              await this.client.removeUserFromGroup(config, op.targetId, oktaUserId);
            }
            break;
        }
        this.logger.log(`[INTENT] ${op.action} ${op.type} ${op.targetId} for user ${oktaUserId}`);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`[INTENT] Failed ${op.action} ${op.type} ${op.targetId}: ${message}`);
        throw err;
      }
    }
  }

  // ── Helpers ──

  /**
   * A create refused because the user exists: 409, or Okta's 400 E0000001 ("Api validation
   * failed: login") whose cause says the login already exists. Another E0000001 (a field that
   * fails validation) is a real error.
   */
  private isConflictError(err: unknown): boolean {
    if (typeof err !== 'object' || err === null || !('isAxiosError' in err)) return false;
    const response = (err as { response?: { status?: number; data?: OktaErrorBody } }).response;
    if (response?.status === 409) return true;
    const body = response?.data;
    return (
      response?.status === 400 &&
      body?.errorCode === 'E0000001' &&
      (body.errorCauses ?? []).some((c) => /already exists/i.test(c?.errorSummary ?? ''))
    );
  }

  private isNotFoundError(err: unknown): boolean {
    return (
      typeof err === 'object' &&
      err !== null &&
      'isAxiosError' in err &&
      (err as { response?: { status?: number } }).response?.status === 404
    );
  }
}
