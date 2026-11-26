import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Identity, type IdentityDocument } from '../identity/schemas/identity.schema';
import { NOT_DELETED } from '../identity/identity.constants';
import { provisionedSystems, targetAccountId } from '../identity/identity-provisioning.service';
import { UserStatus } from '@shared/dtos/standard-user.dto';
import type { PamSessionTargets } from '@shared/types/pam-session';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import { LoggerFactoryService } from '@infrastructure/observability/contextual-logger.service';

/** Entry statuses of a session that has not ended. */
const OPEN_STATUSES = ['ACTIVE', 'ACTIVATING'];

/**
 * What a privileged session (privilegedSessionWorkflow) reads and records in MongoDB, through
 * its activities (PrivilegedAccessActivities): the admin identity's accounts, and the session
 * state on the parent's `linkedAdminAccounts` entry and on the admin identity (`profile.status`,
 * which the connector mappers read: linked-admin-profile.ts; `pamTargetState`, which the hourly
 * sweep reads). Only the session writes ACTIVE, and only once the accounts are enabled.
 */
@Injectable()
export class PamSessionStateService {
  private readonly logger = this.loggerFactory.create(PamSessionStateService.name);

  constructor(
    @InjectModel(Identity.name) private readonly identityModel: Model<IdentityDocument>,
    private readonly eventEmitter: DomainEventEmitterService,
    private readonly loggerFactory: LoggerFactoryService,
  ) {}

  /**
   * The accounts the session enables and disables: every target the admin identity has an
   * account in (provisionedSystems), with its stored id. `live` only while the admin identity
   * and its parent are not deleted. A deleted admin identity's targets are still listed, so a
   * session that ends disables what it enabled.
   */
  async sessionTargets(adminId: string, tenantId: string): Promise<PamSessionTargets> {
    const admin = await this.identityModel.findOne({ _id: adminId, tenantId }).exec();
    if (!admin) return { live: false, targets: [] };
    return {
      live: await this.isLive(admin, tenantId),
      login: admin.profile?.email,
      targets: provisionedSystems(admin).map((targetSystem) => {
        const externalId = targetAccountId(admin.sources, targetSystem);
        return { targetSystem, ...(externalId ? { externalId } : {}) };
      }),
    };
  }

  /** The session started: the entry is ACTIVATING under this session id, the last error gone. */
  async markActivating(adminId: string, sessionId: string, tenantId: string): Promise<void> {
    const parentId = await this.parentOf(adminId, tenantId);
    if (!parentId) return;
    await this.identityModel
      .updateOne(
        { _id: parentId, tenantId, 'linkedAdminAccounts.identityId': adminId },
        {
          $set: {
            'linkedAdminAccounts.$.status': 'ACTIVATING',
            'linkedAdminAccounts.$.sessionId': sessionId,
          },
          $unset: { 'linkedAdminAccounts.$.activationError': '' },
        },
      )
      .exec();
  }

  /**
   * Every account is enabled: the session is ACTIVE until now + durationMs, the admin identity's
   * profile ACTIVE and its target state `enabled`; emits admin_account.activated. An admin
   * identity (or its parent) deleted meanwhile is not activated: `live: false`, nothing written.
   */
  async recordActive(
    adminId: string,
    sessionId: string,
    durationMs: number,
    tenantId: string,
  ): Promise<{ live: boolean; expiresAt?: string }> {
    const admin = await this.identityModel.findOne({ _id: adminId, tenantId }).exec();
    if (!admin?.parentIdentityId || !(await this.isLive(admin, tenantId))) return { live: false };
    const now = new Date();
    const expiresAt = new Date(now.getTime() + durationMs);
    await this.identityModel
      .updateOne(
        { _id: adminId, tenantId },
        { $set: { 'profile.status': UserStatus.ACTIVE, pamTargetState: 'enabled' } },
      )
      .exec();
    await this.identityModel
      .updateOne(
        { _id: admin.parentIdentityId, tenantId, 'linkedAdminAccounts.identityId': adminId },
        {
          $set: {
            'linkedAdminAccounts.$.status': 'ACTIVE',
            'linkedAdminAccounts.$.sessionId': sessionId,
            'linkedAdminAccounts.$.activatedAt': now,
            'linkedAdminAccounts.$.expiresAt': expiresAt,
          },
          $unset: { 'linkedAdminAccounts.$.activationError': '' },
        },
      )
      .exec();
    this.eventEmitter.emit(
      DomainEventType.ADMIN_ACCOUNT_ACTIVATED,
      adminId,
      { parentIdentityId: admin.parentIdentityId, expiresAt: expiresAt.toISOString() },
      { actor: 'privileged-session-workflow' },
    );
    this.logger.log(`Activated admin account ${adminId} (expires: ${expiresAt.toISOString()})`);
    return { live: true, expiresAt: expiresAt.toISOString() };
  }

