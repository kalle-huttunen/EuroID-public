import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/common';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import type {
  IdentityOffboardRequestedPayload,
  LeaverOffboardingStartedPayload,
} from '@infrastructure/events/event-payloads';
import { hrStartTimeoutMs } from '@infrastructure/config/defaults';
import { withTimeout } from '@shared/utils/with-timeout';
import type { IdentityDocument } from '../identity/schemas/identity.schema';
import { LeaverEvent, LeaverEventDocument } from './schemas/leaver-event.schema';
import { OffboardingRecord, OffboardingRecordDocument } from './schemas/offboarding-record.schema';

/** A claim older than this is treated as abandoned (its process died mid-start). */
const CLAIM_TIMEOUT_MS = parseInt(process.env.LEAVER_START_CLAIM_TIMEOUT_MS ?? '600000', 10);

/** Who starts leaver offboardings when no person does (a sync run). */
export const LEAVER_SYSTEM_ACTOR = 'system:leaver-detection';

/**
 * Starts the offboarding of queued leaver events through IDENTITY_OFFBOARD_REQUESTED, the event
 * the manual DELETE /identity/:id uses, so OffboardingService starts the existing offboarding
 * workflow (deterministic id per identity). Exactly once per event: each start is claimed
 * atomically, a workflow that is already running counts as started, and a failed start stays
 * queued for the next sync. A start that does not answer within HR_START_TIMEOUT_MS counts as
 * failed, but may still land: the next try finds that workflow running (WorkflowExecution
 * AlreadyStartedError), or its offboarding record finished since the event's first attempt, and
 * counts it as the event's offboarding instead of starting a second one.
 */
@Injectable()
export class LeaverExecutionService {
  private readonly logger = new Logger(LeaverExecutionService.name);

  constructor(
    @InjectModel(LeaverEvent.name) private readonly eventModel: Model<LeaverEventDocument>,
    @InjectModel('Identity') private readonly identityModel: Model<IdentityDocument>,
    @InjectModel(OffboardingRecord.name)
    private readonly recordModel: Model<OffboardingRecordDocument>,
    private readonly eventEmitter: DomainEventEmitterService,
  ) {}

  /** Start every queued event of the tenant matching `scope`; returns how many started. */
  async startQueued(
    tenantId: string,
    scope: { sourceName?: string; batchId?: string },
    actor: string = LEAVER_SYSTEM_ACTOR,
  ): Promise<number> {
    const events = await this.eventModel
      .find({ tenantId, status: 'queued', ...scope })
      .lean()
      .exec();
    let started = 0;
    for (const event of events) {
      if (await this.startOne(tenantId, String(event._id), actor)) started++;
    }
    return started;
  }

  private async startOne(tenantId: string, eventId: string, actor: string): Promise<boolean> {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - CLAIM_TIMEOUT_MS);
    const event = await this.eventModel
      .findOneAndUpdate(
        {
          _id: eventId,
          tenantId,
          status: 'queued',
          $or: [{ claimedAt: null }, { claimedAt: { $lt: staleBefore } }],
        },
        // startAttemptedAt: the first attempt, kept over retries
        { $set: { claimedAt: now }, $min: { startAttemptedAt: now } },
        { new: true },
      )
      .lean()
      .exec();
    if (!event) return false;

    // An earlier attempt that timed out may have started an offboarding that has finished since
    // (a running one answers WorkflowExecutionAlreadyStartedError below): that is this event's.
    const landed = await this.recordModel
      .findOne({
        tenantId,
        identityId: event.identityId,
        finishedAt: { $gte: event.startAttemptedAt ?? now },
      })
      .sort({ finishedAt: -1 })
      .lean()
      .exec();
    if (landed) {
      await this.markStarted(tenantId, event, actor, landed.workflowId, landed.finishedAt);
      return true;
    }

    const identity = await this.identityModel
      .findOne({ _id: event.identityId, tenantId, deletedAt: null })
      .select('profile.email')
      .lean()
      .exec();
    const userEmail = identity?.profile?.email;
    if (!userEmail) {
      await this.close(tenantId, eventId, 'superseded', 'Identity not found or already offboarded');
      return false;
    }

    let workflowId: string;
    try {
      const ms = hrStartTimeoutMs();
      workflowId = await withTimeout(
        this.requestOffboarding(tenantId, event, actor),
        ms,
        `The offboarding start did not answer within ${ms} ms`,
      );
    } catch (err: unknown) {
      if (err instanceof WorkflowExecutionAlreadyStartedError) {
        workflowId = err.workflowId;
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`[Leavers] Offboarding start failed for ${event.identityId}: ${msg}`);
        await this.eventModel
          .updateOne(
            { _id: eventId, tenantId },
            { $set: { startError: msg }, $unset: { claimedAt: 1 } },
          )
          .exec();
        return false;
      }
    }

    await this.markStarted(tenantId, event, actor, workflowId);
    return true;
  }

  /**
   * The event's offboarding is `workflowId`; `finishedAt` when that run has already finished (a
   * start that timed out but ran).
   */
  private async markStarted(
    tenantId: string,
    event: LeaverEvent & { _id: unknown },
    actor: string,
    workflowId: string,
    finishedAt?: Date,
  ): Promise<void> {
    const eventId = String(event._id);
    await this.eventModel
      .updateOne(
        { _id: eventId, tenantId },
        {
          $set: {
            status: 'started',
            open: false,
            workflowId,
            startedAt: new Date(),
            ...(finishedAt ? { offboardingFinishedAt: finishedAt } : {}),
          },
          $unset: { claimedAt: 1, startError: 1 },
        },
      )
      .exec();
    this.eventEmitter.emit<LeaverOffboardingStartedPayload>(
      DomainEventType.LEAVER_OFFBOARDING_STARTED,
      event.identityId,
      {
        identityId: event.identityId,
        leaverEventId: eventId,
        reason: event.reason,
        workflowId,
        ...(event.batchId ? { batchId: event.batchId } : {}),
      },
      { tenantId, actor },
    );
  }

  private async requestOffboarding(
    tenantId: string,
    event: LeaverEvent,
    actor: string,
  ): Promise<string> {
    // No email in the event: the offboarding handler reads it from the identity
    const results = await this.eventEmitter.emitAndWait<IdentityOffboardRequestedPayload, unknown>(
      DomainEventType.IDENTITY_OFFBOARD_REQUESTED,
      event.identityId,
      { userId: event.identityId, reason: `leaver:${event.reason}` },
      { tenantId, actor },
    );
    const workflowId = results.find((r): r is string => typeof r === 'string' && r.length > 0);
    if (!workflowId) throw new Error('No offboarding workflow was started');
    return workflowId;
  }

  /** Close an event without starting it. */
  async close(
    tenantId: string,
    eventId: string,
    status: 'superseded' | 'rejected',
    note?: string,
  ): Promise<void> {
    await this.eventModel
      .updateOne(
        { _id: eventId, tenantId },
        {
          $set: { status, open: false, ...(note ? { closeReason: note } : {}) },
          $unset: { claimedAt: 1 },
        },
      )
      .exec();
  }
}
