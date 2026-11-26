import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { UserStatus } from '@shared/dtos/standard-user.dto';
import type { MoverSyncSummary } from '@shared/interfaces/mover-sync';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import type {
  HrSyncCompletedPayload,
  MoverBatchPayload,
} from '@infrastructure/events/event-payloads';
import type { IdentityDocument } from '../identity/schemas/identity.schema';
import { MoverBatch, MoverBatchDocument } from './schemas/mover-batch.schema';
import { MoverBatchItem, MoverBatchItemDocument } from './schemas/mover-batch-item.schema';
import { HrMoverPolicyService } from './hr-mover-policy.service';
import { HrMoverExecutionService, HR_MOVER_SYSTEM_ACTOR } from './hr-mover-execution.service';
import { HrMoverBatchService } from './hr-mover-batch.service';
import { massMoverAllowance } from './hr-mover-policy.defaults';
import {
  changeKey,
  HR_MOVER_PROJECTION,
  hrMoverCandidate,
  type HrMoverCandidate,
  type IdentityForHrMover,
} from './hr-mover-changes';

type Detected = HrMoverCandidate & { changeKey: string };

/**
 * HR mover detection for one HR sync run of one tenant (the tenant is the sync's context, passed
 * in by HrMoverSyncHandler). After a full sync, every identity the run delivered that is
 * provisioned (an account in a target system, isProvisioned) and whose trigger attributes now
 * differ from its access baseline gets a mover run, through the existing mover path. Above the
 * tenant's mass-mover limit, none starts: they wait in a batch for an admin. A full sync also
 * starts the items an approved batch of the source still has pending (an approval run that
 * stopped midway). See ../docs/ARCHITECTURE.md.
 */
@Injectable()
export class HrMoverDetectionService {
  private readonly logger = new Logger(HrMoverDetectionService.name);

  constructor(
    @InjectModel('Identity') private readonly identityModel: Model<IdentityDocument>,
    @InjectModel(MoverBatch.name) private readonly batchModel: Model<MoverBatchDocument>,
    @InjectModel(MoverBatchItem.name) private readonly itemModel: Model<MoverBatchItemDocument>,
    private readonly policyService: HrMoverPolicyService,
    private readonly execution: HrMoverExecutionService,
    private readonly eventEmitter: DomainEventEmitterService,
    private readonly batches: HrMoverBatchService,
  ) {}

  async evaluateSync(tenantId: string, run: HrSyncCompletedPayload): Promise<MoverSyncSummary> {
    const { sourceName } = run;
    const fullSync = run.fetched > 0 && run.skipped === 0 && run.errorCount === 0;
    const summary: MoverSyncSummary = {
      kind: 'mover-sync-summary',
      sourceName,
      fullSync,
      detected: 0,
      started: 0,
      alreadyRunning: 0,
      startFailed: 0,
      withoutBaseline: 0,
    };
    // A partial or empty run may carry a broken feed: it moves nobody.
    if (!fullSync) {
      this.logger.log(`[HrMover] ${sourceName}: partial sync, no mover evaluated`);
      return summary;
    }

    const found: Detected[] = [];
    for (const identity of await this.deliveredProvisioned(tenantId, run)) {
      const result = hrMoverCandidate(identity);
      if ('candidate' in result) {
        found.push({ ...result.candidate, changeKey: changeKey(result.candidate.changes) });
      } else if (result.noBaseline) {
        summary.withoutBaseline++;
      }
    }
    const movers = await this.withoutExcluded(tenantId, found);
    summary.detected = movers.length;

    if (movers.length > 0) {
      const policy = await this.policyService.getPolicy();
      const activeIdentityCount = await this.identityModel
        .countDocuments({
          tenantId,
          deletedAt: null,
          'profile.status': { $nin: [UserStatus.TERMINATED, UserStatus.DELETED] },
        })
        .exec();
      const allowance = massMoverAllowance(policy, activeIdentityCount);
      if (movers.length > allowance) {
        summary.pausedBatchId = await this.pause(
          tenantId,
          sourceName,
          movers,
          allowance,
          activeIdentityCount,
        );
      } else {
        for (const mover of movers) {
          const result = await this.execution.start(tenantId, mover, HR_MOVER_SYSTEM_ACTOR);
          if (result.outcome === 'started') summary.started++;
          else if (result.outcome === 'already-running') summary.alreadyRunning++;
          else summary.startFailed++;
        }
      }
    }
    // Approved batches of the source with items still pending: an approval run that stopped
    const leftover = await this.batches.startApproved(tenantId, { sourceName });
    if (leftover > 0) {
      this.logger.log(`[HrMover] ${sourceName}: started ${leftover} approved batch items left`);
    }
    this.logger.log(
      `[HrMover] ${sourceName}: detected=${summary.detected} started=${summary.started} ` +
        `alreadyRunning=${summary.alreadyRunning} startFailed=${summary.startFailed} ` +
        `withoutBaseline=${summary.withoutBaseline}` +
        (summary.pausedBatchId ? ' (paused for approval)' : ''),
    );
    return summary;
  }

