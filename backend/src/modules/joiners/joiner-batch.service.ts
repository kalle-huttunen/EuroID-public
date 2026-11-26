import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model } from 'mongoose';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import type { JoinerBatchPayload } from '@infrastructure/events/event-payloads';
import {
  getCurrentTenantId,
  withTenantContext,
} from '@infrastructure/multi-tenancy/tenant-context.helper';
import { DEFAULT_PAGE_SIZE } from '@infrastructure/config/defaults';
import type { IdentityDocument } from '../identity/schemas/identity.schema';
import { PipelineService } from '../blueprints/pipeline.service';
import { PipelineStatus } from '../blueprints/schemas/blueprint.schema';
import { JoinerBatch, JoinerBatchDocument, JoinerBatchStatus } from './schemas/joiner-batch.schema';
import { JoinerEvent, JoinerEventDocument, JoinerEventStatus } from './schemas/joiner-event.schema';
import { JoinerExecutionService, type StoredJoinerEvent } from './joiner-execution.service';

export interface JoinerBatchItemView {
  joinerEventId: string;
  identityId: string;
  displayName: string;
  email?: string;
  departmentName?: string;
  jobTitle?: string;
  status: JoinerEventStatus;
  workflowId?: string;
  /** Why it closed without an onboarding (superseded, rejected). */
  closeReason?: string;
  /** The approval could not start it; it waits for the source's next full sync. */
  startError?: string;
}

export interface JoinerBatchView {
  id: string;
  sourceName: string;
  status: JoinerBatchStatus;
  identityCount: number;
  allowance: number;
  activeIdentityCount: number;
  createdAt?: Date;
  decidedBy?: string;
  decidedAt?: Date;
  comment?: string;
  startedCount?: number;
  items: JoinerBatchItemView[];
}

type StoredBatch = JoinerBatch & { _id: unknown };
type Profile = {
  firstName?: string;
  lastName?: string;
  displayName?: string;
  email?: string;
  departmentName?: string;
  jobTitle?: string;
};

/**
 * Paused HR joiner batches: list them for the current tenant, approve (start each member's
 * onboarding after the answer, read again first) or reject (close them; the joiner path never
 * onboards them). The actor is the authenticated user; every decision is a domain event, so it
 * is audited.
 */
@Injectable()
export class JoinerBatchService {
  private readonly logger = new Logger(JoinerBatchService.name);

  constructor(
    @InjectModel(JoinerBatch.name) private readonly batchModel: Model<JoinerBatchDocument>,
    @InjectModel(JoinerEvent.name) private readonly eventModel: Model<JoinerEventDocument>,
    @InjectModel('Identity') private readonly identityModel: Model<IdentityDocument>,
    private readonly execution: JoinerExecutionService,
    private readonly pipeline: PipelineService,
    private readonly eventEmitter: DomainEventEmitterService,
  ) {}

  /** Newest batches first, with their members. */
  async list(status?: JoinerBatchStatus): Promise<JoinerBatchView[]> {
    const tenantId = getCurrentTenantId();
    const batches = (await this.batchModel
      .find({ tenantId, ...(status ? { status } : {}) })
      .sort({ createdAt: -1 })
      .limit(DEFAULT_PAGE_SIZE)
      .lean()
      .exec()) as unknown as StoredBatch[];
    if (batches.length === 0) return [];
    const events = (await this.eventModel
      .find({ tenantId, batchId: { $in: batches.map((b) => String(b._id)) } })
      .lean()
      .exec()) as unknown as StoredJoinerEvent[];
    const items = await this.itemViews(tenantId, events);
    return batches.map((b) => this.toView(b, events, items));
  }

  /**
   * Approve and answer at once: the members become waiting joiners (the state the source's next
   * full sync starts), and their onboardings start after the answer (startAfterAnswer). Refused
   * (409) while the tenant's pipeline is not DEPLOYED.
   */
  async approve(batchId: string, actor: string, comment?: string): Promise<JoinerBatchView> {
    const tenantId = getCurrentTenantId();
    const pipelineStatus = await this.pipeline.getPipelineStatus(tenantId);
    if (pipelineStatus !== PipelineStatus.DEPLOYED) {
      await this.getView(tenantId, batchId); // 404 for an unknown batch
      throw new ConflictException(
        `The pipeline is ${pipelineStatus}: deploy or resume it before approving joiners`,
      );
    }
    const batch = await this.decide(tenantId, batchId, 'approved', actor, comment);
    await this.eventModel
      .updateMany(
        { tenantId, batchId, status: 'pending-approval' },
        { $set: { status: 'waiting', decidedBy: actor } },
      )
      .exec();

    // The decision; each onboarding start is its own identity.joiner_onboarding_started
    this.eventEmitter.emit<JoinerBatchPayload>(
      DomainEventType.JOINER_BATCH_APPROVED,
      batchId,
      {
        batchId,
        sourceName: batch.sourceName,
        identityCount: batch.identityCount,
        ...(comment ? { comment } : {}),
      },
      { tenantId, actor },
    );
    // The answer shows the members waiting, before any start
    const view = await this.getView(tenantId, batchId);
    this.startAfterAnswer(tenantId, batchId, actor);
    return view;
  }

