import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model } from 'mongoose';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import type { LeaverBatchPayload, LeaverReason } from '@infrastructure/events/event-payloads';
import {
  getCurrentTenantId,
  withTenantContext,
} from '@infrastructure/multi-tenancy/tenant-context.helper';
import { DEFAULT_PAGE_SIZE } from '@infrastructure/config/defaults';
import type { IdentityDocument } from '../identity/schemas/identity.schema';
import { LeaverBatch, LeaverBatchDocument, LeaverBatchStatus } from './schemas/leaver-batch.schema';
import { LeaverEvent, LeaverEventDocument } from './schemas/leaver-event.schema';
import { OffboardingRecord, OffboardingRecordDocument } from './schemas/offboarding-record.schema';
import { LeaverExecutionService } from './leaver-execution.service';
import { LeaverBatchItem, StoredLeaverEvent, toLeaverItems } from './leaver-items';

export type { LeaverBatchItem } from './leaver-items';

export interface LeaverBatchView {
  id: string;
  sourceName: string;
  status: LeaverBatchStatus;
  identityCount: number;
  allowance: number;
  activeIdentityCount: number;
  reasonCounts: Partial<Record<LeaverReason, number>>;
  createdAt?: Date;
  decidedBy?: string;
  decidedAt?: Date;
  comment?: string;
  startedCount?: number;
  items: LeaverBatchItem[];
}

type StoredBatch = LeaverBatch & { _id: unknown; createdAt?: Date };
type StoredEvent = StoredLeaverEvent;

/**
 * Paused leaver batches: list them for the current tenant, approve (start every member's
 * offboarding, after the answer) or reject (clear them). The actor is always the authenticated
 * user; every decision is a domain event, so it is audited.
 */
@Injectable()
export class LeaverBatchService {
  private readonly logger = new Logger(LeaverBatchService.name);

  constructor(
    @InjectModel(LeaverBatch.name) private readonly batchModel: Model<LeaverBatchDocument>,
    @InjectModel(LeaverEvent.name) private readonly eventModel: Model<LeaverEventDocument>,
    @InjectModel('Identity') private readonly identityModel: Model<IdentityDocument>,
    @InjectModel(OffboardingRecord.name)
    private readonly recordModel: Model<OffboardingRecordDocument>,
    private readonly execution: LeaverExecutionService,
    private readonly eventEmitter: DomainEventEmitterService,
  ) {}

  /** Newest batches first, with their members. */
  async list(status?: LeaverBatchStatus): Promise<LeaverBatchView[]> {
    const tenantId = getCurrentTenantId();
    const batches = (await this.batchModel
      .find({ tenantId, ...(status ? { status } : {}) })
      .sort({ createdAt: -1 })
      .limit(DEFAULT_PAGE_SIZE)
      .lean()
      .exec()) as unknown as StoredBatch[];
    if (batches.length === 0) return [];
    const batchIds = batches.map((b) => String(b._id));
    const events = (await this.eventModel
      .find({ tenantId, batchId: { $in: batchIds } })
      .lean()
      .exec()) as unknown as StoredEvent[];
    const items = await toLeaverItems(this.identityModel, this.recordModel, tenantId, events);
    return batches.map((b) => this.toView(b, events, items));
  }

  async approve(batchId: string, actor: string, comment?: string): Promise<LeaverBatchView> {
    const tenantId = getCurrentTenantId();
    const batch = await this.decide(tenantId, batchId, 'approved', actor, comment);
    const members = (await this.eventModel
      .find({ tenantId, batchId, status: 'pending-approval' })
      .lean()
      .exec()) as unknown as StoredEvent[];

    for (const event of members) {
      if (await this.reappeared(tenantId, event)) {
        await this.execution.close(
          tenantId,
          String(event._id),
          'superseded',
          'Back in the HR feed when the batch was approved',
        );
      }
    }
    await this.eventModel
      .updateMany(
        { tenantId, batchId, status: 'pending-approval' },
        { $set: { status: 'queued', decidedBy: actor } },
      )
      .exec();

    // The decision; each offboarding start is its own identity.leaver_offboarding_started
    this.eventEmitter.emit<LeaverBatchPayload>(
      DomainEventType.LEAVER_BATCH_APPROVED,
      batchId,
      {
        batchId,
        sourceName: batch.sourceName,
        identityCount: batch.identityCount,
        ...(comment ? { comment } : {}),
      },
      { tenantId, actor },
    );
    // The answer shows the members queued, before any start
    const view = await this.getView(tenantId, batchId);
    this.startAfterAnswer(tenantId, batchId, actor);
    return view;
  }

