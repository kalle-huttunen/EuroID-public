import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { UserStatus } from '@shared/dtos/standard-user.dto';
import type { JoinerSyncSummary } from '@shared/interfaces/joiner-sync';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import type {
  HrSyncCompletedPayload,
  JoinerBatchPayload,
} from '@infrastructure/events/event-payloads';
import type { IdentityDocument } from '../identity/schemas/identity.schema';
import { PipelineService } from '../blueprints/pipeline.service';
import { PipelineStatus } from '../blueprints/schemas/blueprint.schema';
import { JoinerBatch, JoinerBatchDocument } from './schemas/joiner-batch.schema';
import { JoinerEvent, JoinerEventDocument } from './schemas/joiner-event.schema';
import { JoinerSource, JoinerSourceDocument } from './schemas/joiner-source.schema';
import { JoinerPolicyService } from './joiner-policy.service';
import { massJoinerAllowance } from './joiner-policy.defaults';
import {
  HR_JOINER_SYSTEM_ACTOR,
  JoinerExecutionService,
  type StoredJoinerEvent,
} from './joiner-execution.service';

type Due = { event: StoredJoinerEvent };

/**
 * HR joiner detection for one HR sync run of one tenant (the tenant is the sync's context, passed
 * in by JoinerSyncHandler). Every run records the identities minted from its source as waiting
 * joiners (joiner_sources remembers how far, so a run whose detection failed loses nobody). A full
 * run then looks at every waiting joiner of its source: one that left, is gone or was onboarded
 * otherwise is closed; one that is due starts its onboarding, but only while the tenant's pipeline
 * is DEPLOYED, and above the tenant's mass-joiner limit none starts: they wait in a batch for an
 * admin. See ../docs/ARCHITECTURE.md.
 */
@Injectable()
export class JoinerDetectionService {
  private readonly logger = new Logger(JoinerDetectionService.name);

  constructor(
    @InjectModel('Identity') private readonly identityModel: Model<IdentityDocument>,
    @InjectModel(JoinerEvent.name) private readonly eventModel: Model<JoinerEventDocument>,
    @InjectModel(JoinerBatch.name) private readonly batchModel: Model<JoinerBatchDocument>,
    @InjectModel(JoinerSource.name) private readonly sourceModel: Model<JoinerSourceDocument>,
    private readonly policyService: JoinerPolicyService,
    private readonly execution: JoinerExecutionService,
    private readonly pipeline: PipelineService,
    private readonly eventEmitter: DomainEventEmitterService,
  ) {}

  async evaluateSync(tenantId: string, run: HrSyncCompletedPayload): Promise<JoinerSyncSummary> {
    const { sourceName } = run;
    const fullSync = run.fetched > 0 && run.skipped === 0 && run.errorCount === 0;
    const startedAt = new Date(run.startedAt);
    const summary: JoinerSyncSummary = {
      kind: 'joiner-sync-summary',
      sourceName,
      fullSync,
      detected: await this.recordMinted(tenantId, sourceName, startedAt),
      started: 0,
      pending: 0,
      waiting: 0,
      startFailed: 0,
      closed: 0,
    };

    if (!fullSync) {
      // A partial run may carry a broken feed: it onboards nobody, its joiners wait.
      summary.waiting = await this.eventModel
        .countDocuments({ tenantId, sourceName, status: 'waiting' })
        .exec();
      this.log(summary);
      return summary;
    }

    const due = await this.dueJoiners(tenantId, sourceName, startedAt, summary);
    const pipelineStatus = await this.pipeline.getPipelineStatus(tenantId);
    summary.pipelineStatus = pipelineStatus;
    if (due.length > 0 && pipelineStatus !== PipelineStatus.DEPLOYED) {
      // Not deployed, paused or stopped: nothing starts, the next full sync looks again.
      summary.waiting += due.length;
    } else if (due.length > 0) {
      const policy = await this.policyService.getPolicy();
      const activeIdentityCount = await this.identityModel
        .countDocuments({
          tenantId,
          deletedAt: null,
          'profile.status': { $nin: [UserStatus.TERMINATED, UserStatus.DELETED] },
        })
        .exec();
      const allowance = massJoinerAllowance(policy, activeIdentityCount);
      if (due.length > allowance) {
        summary.pending = due.length;
        summary.pausedBatchId = await this.pause(
          tenantId,
          sourceName,
          due,
          allowance,
          activeIdentityCount,
        );
      } else {
        for (const { event } of due) {
          const result = await this.execution.start(tenantId, event, HR_JOINER_SYSTEM_ACTOR);
          if (result.outcome === 'started') summary.started++;
          else if (result.outcome === 'already-running') summary.closed++;
          else {
            summary.startFailed++;
            summary.waiting++;
          }
        }
      }
    }
    this.log(summary);
    return summary;
  }

