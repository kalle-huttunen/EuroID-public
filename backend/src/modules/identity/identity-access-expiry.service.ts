import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, type UpdateQuery } from 'mongoose';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import { getCurrentTenantId } from '@infrastructure/multi-tenancy/tenant-context.helper';
import type { IdentityDocument, ProvisioningState } from './schemas/identity.schema';
import { NOT_DELETED } from './identity.constants';

type FailedEntry = ProvisioningState & {
  expiresAt: Date;
  expiryFailure: NonNullable<ProvisioningState['expiryFailure']>;
};

const time = (value: Date | string | undefined) => (value ? new Date(value).getTime() : NaN);

/**
 * Admin actions on expired access the hourly entitlementExpiryWorkflow could not remove: a
 * provisioning entry, not DEPROVISIONED, with an `expiryFailure` for its current `expiresAt`.
 * Modelled on closing a failed offboarding target (LeaverManualRemovalService):
 * - retry: the failure is cleared, so the next run tries to remove the access again (after the
 *   admin fixed the cause, e.g. the connector config or its permissions);
 * - removed manually: the admin removed the access in the target by hand. The entry becomes
 *   DEPROVISIONED and the failure is cleared; EuroID did not remove it, and the audit log and
 *   the identity timeline say who closed it and why.
 * Tenant from the request context. 404: no such identity in the tenant, or no entry for that
 * target; 409: no failed expiry on the entry (none, one for an earlier expiry date, already
 * DEPROVISIONED, or closed meanwhile). Audited through entitlement.expiry_retry_requested and
 * entitlement.expiry_removed_manually with the admin as actor.
 */
@Injectable()
export class IdentityAccessExpiryService {
  constructor(
    @InjectModel('Identity') private readonly identityModel: Model<IdentityDocument>,
    private readonly eventEmitter: DomainEventEmitterService,
  ) {}

  async retry(identityId: string, targetSystem: string, actor: string): Promise<ProvisioningState> {
    const entry = await this.failedEntry(identityId, targetSystem, 'retry');
    const updated = await this.update(identityId, entry, {
      $unset: { 'provisioning.$.expiryFailure': 1 },
    });
    this.eventEmitter.emit(
      DomainEventType.ENTITLEMENT_EXPIRY_RETRY_REQUESTED,
      identityId,
      {
        identityId,
        targetSystem,
        expiresAt: entry.expiresAt.toISOString(),
        failureReason: entry.expiryFailure.reason,
      },
      { actor },
    );
    return updated;
  }

  async markRemovedManually(
    identityId: string,
    targetSystem: string,
    actor: string,
    reason: string,
  ): Promise<ProvisioningState> {
    const entry = await this.failedEntry(identityId, targetSystem, 'close');
    const updated = await this.update(identityId, entry, {
      // A deprovision: the system no longer counts as having an account (provisionedAt), and a
      // later provision writes its new account id back (writebackComplete)
      $set: {
        'provisioning.$.status': 'DEPROVISIONED',
        'provisioning.$.lastSync': new Date(),
        'provisioning.$.provisionedAt': null,
        'provisioning.$.writebackComplete': false,
      },
      $unset: { 'provisioning.$.expiryFailure': 1, 'provisioning.$.errorMsg': 1 },
    });
    this.eventEmitter.emit(
      DomainEventType.ENTITLEMENT_EXPIRY_REMOVED_MANUALLY,
      identityId,
      {
        identityId,
        targetSystem,
        expiresAt: entry.expiresAt.toISOString(),
        reason,
        failureReason: entry.expiryFailure.reason,
      },
      { actor },
    );
    return updated;
  }

  /** The entry of `targetSystem` with a failed expiry, or the 404 / 409 that says why not. */
  private async failedEntry(
    identityId: string,
    targetSystem: string,
    action: 'retry' | 'close',
  ): Promise<FailedEntry> {
    const identity = await this.identityModel
      .findOne({ _id: identityId, tenantId: getCurrentTenantId(), ...NOT_DELETED })
      .select('provisioning')
      .lean()
      .exec();
    if (!identity) throw new NotFoundException('Identity not found');
    const entry = (identity.provisioning ?? []).find((p) => p.targetSystem === targetSystem);
    if (!entry) {
      throw new NotFoundException(`The identity has no provisioning entry for ${targetSystem}`);
    }
    const failure = entry.expiryFailure;
    const current = failure && time(failure.expiresAt) === time(entry.expiresAt);
    if (entry.status === 'DEPROVISIONED' || !current) {
      throw new ConflictException(
        `${targetSystem} has no failed expiry to ${action}: ` +
          (entry.status === 'DEPROVISIONED'
            ? 'its access is already removed (DEPROVISIONED).'
            : 'the expiry run has not failed on it for its current expiry date.'),
      );
    }
    return entry as FailedEntry;
  }

  /** Apply `update` to the entry while it still has that failed expiry; 409 when it changed. */
  private async update(
    identityId: string,
    entry: FailedEntry,
    update: UpdateQuery<IdentityDocument>,
  ): Promise<ProvisioningState> {
    const updated = await this.identityModel
      .findOneAndUpdate(
        {
          _id: identityId,
          tenantId: getCurrentTenantId(),
          ...NOT_DELETED,
          provisioning: {
            $elemMatch: {
              targetSystem: entry.targetSystem,
              status: { $ne: 'DEPROVISIONED' },
              expiresAt: entry.expiresAt,
              'expiryFailure.expiresAt': entry.expiresAt,
            },
          },
        },
        update,
        { new: true },
      )
      .select('provisioning')
      .lean()
      .exec();
    const after = updated?.provisioning?.find((p) => p.targetSystem === entry.targetSystem);
    if (!after) {
      throw new ConflictException(
        `${entry.targetSystem} changed meanwhile (removed, retried or closed by someone else). ` +
          'Reload the identity and try again.',
      );
    }
    return after;
  }
}