  /**
   * The activation failed (`reason`) and the session disabled the accounts again: the entry is
   * INACTIVE with the reason. `disableFailures` (accounts it could not disable) leave the target
   * state `enabled` for the hourly sweep to retry.
   */
  async recordFailed(
    adminId: string,
    sessionId: string,
    reason: string,
    disableFailures: string[],
    tenantId: string,
  ): Promise<void> {
    const parentId = await this.parentOf(adminId, tenantId);
    await this.setTargetState(adminId, disableFailures, tenantId);
    if (parentId) {
      await this.identityModel
        .updateOne(
          { _id: parentId, tenantId, 'linkedAdminAccounts.identityId': adminId },
          {
            $set: {
              'linkedAdminAccounts.$.status': 'INACTIVE',
              'linkedAdminAccounts.$.sessionId': sessionId,
              'linkedAdminAccounts.$.deactivatedAt': new Date(),
              'linkedAdminAccounts.$.activationError': reason,
              ...this.disableErrorSet(disableFailures),
            },
            ...this.disableErrorUnset(disableFailures),
          },
        )
        .exec();
    }
    this.logger.warn(`Activation of admin account ${adminId} failed: ${reason}`);
  }

  /**
   * The accounts were disabled (`failures`: those that could not be): a session that was open
   * (ACTIVE, ACTIVATING) is INACTIVE now, the admin identity's profile INACTIVE, and its target
   * state `disabled` (`enabled` while a disable failed); emits admin_account.deactivated with the
   * reason when a session ended. A disable-only run for an entry already INACTIVE or PENDING only
   * records the target state.
   */
  async recordEnded(
    adminId: string,
    ended: { reason: string; failures: string[] },
    tenantId: string,
  ): Promise<void> {
    const admin = await this.identityModel.findOne({ _id: adminId, tenantId }).exec();
    if (!admin) return;
    await this.setTargetState(adminId, ended.failures, tenantId);
    if (admin.profile?.status === UserStatus.ACTIVE) {
      await this.identityModel
        .updateOne({ _id: adminId, tenantId }, { $set: { 'profile.status': UserStatus.INACTIVE } })
        .exec();
    }
    if (!admin.parentIdentityId) return;
    const entryFilter = { _id: admin.parentIdentityId, tenantId };
    await this.identityModel
      .updateOne(
        { ...entryFilter, 'linkedAdminAccounts.identityId': adminId },
        ended.failures.length > 0
          ? { $set: this.disableErrorSet(ended.failures) }
          : this.disableErrorUnset(ended.failures),
      )
      .exec();
    const closed = await this.identityModel
      .updateOne(
        {
          ...entryFilter,
          linkedAdminAccounts: {
            $elemMatch: { identityId: adminId, status: { $in: OPEN_STATUSES } },
          },
        },
        {
          $set: {
            'linkedAdminAccounts.$.status': 'INACTIVE',
            'linkedAdminAccounts.$.deactivatedAt': new Date(),
          },
        },
      )
      .exec();
    if (closed.modifiedCount > 0) {
      this.eventEmitter.emit(DomainEventType.ADMIN_ACCOUNT_DEACTIVATED, adminId, {
        parentIdentityId: admin.parentIdentityId,
        reason: ended.reason,
        ...(ended.failures.length > 0 ? { disableFailed: true } : {}),
      });
      this.logger.log(`Deactivated admin account ${adminId} (${ended.reason})`);
    }
    if (ended.failures.length > 0) {
      this.logger.warn(`Disabling admin account ${adminId} failed: ${ended.failures.join('; ')}`);
    }
  }

  private async setTargetState(adminId: string, failures: string[], tenantId: string) {
    await this.identityModel
      .updateOne(
        { _id: adminId, tenantId },
        { $set: { pamTargetState: failures.length > 0 ? 'enabled' : 'disabled' } },
      )
      .exec();
  }

  private disableErrorSet(failures: string[]): Record<string, string> {
    return failures.length > 0 ? { 'linkedAdminAccounts.$.disableError': failures.join('; ') } : {};
  }

  /** A disable that succeeded clears the last failure and the activation-pending alert mark. */
  private disableErrorUnset(failures: string[]) {
    return failures.length > 0
      ? {}
      : {
          $unset: {
            'linkedAdminAccounts.$.disableError': '',
            'linkedAdminAccounts.$.activationPendingAlertedAt': '',
          },
        };
  }

  private async parentOf(adminId: string, tenantId: string): Promise<string | undefined> {
    const admin = await this.identityModel
      .findOne({ _id: adminId, tenantId })
      .select('parentIdentityId')
      .lean()
      .exec();
    return admin?.parentIdentityId ? String(admin.parentIdentityId) : undefined;
  }

  private async isLive(admin: IdentityDocument, tenantId: string): Promise<boolean> {
    if (admin.deletedAt || !admin.parentIdentityId) return false;
    const parent = await this.identityModel
      .findOne({ _id: admin.parentIdentityId, tenantId, ...NOT_DELETED })
      .select('_id')
      .lean()
      .exec();
    return Boolean(parent);
  }
}