  /**
   * Store a waiting joiner for each identity minted from this source (`sources[0]`, the source it
   * was created from) or revived by it as a rehire (identity metadata.rehiredFrom), not deleted,
   * created or rehired since the source's previous recording, or since this run started for a
   * source recorded for the first time. One joiner per identity and hire.
   */
  private async recordMinted(
    tenantId: string,
    sourceName: string,
    startedAt: Date,
  ): Promise<number> {
    const recordedAt = new Date();
    const cursor = await this.sourceModel.findOne({ tenantId, sourceName }).lean().exec();
    const since = cursor?.recordedUntil ?? startedAt;
    const joined = (await this.identityModel
      .find({
        tenantId,
        deletedAt: null,
        $or: [
          { createdAt: { $gte: since }, 'sources.0.sourceName': sourceName },
          { 'metadata.rehiredAt': { $gte: since }, 'metadata.rehiredFrom': sourceName },
        ],
      })
      .select({ _id: 1, 'metadata.rehiredAt': 1, 'metadata.rehiredFrom': 1 })
      .lean()
      .exec()) as Array<{ _id: unknown; metadata?: { rehiredAt?: Date; rehiredFrom?: string } }>;
    const recorded = await this.recordJoiners(
      tenantId,
      sourceName,
      joined.map((i) => ({
        identityId: String(i._id),
        // A rehire by this source since the cursor: a new hire of the identity
        ...(i.metadata?.rehiredFrom === sourceName &&
        i.metadata.rehiredAt &&
        i.metadata.rehiredAt >= since
          ? { rehiredAt: i.metadata.rehiredAt }
          : {}),
      })),
    );
    await this.sourceModel
      .updateOne(
        { tenantId, sourceName },
        { $set: { recordedUntil: recordedAt } },
        { upsert: true },
      )
      .exec();
    return recorded;
  }

  /** `rehiredAt` is set for a rehire, whose earlier hire may have a joiner of its own. */
  private async recordJoiners(
    tenantId: string,
    sourceName: string,
    joiners: Array<{ identityId: string; rehiredAt?: Date }>,
  ): Promise<number> {
    if (joiners.length === 0) return 0;
    const minted = joiners.filter((j) => !j.rehiredAt).map((j) => j.identityId);
    const known = new Set(
      (
        await this.eventModel
          .distinct('identityId', { tenantId, identityId: { $in: minted } })
          .exec()
      ).map(String),
    );
    const detectedAt = new Date();
    let recorded = 0;
    for (const { identityId, rehiredAt } of joiners) {
      if (!rehiredAt && known.has(identityId)) continue;
      if (rehiredAt) {
        // A joiner of the earlier hire still open (deleted before it started) never starts now
        await this.eventModel
          .updateMany(
            { tenantId, identityId, open: true, rehiredAt: { $ne: rehiredAt } },
            {
              $set: {
                status: 'superseded',
                open: false,
                closeReason:
                  'The identity was deleted and rehired: a new joiner replaces this one.',
              },
            },
          )
          .exec();
      }
      try {
        await this.eventModel.create({
          tenantId,
          identityId,
          sourceName,
          ...(rehiredAt ? { rehiredAt } : {}),
          status: 'waiting',
          open: true,
          detectedAt,
        });
        recorded++;
      } catch (err: unknown) {
        // Recorded already: re-ingesting the same rehire, or a concurrent sync of another source
        // came first (one joiner per identity and hire).
        if ((err as { code?: number }).code === 11000) continue;
        throw err;
      }
    }
    return recorded;
  }

  /**
   * Check every waiting joiner of the source: close the ones that will never start, count the ones
   * still waiting, and return the due ones.
   */
  private async dueJoiners(
    tenantId: string,
    sourceName: string,
    startedAt: Date,
    summary: JoinerSyncSummary,
  ): Promise<Due[]> {
    const waiting = (await this.eventModel
      .find({ tenantId, sourceName, status: 'waiting' })
      .sort({ detectedAt: 1, _id: 1 })
      .lean()
      .exec()) as unknown as StoredJoinerEvent[];
    if (waiting.length === 0) return [];
    const settings = await this.execution.ruleSettings();
    const due: Due[] = [];
    for (const event of waiting) {
      const state = await this.execution.check(tenantId, event, settings, startedAt);
      if ('close' in state) {
        await this.execution.close(tenantId, String(event._id), 'superseded', state.close);
        summary.closed++;
      } else if ('wait' in state) {
        await this.execution.noteWait(tenantId, event, state.wait);
        summary.waiting++;
      } else {
        due.push({ event });
      }
    }
    return due;
  }

  private async pause(
    tenantId: string,
    sourceName: string,
    due: Due[],
    allowance: number,
    activeIdentityCount: number,
  ): Promise<string> {
    const batch = await this.batchModel.create({
      tenantId,
      sourceName,
      status: 'pending',
      identityCount: due.length,
      allowance,
      activeIdentityCount,
    });
    const batchId = String(batch._id);
    await this.eventModel
      .updateMany(
        { tenantId, _id: { $in: due.map((d) => String(d.event._id)) }, status: 'waiting' },
        { $set: { status: 'pending-approval', batchId }, $unset: { startError: 1 } },
      )
      .exec();
    this.eventEmitter.emit<JoinerBatchPayload>(
      DomainEventType.JOINER_BATCH_PAUSED,
      batchId,
      { batchId, sourceName, identityCount: due.length, limit: allowance, activeIdentityCount },
      { tenantId },
    );
    return batchId;
  }

  private log(summary: JoinerSyncSummary): void {
    this.logger.log(
      `[Joiners] ${summary.sourceName}: full=${summary.fullSync} detected=${summary.detected} ` +
        `started=${summary.started} pending=${summary.pending} waiting=${summary.waiting} ` +
        `startFailed=${summary.startFailed} closed=${summary.closed}` +
        (summary.pipelineStatus ? ` pipeline=${summary.pipelineStatus}` : '') +
        (summary.pausedBatchId ? ' (paused for approval)' : ''),
    );
  }
}
