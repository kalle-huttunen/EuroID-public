import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { UserStatus } from '@shared/dtos/standard-user.dto';
import type { LeaverSyncSummary } from '@shared/interfaces/leaver-sync';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import type {
  HrSyncCompletedPayload,
  LeaverBatchPayload,
  LeaverDetectedPayload,
  LeaverReason,
} from '@infrastructure/events/event-payloads';
import type { IdentityDocument } from '../identity/schemas/identity.schema';
import { HrSyncRun, HrSyncRunDocument } from './schemas/hr-sync-run.schema';
import { LeaverBatch, LeaverBatchDocument } from './schemas/leaver-batch.schema';
import { LeaverEvent, LeaverEventDocument } from './schemas/leaver-event.schema';
import { LeaverPolicyService } from './leaver-policy.service';
import { LeaverExecutionService } from './leaver-execution.service';
import type { LeaverPolicySettings } from './leaver-policy.defaults';
import {
  evaluateLeaverSignal,
  leaverEventKey,
  massLeaverAllowance,
  type LeaverCandidate,
  type LeaverSignal,
} from './leaver-signals';

/** The projected identity fields detection reads. */
interface IdentityForDetection {
  _id: unknown;
  /** rehiredAt: when the Hub last revived the identity as a rehire (IdentityDeletedMatchService) */
  metadata?: { primaryHrSource?: string; rehiredAt?: Date | string };
  sources?: Array<{
    sourceName: string;
    lastSync?: Date;
    rawData?: {
      status?: string;
      endDate?: Date | string;
      customAttributes?: { hrStatus?: string };
    };
  }>;
}

interface DetectedLeaver {
  identityId: string;
  signal: LeaverSignal;
  eventKey: string;
}

