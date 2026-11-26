import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model } from 'mongoose';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import type { MoverBatchPayload } from '@infrastructure/events/event-payloads';
import {
  getCurrentTenantId,
  withTenantContext,
} from '@infrastructure/multi-tenancy/tenant-context.helper';
import { DEFAULT_PAGE_SIZE, HR_START_CLAIM_TIMEOUT_MS } from '@infrastructure/config/defaults';
import type { IdentityDocument } from '../identity/schemas/identity.schema';
import { identityNames } from '../leavers/leaver-items';
import { MoverBatch, MoverBatchDocument, MoverBatchStatus } from './schemas/mover-batch.schema';
import {
  MoverBatchItem,
  MoverBatchItemDocument,
  MoverBatchItemStatus,
} from './schemas/mover-batch-item.schema';
import { HrMoverExecutionService, HR_MOVER_SYSTEM_ACTOR } from './hr-mover-execution.service';
import type { TriggerAttributeChange } from './hr-mover-changes';

export interface MoverBatchItemView {
  itemId: string;
  identityId: string;
  displayName: string;
  email?: string;
  /** Trigger attributes against the access baseline: as detected, or as started on approval. */
  changes: TriggerAttributeChange[];
  status: MoverBatchItemStatus;
  workflowId?: string;
  closeReason?: string;
}

export interface MoverBatchView {
  id: string;
  sourceName: string;
  status: MoverBatchStatus;
  identityCount: number;
  allowance: number;
  activeIdentityCount: number;
  fieldCounts: Record<string, number>;
  createdAt?: Date;
  decidedBy?: string;
  decidedAt?: Date;
  comment?: string;
  startedCount?: number;
  items: MoverBatchItemView[];
}

type StoredBatch = MoverBatch & { _id: unknown; createdAt?: Date };
type StoredItem = MoverBatchItem & { _id: unknown };
type ItemOutcome = Pick<MoverBatchItem, 'status' | 'workflowId' | 'closeReason'> & {
  changes?: TriggerAttributeChange[];
};

const ALREADY_RUNNING =
  'A mover run for the identity was already in progress; the next HR sync checks it again.';

/**
 * Paused HR mover batches: list them for the current tenant, approve (start each member's mover
 * run with its current changes, after the answer) or reject (close them; the same changes are
 * not raised again). The actor is the authenticated user; every decision is a domain event, so
 * it is audited.
 */
@Injectable()
export class HrMoverBatchService {
  private readonly logger = new Logger(HrMoverBatchService.name);

  constructor(
    @InjectModel(MoverBatch.name) private readonly batchModel: Model<MoverBatchDocument>,
    @InjectModel(MoverBatchItem.name) private readonly itemModel: Model<MoverBatchItemDocument>,
    @InjectModel('Identity') private readonly identityModel: Model<IdentityDocument>,
    private readonly execution: HrMoverExecutionService,
    private readonly eventEmitter: DomainEventEmitterService,
  ) {}

  /** Newest batches first, with their members. */
  async list(status?: MoverBatchStatus): Promise<MoverBatchView[]> {
    const tenantId = getCurrentTenantId();
    const batches = (await this.batchModel
      .find({ tenantId, ...(status ? { status } : {}) })
      .sort({ createdAt: -1 })
      .limit(DEFAULT_PAGE_SIZE)
      .lean()
      .exec()) as unknown as StoredBatch[];
    if (batches.length === 0) return [];
    const items = (await this.itemModel
      .find({ tenantId, batchId: { $in: batches.map((b) => String(b._id)) } })
      .lean()
      .exec()) as unknown as StoredItem[];
    const views = await this.itemViews(tenantId, items);
    return batches.map((b) => this.toView(b, items, views));
  }