  /**
   * Starts the approved batch's offboardings outside the approval request: with Temporal slow or
   * down every start waits up to its timeout, which held the approval for minutes. Each start is
   * claimed (LeaverExecutionService.startQueued); a failed one stays queued with startError and
   * the source's next sync retries it. Records how many this run started.
   */
  private startAfterAnswer(tenantId: string, batchId: string, actor: string): void {
    const run = async () => {
      const started = await this.execution.startQueued(tenantId, { batchId }, actor);
      await this.batchModel
        .updateOne({ _id: batchId, tenantId }, { $set: { startedCount: started } })
        .exec();
    };
    void Promise.resolve(withTenantContext(tenantId, run, { actor })).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`[Leavers] Offboarding starts of batch ${batchId} failed: ${message}`);
    });
  }

  async reject(batchId: string, actor: string, comment?: string): Promise<LeaverBatchView> {
    const tenantId = getCurrentTenantId();
    const batch = await this.decide(tenantId, batchId, 'rejected', actor, comment);
    await this.eventModel
      .updateMany(
        { tenantId, batchId, status: 'pending-approval' },
        {
          $set: {
            status: 'rejected',
            open: false,
            decidedBy: actor,
            closeReason: 'Batch rejected',
          },
        },
      )
      .exec();
    this.eventEmitter.emit<LeaverBatchPayload>(
      DomainEventType.LEAVER_BATCH_REJECTED,
      batchId,
      {
        batchId,
        sourceName: batch.sourceName,
        identityCount: batch.identityCount,
        ...(comment ? { comment } : {}),
      },
      { tenantId, actor },
    );
    return this.getView(tenantId, batchId);
  }

  /** Move a pending batch to its decision; only one decision ever wins. */
  private async decide(
    tenantId: string,
    batchId: string,
    status: 'approved' | 'rejected',
    actor: string,
    comment?: string,
  ): Promise<StoredBatch> {
    if (!isValidObjectId(batchId)) throw new NotFoundException('Leaver batch not found');
    const decided = await this.batchModel
      .findOneAndUpdate(
        { _id: batchId, tenantId, status: 'pending' },
        {
          $set: {
            status,
            decidedBy: actor,
            decidedAt: new Date(),
            ...(comment ? { comment } : {}),
          },
        },
        { new: true },
      )
      .lean()
      .exec();
    if (decided) return decided as unknown as StoredBatch;
    const exists = await this.batchModel.exists({ _id: batchId, tenantId }).exec();
    if (!exists) throw new NotFoundException('Leaver batch not found');
    throw new ConflictException('Leaver batch was already decided');
  }

  /** A missing-from-source leaver the source delivered again after detection is no leaver. */
  private async reappeared(tenantId: string, event: StoredEvent): Promise<boolean> {
    if (event.reason !== 'missing-from-source') return false;
    const identity = (await this.identityModel
      .findOne({ _id: event.identityId, tenantId })
      .select({ sources: 1 })
      .lean()
      .exec()) as { sources?: Array<{ sourceName: string; lastSync?: Date }> } | null;
    const lastSync = identity?.sources?.find((s) => s.sourceName === event.sourceName)?.lastSync;
    if (!lastSync) return false;
    return !event.effectiveDate || new Date(lastSync) > new Date(event.effectiveDate);
  }

  private async getView(tenantId: string, batchId: string): Promise<LeaverBatchView> {
    const batch = (await this.batchModel
      .findOne({ _id: batchId, tenantId })
      .lean()
      .exec()) as unknown as StoredBatch | null;
    if (!batch) throw new NotFoundException('Leaver batch not found');
    const events = (await this.eventModel
      .find({ tenantId, batchId })
      .lean()
      .exec()) as unknown as StoredEvent[];
    const items = await toLeaverItems(this.identityModel, this.recordModel, tenantId, events);
    return this.toView(batch, events, items);
  }

  /** `items` are `events` as page items, index by index. */
  private toView(
    batch: StoredBatch,
    events: StoredEvent[],
    items: LeaverBatchItem[],
  ): LeaverBatchView {
    const id = String(batch._id);
    return {
      id,
      sourceName: batch.sourceName,
      status: batch.status,
      identityCount: batch.identityCount,
      allowance: batch.allowance,
      activeIdentityCount: batch.activeIdentityCount,
      reasonCounts: batch.reasonCounts ?? {},
      createdAt: batch.createdAt,
      decidedBy: batch.decidedBy,
      decidedAt: batch.decidedAt,
      comment: batch.comment,
      startedCount: batch.startedCount,
      items: items.filter((_, i) => events[i].batchId === id),
    };
  }
}
