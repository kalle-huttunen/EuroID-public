import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { OnEvent } from '@nestjs/event-emitter';
import { Model } from 'mongoose';
import { DomainEventType } from '@infrastructure/events/event-types';
import type { DomainEvent } from '@infrastructure/events/domain-event.interface';
import type { OffboardingCompletedPayload } from '@infrastructure/events/event-payloads';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { LeaverEvent, LeaverEventDocument } from './schemas/leaver-event.schema';
import { OffboardingRecord, OffboardingRecordDocument } from './schemas/offboarding-record.schema';

/**
 * Stores every offboarding's per-system result, with its linked admin accounts, as its offboarding
 * record (keyed by the workflow id), whether an HR leaver event or DELETE /identity/:id started it: the Leavers history and
 * the Failed offboardings tab read it there. A re-run of the same workflow id replaces it. The
 * started leaver event of that workflow, if any, is marked finished (`offboardingFinishedAt`).
 */
@Injectable()
export class LeaverOffboardingResultHandler {
  private readonly logger = new Logger(LeaverOffboardingResultHandler.name);

  constructor(
    @InjectModel(OffboardingRecord.name)
    private readonly recordModel: Model<OffboardingRecordDocument>,
    @InjectModel(LeaverEvent.name) private readonly eventModel: Model<LeaverEventDocument>,
  ) {}

  @OnEvent(DomainEventType.IDENTITY_OFFBOARDING_COMPLETED, { async: true })
  async handleOffboardingCompleted(event: DomainEvent<OffboardingCompletedPayload>): Promise<void> {
    const tenantId = event.metadata?.tenantId;
    if (!tenantId) {
      this.logger.warn(`[Leavers] ${event.type} without a tenant, result not stored`);
      return;
    }
    const { identityId, workflowId, status, hubStatus, systems, linkedAdmins } = event.payload;
    try {
      const finishedAt = new Date();
      await withTenantContext(tenantId, async () => {
        await this.recordModel
          .updateOne(
            { tenantId, workflowId },
            // linkedAdmins always set, so a rerun's record keeps none of the first run's
            {
              $set: {
                identityId,
                status,
                hubStatus,
                systems,
                linkedAdmins: linkedAdmins ?? [],
                finishedAt,
              },
            },
            { upsert: true },
          )
          .exec();
        await this.eventModel
          .updateMany(
            { tenantId, identityId, workflowId, status: 'started' },
            { $set: { offboardingFinishedAt: finishedAt } },
          )
          .exec();
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`[Leavers] Storing offboarding result ${workflowId} failed: ${message}`);
    }
  }
}