  /**
   * Starts the approved batch's members outside the approval request: with Temporal slow or down
   * every start waits up to its timeout, which held the approval for minutes. Each member is read
   * again: one who left in HR, was deleted or was onboarded otherwise since the pause is closed
   * as superseded, one that is not active keeps waiting, and a failed start keeps waiting with
   * startError. The source's next full sync looks at every one still waiting, also when this
   * process stops midway. Records how many this run started.
   */
  private startAfterAnswer(tenantId: string, batchId: string, actor: string): void {
    const run = async () => {
      const ids = (
        await this.eventModel
          .find({ tenantId, batchId, status: 'waiting' })
          .sort({ detectedAt: 1, _id: 1 })
          .select('_id')
          .lean()
          .exec()
      ).map((e) => String(e._id));
      const settings = await this.execution.ruleSettings();
      let started = 0;
      for (const id of ids) {
        // Read again: a full sync of the source may have handled it meanwhile
        const member = (await this.eventModel
          .findOne({ _id: id, tenantId, status: 'waiting' })
          .lean()
          .exec()) as unknown as StoredJoinerEvent | null;
        if (!member) continue;
        const state = await this.execution.check(tenantId, member, settings);
        if ('close' in state) {
          await this.execution.close(tenantId, String(member._id), 'superseded', state.close);
        } else if ('wait' in state) {
          await this.execution.noteWait(tenantId, member, state.wait);
        } else if ((await this.execution.start(tenantId, member, actor)).outcome === 'started') {
          started++;
        }
      }
      await this.batchModel
        .updateOne({ _id: batchId, tenantId }, { $set: { startedCount: started } })
        .exec();
    };
    void Promise.resolve(withTenantContext(tenantId, run, { actor })).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`[Joiners] Onboarding starts of batch ${batchId} failed: ${message}`);
    });
  }

  async reject(batchId: string, actor: string, comment?: string): Promise<JoinerBatchView> {
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
    this.eventEmitter.emit<JoinerBatchPayload>(
      DomainEventType.JOINER_BATCH_REJECTED,
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
    if (!isValidObjectId(batchId)) throw new NotFoundException('Joiner batch not found');
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
    if (!exists) throw new NotFoundException('Joiner batch not found');
    throw new ConflictException('Joiner batch was already decided');
  }

  private async getView(tenantId: string, batchId: string): Promise<JoinerBatchView> {
    const batch = isValidObjectId(batchId)
      ? ((await this.batchModel
          .findOne({ _id: batchId, tenantId })
          .lean()
          .exec()) as unknown as StoredBatch | null)
      : null;
    if (!batch) throw new NotFoundException('Joiner batch not found');
    const events = (await this.eventModel
      .find({ tenantId, batchId })
      .lean()
      .exec()) as unknown as StoredJoinerEvent[];
    return this.toView(batch, events, await this.itemViews(tenantId, events));
  }

  /** The members as page rows, index by index (name, email, department, title from the identity). */
  private async itemViews(
    tenantId: string,
    events: StoredJoinerEvent[],
  ): Promise<JoinerBatchItemView[]> {
    const ids = events.map((e) => e.identityId).filter((id) => isValidObjectId(id));
    const docs = (await this.identityModel
      .find({ tenantId, _id: { $in: ids } })
      .select(
        'profile.firstName profile.lastName profile.displayName profile.email ' +
          'profile.departmentName profile.jobTitle',
      )
      .lean()
      .exec()) as Array<{ _id: unknown; profile?: Profile }>;
    const profiles = new Map(docs.map((d) => [String(d._id), d.profile ?? {}]));
    return events.map((e) => {
      const p = profiles.get(e.identityId) ?? {};
      return {
        joinerEventId: String(e._id),
        identityId: e.identityId,
        displayName:
          p.displayName || [p.firstName, p.lastName].filter(Boolean).join(' ') || e.identityId,
        email: p.email,
        departmentName: p.departmentName,
        jobTitle: p.jobTitle,
        status: e.status,
        workflowId: e.workflowId,
        closeReason: e.closeReason,
        startError: e.startError,
      };
    });
  }

  private toView(
    batch: StoredBatch,
    events: StoredJoinerEvent[],
    items: JoinerBatchItemView[],
  ): JoinerBatchView {
    const id = String(batch._id);
    const stored = batch as StoredBatch & { createdAt?: Date };
    return {
      id,
      sourceName: batch.sourceName,
      status: batch.status,
      identityCount: batch.identityCount,
      allowance: batch.allowance,
      activeIdentityCount: batch.activeIdentityCount,
      createdAt: stored.createdAt,
      decidedBy: batch.decidedBy,
      decidedAt: batch.decidedAt,
      comment: batch.comment,
      startedCount: batch.startedCount,
      items: items.filter((_, i) => events[i].batchId === id),
    };
  }
}