  /**
   * Approve and answer at once: the members' mover runs start after the answer (startApproved
   * for the batch), each identity read again, so the run applies its changes as they are then; a
   * member with nothing left to change, gone, or being offboarded is closed as superseded.
   */
  async approve(batchId: string, actor: string, comment?: string): Promise<MoverBatchView> {
    const tenantId = getCurrentTenantId();
    const batch = await this.decide(tenantId, batchId, 'approved', actor, comment);
    await this.itemModel
      .updateMany({ tenantId, batchId, status: 'pending-approval' }, { $set: { decidedBy: actor } })
      .exec();

    // The decision; the batch's startedCount is written when the runs have started
    this.eventEmitter.emit<MoverBatchPayload>(
      DomainEventType.MOVER_BATCH_APPROVED,
      batchId,
      {
        batchId,
        sourceName: batch.sourceName,
        identityCount: batch.identityCount,
        ...(comment ? { comment } : {}),
      },
      { tenantId, actor },
    );
    // The answer shows the members pending, before any start
    const view = await this.getView(tenantId, batchId);
    void Promise.resolve(
      withTenantContext(tenantId, () => this.startApproved(tenantId, { batchId }), { actor }),
    ).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`[HrMover] Mover run starts of batch ${batchId} failed: ${message}`);
    });
    return view;
  }

  /**
   * Starts the pending items of approved batches outside the approval request: of `batchId`
   * (after its approval answered), or of every approved batch of `sourceName` (the source's next
   * full sync finishes what an approval run left, e.g. when its process stopped). Each item is
   * claimed first (claimedAt, abandoned after HR_START_CLAIM_TIMEOUT_MS), so two runs never both
   * start it, and started as its approver (decidedBy). A start that fails or times out closes the
   * item `failed`; the next sync detects the change again. Writes each touched batch's
   * startedCount. Returns how many runs started.
   */
  async startApproved(
    tenantId: string,
    scope: { batchId: string } | { sourceName: string },
  ): Promise<number> {
    const batchIds =
      'batchId' in scope
        ? [scope.batchId]
        : (
            await this.batchModel
              .find({ tenantId, sourceName: scope.sourceName, status: 'approved' })
              .select('_id')
              .lean()
              .exec()
          ).map((b) => String(b._id));
    if (batchIds.length === 0) return 0;
    const pending = { tenantId, batchId: { $in: batchIds }, status: 'pending-approval' };
    const ids = (await this.itemModel.find(pending).select('_id').lean().exec()).map((i) =>
      String(i._id),
    );
    let started = 0;
    const touched = new Set<string>('batchId' in scope ? batchIds : []);
    for (const id of ids) {
      const staleBefore = new Date(Date.now() - HR_START_CLAIM_TIMEOUT_MS);
      const item = (await this.itemModel
        .findOneAndUpdate(
          {
            ...pending,
            _id: id,
            $or: [{ claimedAt: null }, { claimedAt: { $lt: staleBefore } }],
          },
          { $set: { claimedAt: new Date() } },
          { new: true },
        )
        .lean()
        .exec()) as unknown as StoredItem | null;
      if (!item) continue;
      const outcome = await this.startMember(
        tenantId,
        item,
        item.decidedBy ?? HR_MOVER_SYSTEM_ACTOR,
      );
      if (outcome.status === 'started') started++;
      touched.add(item.batchId);
      await this.itemModel
        .updateOne(
          { _id: id, tenantId },
          { $set: { ...outcome, open: false }, $unset: { claimedAt: 1 } },
        )
        .exec();
    }
    for (const batchId of touched) {
      const startedCount = await this.itemModel
        .countDocuments({ tenantId, batchId, status: 'started' })
        .exec();
      await this.batchModel
        .updateOne({ _id: batchId, tenantId }, { $set: { startedCount } })
        .exec();
    }
    return started;
  }

  async reject(batchId: string, actor: string, comment?: string): Promise<MoverBatchView> {
    const tenantId = getCurrentTenantId();
    const batch = await this.decide(tenantId, batchId, 'rejected', actor, comment);
    await this.itemModel
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
    this.eventEmitter.emit<MoverBatchPayload>(
      DomainEventType.MOVER_BATCH_REJECTED,
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

  private async startMember(
    tenantId: string,
    item: StoredItem,
    actor: string,
  ): Promise<ItemOutcome> {
    const current = await this.execution.currentCandidate(tenantId, item.identityId);
    if ('reason' in current) return { status: 'superseded', closeReason: current.reason };
    const result = await this.execution.start(tenantId, current.candidate, actor);
    switch (result.outcome) {
      case 'started':
        return {
          status: 'started',
          workflowId: result.workflowId,
          changes: current.candidate.changes,
        };
      case 'already-running':
        return { status: 'superseded', closeReason: ALREADY_RUNNING };
      case 'failed':
        return { status: 'failed', closeReason: `The mover run did not start: ${result.error}` };
    }
  }

  /** Move a pending batch to its decision; only one decision ever wins. */
  private async decide(
    tenantId: string,
    batchId: string,
    status: 'approved' | 'rejected',
    actor: string,
    comment?: string,
  ): Promise<StoredBatch> {
    if (!isValidObjectId(batchId)) throw new NotFoundException('Mover batch not found');
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
    if (!exists) throw new NotFoundException('Mover batch not found');
    throw new ConflictException('Mover batch was already decided');
  }

  private async getView(tenantId: string, batchId: string): Promise<MoverBatchView> {
    const batch = (await this.batchModel
      .findOne({ _id: batchId, tenantId })
      .lean()
      .exec()) as unknown as StoredBatch | null;
    if (!batch) throw new NotFoundException('Mover batch not found');
    const items = (await this.itemModel
      .find({ tenantId, batchId })
      .lean()
      .exec()) as unknown as StoredItem[];
    return this.toView(batch, items, await this.itemViews(tenantId, items));
  }

  /** The items as page rows, index by index (name and email read from the identity). */
  private async itemViews(tenantId: string, items: StoredItem[]): Promise<MoverBatchItemView[]> {
    const names = await identityNames(
      this.identityModel,
      tenantId,
      items.map((i) => i.identityId),
    );
    return items.map((i) => ({
      itemId: String(i._id),
      identityId: i.identityId,
      displayName: names.get(i.identityId)?.displayName ?? i.identityId,
      email: names.get(i.identityId)?.email,
      changes: i.changes,
      status: i.status,
      workflowId: i.workflowId,
      closeReason: i.closeReason,
    }));
  }

  private toView(
    batch: StoredBatch,
    items: StoredItem[],
    views: MoverBatchItemView[],
  ): MoverBatchView {
    const id = String(batch._id);
    return {
      id,
      sourceName: batch.sourceName,
      status: batch.status,
      identityCount: batch.identityCount,
      allowance: batch.allowance,
      activeIdentityCount: batch.activeIdentityCount,
      fieldCounts: batch.fieldCounts ?? {},
      createdAt: batch.createdAt,
      decidedBy: batch.decidedBy,
      decidedAt: batch.decidedAt,
      comment: batch.comment,
      startedCount: batch.startedCount,
      items: views.filter((_, i) => items[i].batchId === id),
    };
  }
}