  /**
   * Non-deleted identities this run delivered (lastSync since its start) with a provisioning
   * entry that is not DEPROVISIONED: the ones that can have an account. hrMoverCandidate then
   * applies the mover's own rule (isProvisioned).
   */
  private async deliveredProvisioned(
    tenantId: string,
    run: HrSyncCompletedPayload,
  ): Promise<IdentityForHrMover[]> {
    return (await this.identityModel
      .find({
        tenantId,
        deletedAt: null,
        provisioning: { $elemMatch: { status: { $ne: 'DEPROVISIONED' } } },
        sources: {
          $elemMatch: { sourceName: run.sourceName, lastSync: { $gte: new Date(run.startedAt) } },
        },
      })
      .select(HR_MOVER_PROJECTION)
      .lean()
      .exec()) as unknown as IdentityForHrMover[];
  }

  /**
   * Drop identities an HR leaver is offboarding, identities already waiting in a paused batch,
   * and changes an admin rejected (same identity, same change key).
   */
  private async withoutExcluded(tenantId: string, found: Detected[]): Promise<Detected[]> {
    if (found.length === 0) return [];
    const ids = found.map((m) => m.identityId);
    const offboarding = await this.execution.inOffboarding(tenantId, ids);
    const known = await this.itemModel
      .find({
        tenantId,
        identityId: { $in: ids },
        $or: [
          { open: true },
          { status: 'rejected', changeKey: { $in: found.map((m) => m.changeKey) } },
        ],
      })
      .select('identityId changeKey open')
      .lean()
      .exec();
    const waiting = new Set(known.filter((i) => i.open).map((i) => i.identityId));
    const rejected = new Set(
      known.filter((i) => !i.open).map((i) => `${i.identityId}|${i.changeKey}`),
    );
    return found.filter(
      (m) =>
        !offboarding.has(m.identityId) &&
        !waiting.has(m.identityId) &&
        !rejected.has(`${m.identityId}|${m.changeKey}`),
    );
  }

  private async pause(
    tenantId: string,
    sourceName: string,
    movers: Detected[],
    allowance: number,
    activeIdentityCount: number,
  ): Promise<string> {
    const fieldCounts: Record<string, number> = {};
    for (const m of movers) {
      for (const c of m.changes) fieldCounts[c.field] = (fieldCounts[c.field] ?? 0) + 1;
    }
    const batch = await this.batchModel.create({
      tenantId,
      sourceName,
      status: 'pending',
      identityCount: movers.length,
      allowance,
      activeIdentityCount,
      fieldCounts,
    });
    const batchId = String(batch._id);
    for (const mover of movers) {
      try {
        await this.itemModel.create({
          tenantId,
          batchId,
          identityId: mover.identityId,
          sourceName,
          changes: mover.changes,
          changeKey: mover.changeKey,
          status: 'pending-approval',
          open: true,
        });
      } catch (err: unknown) {
        // A concurrent sync of another source paused this identity first (one open item each).
        if ((err as { code?: number }).code === 11000) continue;
        throw err;
      }
    }
    this.eventEmitter.emit<MoverBatchPayload>(
      DomainEventType.MOVER_BATCH_PAUSED,
      batchId,
      { batchId, sourceName, identityCount: movers.length, limit: allowance, activeIdentityCount },
      { tenantId },
    );
    return batchId;
  }
}