function toDate(value: Date | string | undefined): Date | undefined {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * The source decides about an identity only when it is the identity's primary HR source; with no
 * primary HR resolved (no reconciliation config), when the identity was created from it.
 */
export function isAuthoritativeSource(identity: IdentityForDetection, sourceName: string): boolean {
  const primary = identity.metadata?.primaryHrSource;
  if (primary) return primary === sourceName;
  return identity.sources?.[0]?.sourceName === sourceName;
}

/**
 * Leaver detection for one HR sync run of one tenant (the tenant comes from the sync's context,
 * passed in by LeaverSyncHandler). Records the run, finds leavers among the identities the source
 * is authoritative for, and either starts their offboarding or, above the mass-leaver limit,
 * pauses them all in a batch for an admin. See ../docs/ARCHITECTURE.md.
 */
@Injectable()
export class LeaverDetectionService {
  private readonly logger = new Logger(LeaverDetectionService.name);

  constructor(
    @InjectModel('Identity') private readonly identityModel: Model<IdentityDocument>,
    @InjectModel(HrSyncRun.name) private readonly runModel: Model<HrSyncRunDocument>,
    @InjectModel(LeaverEvent.name) private readonly eventModel: Model<LeaverEventDocument>,
    @InjectModel(LeaverBatch.name) private readonly batchModel: Model<LeaverBatchDocument>,
    private readonly policyService: LeaverPolicyService,
    private readonly execution: LeaverExecutionService,
    private readonly eventEmitter: DomainEventEmitterService,
  ) {}

  async evaluateSync(tenantId: string, run: HrSyncCompletedPayload): Promise<LeaverSyncSummary> {
    const { sourceName } = run;
    const fullSync = run.fetched > 0 && run.skipped === 0 && run.errorCount === 0;
    const startedAt = new Date(run.startedAt);
    await this.runModel.create({
      ...run,
      tenantId,
      startedAt,
      completedAt: new Date(run.completedAt),
      full: fullSync,
    });

    const policy = await this.policyService.getPolicy();
    const missingCutoff = fullSync
      ? await this.missingCutoff(tenantId, sourceName, policy)
      : undefined;
    const found = await this.findLeavers(tenantId, sourceName, policy, missingCutoff);
    const leavers = await this.withoutKnownEvents(tenantId, found);

    const summary: LeaverSyncSummary = {
      kind: 'leaver-sync-summary',
      sourceName,
      fullSync,
      detected: leavers.length,
      started: 0,
    };
    if (leavers.length > 0) {
      const activeIdentityCount = await this.identityModel
        .countDocuments({
          tenantId,
          deletedAt: null,
          'profile.status': { $nin: [UserStatus.TERMINATED, UserStatus.DELETED] },
        })
        .exec();
      const allowance = massLeaverAllowance(policy, activeIdentityCount);
      if (leavers.length > allowance) {
        summary.pausedBatchId = await this.pause(
          tenantId,
          sourceName,
          leavers,
          allowance,
          activeIdentityCount,
        );
      } else {
        await this.record(tenantId, sourceName, leavers, 'queued');
      }
    }
    // Starts this run's leavers, and retries earlier starts of this source that failed.
    summary.started = await this.execution.startQueued(tenantId, { sourceName });
    this.logger.log(
      `[Leavers] ${sourceName}: full=${fullSync} detected=${summary.detected} ` +
        `started=${summary.started}${summary.pausedBatchId ? ' (paused for approval)' : ''}`,
    );
    return summary;
  }

  /** Start of the oldest of the source's last `missingSyncThreshold` full runs (this one included). */
  private async missingCutoff(
    tenantId: string,
    sourceName: string,
    policy: LeaverPolicySettings,
  ): Promise<Date | undefined> {
    const runs = await this.runModel
      .find({ tenantId, sourceName, full: true })
      .sort({ startedAt: -1 })
      .limit(policy.missingSyncThreshold)
      .select('startedAt')
      .lean()
      .exec();
    return runs.length >= policy.missingSyncThreshold
      ? runs[policy.missingSyncThreshold - 1].startedAt
      : undefined;
  }

  private async findLeavers(
    tenantId: string,
    sourceName: string,
    policy: LeaverPolicySettings,
    missingCutoff: Date | undefined,
  ): Promise<DetectedLeaver[]> {
    const identities = (await this.identityModel
      .find({ tenantId, deletedAt: null, 'sources.sourceName': sourceName })
      .select({
        'metadata.primaryHrSource': 1,
        'metadata.rehiredAt': 1,
        'sources.sourceName': 1,
        'sources.lastSync': 1,
        'sources.rawData.status': 1,
        'sources.rawData.endDate': 1,
        'sources.rawData.customAttributes.hrStatus': 1,
      })
      .lean()
      .exec()) as unknown as IdentityForDetection[];

    const now = new Date();
    const leavers: DetectedLeaver[] = [];
    for (const identity of identities) {
      if (!isAuthoritativeSource(identity, sourceName)) continue;
      const source = identity.sources?.find((s) => s.sourceName === sourceName);
      if (!source) continue;
      const raw = source.rawData ?? {};
      const candidate: LeaverCandidate = {
        hrStatus: raw.customAttributes?.hrStatus ?? raw.status,
        endDate: toDate(raw.endDate),
        lastSeen: toDate(source.lastSync),
      };
      const signal = evaluateLeaverSignal(candidate, policy, { now, missingCutoff });
      if (signal) {
        leavers.push({
          identityId: String(identity._id),
          signal,
          eventKey: leaverEventKey(sourceName, signal, toDate(identity.metadata?.rehiredAt)),
        });
      }
    }
    return leavers;
  }

  /** Drop identities with an open leaver event, and evidence already raised (whatever became of it). */
  private async withoutKnownEvents(
    tenantId: string,
    found: DetectedLeaver[],
  ): Promise<DetectedLeaver[]> {
    if (found.length === 0) return [];
    const known = await this.eventModel
      .find({
        tenantId,
        identityId: { $in: found.map((l) => l.identityId) },
        $or: [{ open: true }, { eventKey: { $in: found.map((l) => l.eventKey) } }],
      })
      .select('identityId eventKey open')
      .lean()
      .exec();
    const openIdentities = new Set(known.filter((e) => e.open).map((e) => e.identityId));
    const knownKeys = new Set(known.map((e) => `${e.identityId}|${e.eventKey}`));
    return found.filter(
      (l) => !openIdentities.has(l.identityId) && !knownKeys.has(`${l.identityId}|${l.eventKey}`),
    );
  }

  private async pause(
    tenantId: string,
    sourceName: string,
    leavers: DetectedLeaver[],
    allowance: number,
    activeIdentityCount: number,
  ): Promise<string> {
    const reasonCounts: Partial<Record<LeaverReason, number>> = {};
    for (const l of leavers)
      reasonCounts[l.signal.reason] = (reasonCounts[l.signal.reason] ?? 0) + 1;
    const batch = await this.batchModel.create({
      tenantId,
      sourceName,
      status: 'pending',
      identityCount: leavers.length,
      allowance,
      activeIdentityCount,
      reasonCounts,
    });
    const batchId = String(batch._id);
    await this.record(tenantId, sourceName, leavers, 'pending-approval', batchId);
    this.eventEmitter.emit<LeaverBatchPayload>(
      DomainEventType.LEAVER_BATCH_PAUSED,
      batchId,
      { batchId, sourceName, identityCount: leavers.length, limit: allowance, activeIdentityCount },
      { tenantId },
    );
    return batchId;
  }

  /** Store one leaver event per identity and report each as detected (timeline + audit). */
  private async record(
    tenantId: string,
    sourceName: string,
    leavers: DetectedLeaver[],
    status: 'queued' | 'pending-approval',
    batchId?: string,
  ): Promise<void> {
    const detectedAt = new Date();
    for (const leaver of leavers) {
      let eventId: string;
      try {
        const doc = await this.eventModel.create({
          tenantId,
          identityId: leaver.identityId,
          sourceName,
          reason: leaver.signal.reason,
          eventKey: leaver.eventKey,
          effectiveDate: leaver.signal.effectiveDate,
          status,
          open: true,
          batchId,
          detectedAt,
        });
        eventId = String(doc._id);
      } catch (err: unknown) {
        // A concurrent run raised it first (unique per identity and evidence, one open per identity).
        if ((err as { code?: number }).code === 11000) continue;
        throw err;
      }
      this.eventEmitter.emit<LeaverDetectedPayload>(
        DomainEventType.LEAVER_DETECTED,
        leaver.identityId,
        {
          identityId: leaver.identityId,
          leaverEventId: eventId,
          reason: leaver.signal.reason,
          sourceName,
          ...(leaver.signal.effectiveDate
            ? { effectiveDate: leaver.signal.effectiveDate.toISOString() }
            : {}),
          paused: status === 'pending-approval',
          ...(batchId ? { batchId } : {}),
        },
        { tenantId },
      );
    }
  }
}
