import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import type { OffboardingTargetRemovedManuallyPayload } from '@infrastructure/events/event-payloads';
import { getCurrentTenantId } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { DEFAULT_PAGE_SIZE } from '@infrastructure/config/defaults';
import type { ManualRemoval } from '@shared/types/deprovision';
import type { IdentityDocument } from '../identity/schemas/identity.schema';
import { findLiveLinkedAdmins } from '../identity/linked-admin-identities';
import { LeaverEvent, LeaverEventDocument } from './schemas/leaver-event.schema';
import { OffboardingRecord, OffboardingRecordDocument } from './schemas/offboarding-record.schema';
import { FailedOffboardingItem, StoredRecord, toFailedOffboardingItems } from './leaver-items';

/**
 * Offboardings that left a target failed, whatever started them (an HR leaver, or DELETE
 * /identity/:id), and the admin action that closes one target: the admin removed the account by
 * hand and says so ("removed manually"). Keyed by the offboarding's workflow id. The target's
 * result becomes `removed-manually` with the admin and their note (never "removed by EuroID");
 * once no target of that offboarding is left failed and no linked admin account of it failed,
 * the identity ends like a fully successful offboarding (Golden Record deleted), unless one of the
 * person's linked admin identities is still live: then closing the last failed target is refused
 * (409) and it stays failed. A failed linked admin account is closed on its own offboarding's
 * record; the person's offboarding is then run again. Audited through
 * IDENTITY_OFFBOARDING_TARGET_REMOVED_MANUALLY, whose identity handler updates the identity.
 */
@Injectable()
export class LeaverManualRemovalService {
  private readonly logger = new Logger(LeaverManualRemovalService.name);

  constructor(
    @InjectModel(OffboardingRecord.name)
    private readonly recordModel: Model<OffboardingRecordDocument>,
    @InjectModel(LeaverEvent.name) private readonly eventModel: Model<LeaverEventDocument>,
    @InjectModel('Identity') private readonly identityModel: Model<IdentityDocument>,
    private readonly eventEmitter: DomainEventEmitterService,
  ) {}

  /**
   * Offboardings with a failed target or linked admin account, newest first, with their leaver
   * event when one exists.
   */
  async listOpen(): Promise<FailedOffboardingItem[]> {
    const tenantId = getCurrentTenantId();
    const records = (await this.recordModel
      .find({
        tenantId,
        $or: [{ 'systems.outcome': 'failed' }, { 'linkedAdmins.outcome': 'failed' }],
      })
      .sort({ finishedAt: -1 })
      .limit(DEFAULT_PAGE_SIZE)
      .lean()
      .exec()) as unknown as StoredRecord[];
    return toFailedOffboardingItems(this.identityModel, this.eventModel, tenantId, records);
  }

  /**
   * Close the failed target `system` of the offboarding `workflowId`: 404 for no such
   * offboarding in this tenant, 409 when that target is not failed (closed already, or not part
   * of the result).
   */
  async markRemoved(
    workflowId: string,
    system: string,
    actor: string,
    reason: string,
  ): Promise<FailedOffboardingItem> {
    const tenantId = getCurrentTenantId();
    const manualRemoval: ManualRemoval = { by: actor, at: new Date().toISOString(), reason };
    // Only one admin wins a target; the document after the update shows what is left failed
    const updated = (await this.recordModel
      .findOneAndUpdate(
        {
          tenantId,
          workflowId,
          systems: { $elemMatch: { system, outcome: 'failed' } },
        },
        {
          $set: {
            'systems.$.outcome': 'removed-manually',
            'systems.$.manualRemoval': manualRemoval,
          },
        },
        { new: true },
      )
      .lean()
      .exec()) as unknown as StoredRecord | null;
    if (!updated) {
      const exists = await this.recordModel.exists({ tenantId, workflowId }).exec();
      if (!exists) throw new NotFoundException('Offboarding not found');
      throw new ConflictException(`${system} is not a failed target of this offboarding`);
    }

    // A failed linked admin account may still exist: the person stays suspended until a rerun
    // of the offboarding finds no live admin account left
    const offboardingComplete =
      !updated.systems.some((s) => s.outcome === 'failed') &&
      !(updated.linkedAdmins ?? []).some((a) => a.outcome === 'failed');
    if (offboardingComplete) {
      await this.refuseWhileAdminLive(tenantId, workflowId, system, updated.identityId);
    }
    const leaverEvent = await this.eventModel
      .findOne({ tenantId, workflowId, status: 'started' })
      .sort({ startedAt: -1 })
      .select('_id')
      .lean()
      .exec();
    try {
      await this.eventEmitter.emitAndWait<OffboardingTargetRemovedManuallyPayload>(
        DomainEventType.IDENTITY_OFFBOARDING_TARGET_REMOVED_MANUALLY,
        updated.identityId,
        {
          identityId: updated.identityId,
          workflowId,
          ...(leaverEvent ? { leaverEventId: String(leaverEvent._id) } : {}),
          system,
          reason,
          offboardingComplete,
        },
        { tenantId, actor },
      );
    } catch (err: unknown) {
      await this.reopen(tenantId, workflowId, system);
      throw err;
    }

    if (offboardingComplete) {
      await this.recordModel
        .updateOne(
          { tenantId, workflowId },
          { $set: { status: 'completed', hubStatus: 'deleted' } },
        )
        .exec();
    }
    const record = (await this.recordModel
      .findOne({ tenantId, workflowId })
      .lean()
      .exec()) as unknown as StoredRecord;
    const [item] = await toFailedOffboardingItems(this.identityModel, this.eventModel, tenantId, [
      record,
    ]);
    return item;
  }

  /**
   * Closing the last failed target deletes the person, which must not happen while one of their
   * linked admin identities is live (its offboarding runs elsewhere, or it was linked after the
   * offboarding): the target is failed again and the admin gets a 409 naming them.
   */
  private async refuseWhileAdminLive(
    tenantId: string,
    workflowId: string,
    system: string,
    identityId: string,
  ): Promise<void> {
    const live = await findLiveLinkedAdmins(this.identityModel, identityId, tenantId);
    if (live.length === 0) return;
    await this.reopen(tenantId, workflowId, system);
    const ids = live.map((a) => a.identityId).join(', ');
    throw new ConflictException(
      `${system} stays failed: closing it would delete a person whose linked admin identity ` +
        `${ids} is still live. Offboard that admin account first (its own offboarding), then ` +
        'close this target.',
    );
  }

  /** The identity could not be updated: the target is failed again, so the admin can retry. */
  private async reopen(tenantId: string, workflowId: string, system: string): Promise<void> {
    this.logger.warn(
      `[Leavers] Manual removal of ${system} on ${workflowId} undone: identity update failed`,
    );
    await this.recordModel
      .updateOne(
        {
          tenantId,
          workflowId,
          systems: { $elemMatch: { system, outcome: 'removed-manually' } },
        },
        {
          $set: { 'systems.$.outcome': 'failed' },
          $unset: { 'systems.$.manualRemoval': 1 },
        },
      )
      .exec();
  }
}
