import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model } from 'mongoose';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/common';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import type {
  IdentityProvisionRequestedPayload,
  JoinerOnboardingStartedPayload,
  JoinerOnboardingWaitingPayload,
} from '@infrastructure/events/event-payloads';
import { hrStartTimeoutMs } from '@infrastructure/config/defaults';
import { withTimeout } from '@shared/utils/with-timeout';
import type { IdentityDocument } from '../identity/schemas/identity.schema';
import { LeaverEvent, LeaverEventDocument } from '../leavers/schemas/leaver-event.schema';
import { LeaverPolicyService } from '../leavers/leaver-policy.service';
import {
  JoinerEvent,
  JoinerEventDocument,
  OPEN_JOINER_STATUSES,
} from './schemas/joiner-event.schema';
import {
  JOINER_PROJECTION,
  joinerState,
  type IdentityForJoiner,
  type JoinerState,
  type JoinerWaitReason,
} from './joiner-candidates';

/** Who starts HR-driven onboarding when no person does (a sync under the mass-joiner limit). */
export const HR_JOINER_SYSTEM_ACTOR = 'system:hr-sync';

/** Longest start error kept on a joiner event. */
const MAX_ERROR_LENGTH = 300;

/** Leaver event statuses that mean the person is leaving or left (rejected ones do not). */
const LEAVING_STATUSES = ['pending-approval', 'queued', 'started'];

export type StoredJoinerEvent = JoinerEvent & { _id: unknown };

/** The leaver policy settings the joiner rules read (time zone, "left" status words). */
export interface JoinerRuleSettings {
  timezone: string;
  terminatedStatuses: string[];
}

export type JoinerStartResult =
  | { outcome: 'started'; workflowId: string }
  | { outcome: 'already-running' }
  | { outcome: 'failed'; error: string };

/**
 * Checks one joiner against the hub (joiner-candidates.ts) and starts its onboarding through
 * IDENTITY_PROVISION_REQUESTED, the event POST /identity?triggerWorkflow=true uses, so
 * OnboardingService starts the existing onboarding workflow (deterministic id per identity) with
 * `reason: joiner:hr-sync:<source>` in its memo. Leaver state is read from `leaver_events`
 * (modules/leavers, read only): HR ingestion asks for joiner detection only after leaver
 * detection answered, so this run's leavers are there.
 */
@Injectable()
export class JoinerExecutionService {
  private readonly logger = new Logger(JoinerExecutionService.name);

  constructor(
    @InjectModel('Identity') private readonly identityModel: Model<IdentityDocument>,
    @InjectModel(JoinerEvent.name) private readonly eventModel: Model<JoinerEventDocument>,
    @InjectModel(LeaverEvent.name) private readonly leaverEventModel: Model<LeaverEventDocument>,
    private readonly leaverPolicy: LeaverPolicyService,
    private readonly eventEmitter: DomainEventEmitterService,
  ) {}

  /** The current tenant's leaver policy, as far as the joiner rules read it. */
  async ruleSettings(): Promise<JoinerRuleSettings> {
    const policy = await this.leaverPolicy.getPolicy();
    return { timezone: policy.timezone, terminatedStatuses: policy.terminatedStatuses };
  }

  /**
   * Due (with the email to onboard), waiting or closed now. `deliveredSince`: the start of the
   * full sync that evaluates the joiner (the person must be in it); unset for a batch approval.
   */
  async check(
    tenantId: string,
    event: StoredJoinerEvent,
    settings: JoinerRuleSettings,
    deliveredSince?: Date,
  ): Promise<JoinerState> {
    const identity = isValidObjectId(event.identityId)
      ? ((await this.identityModel
          .findOne({ _id: event.identityId, tenantId })
          .select(JOINER_PROJECTION)
          .lean()
          .exec()) as unknown as IdentityForJoiner | null)
      : null;
    // A rehire's earlier employment ended with a leaver event: only one since the rehire counts
    const leaving = await this.leaverEventModel
      .exists({
        tenantId,
        identityId: event.identityId,
        status: { $in: LEAVING_STATUSES },
        ...(event.rehiredAt ? { detectedAt: { $gt: event.rehiredAt } } : {}),
      })
      .exec();
    return joinerState(identity, {
      sourceName: event.sourceName,
      now: new Date(),
      ...settings,
      hasLeaverEvent: !!leaving,
      deliveredSince,
      ...(event.rehiredAt ? { rehiredAt: new Date(event.rehiredAt) } : {}),
    });
  }

  /**
   * Record why a waiting joiner waits (`waitReason`). When it starts waiting because its HR start
   * date is not a date, identity.joiner_onboarding_waiting puts that on the identity timeline,
   * once: later syncs that find the same reason change nothing.
   */
  async noteWait(
    tenantId: string,
    event: StoredJoinerEvent,
    reason: JoinerWaitReason,
  ): Promise<void> {
    if (event.waitReason === reason) return;
    const eventId = String(event._id);
    await this.eventModel
      .updateOne({ _id: eventId, tenantId }, { $set: { waitReason: reason } })
      .exec();
    if (reason !== 'start-date-unreadable') return;
    this.eventEmitter.emit<JoinerOnboardingWaitingPayload>(
      DomainEventType.JOINER_ONBOARDING_WAITING,
      event.identityId,
      {
        identityId: event.identityId,
        joinerEventId: eventId,
        sourceName: event.sourceName,
        reason,
      },
      { tenantId, actor: HR_JOINER_SYSTEM_ACTOR },
    );
  }

  /**
   * Start the onboarding of one due joiner and record the outcome on its event: started; an
   * onboarding run already in progress for the identity closes it (superseded); any other
   * failure leaves it waiting with the error, for the source's next full sync. A start that
   * does not answer within HR_START_TIMEOUT_MS counts as failed. An approved batch and a full
   * sync can start the same waiting joiner at once: the run is one (deterministic workflow id),
   * and only an open event is closed or sent back to waiting, so a started one stays started.
   */
  async start(
    tenantId: string,
    event: StoredJoinerEvent,
    actor: string,
  ): Promise<JoinerStartResult> {
    const eventId = String(event._id);
    let workflowId: string;
    try {
      const ms = hrStartTimeoutMs();
      workflowId = await withTimeout(
        this.requestOnboarding(tenantId, event, actor),
        ms,
        `The onboarding start did not answer within ${ms} ms`,
      );
    } catch (err: unknown) {
      if (err instanceof WorkflowExecutionAlreadyStartedError) {
        await this.close(
          tenantId,
          eventId,
          'superseded',
          'An onboarding run for the identity was already in progress.',
        );
        return { outcome: 'already-running' };
      }
      const error = (err instanceof Error ? err.message : String(err)).slice(0, MAX_ERROR_LENGTH);
      this.logger.warn(`[Joiners] Onboarding start failed for ${event.identityId}: ${error}`);
      await this.eventModel
        .updateOne(
          { _id: eventId, tenantId, status: { $in: OPEN_JOINER_STATUSES } },
          { $set: { status: 'waiting', open: true, startError: error } },
        )
        .exec();
      return { outcome: 'failed', error };
    }

    await this.eventModel
      .updateOne(
        { _id: eventId, tenantId },
        {
          $set: { status: 'started', open: false, workflowId, startedAt: new Date() },
          $unset: { startError: 1 },
        },
      )
      .exec();
    this.eventEmitter.emit<JoinerOnboardingStartedPayload>(
      DomainEventType.JOINER_ONBOARDING_STARTED,
      event.identityId,
      {
        identityId: event.identityId,
        joinerEventId: eventId,
        sourceName: event.sourceName,
        workflowId,
        ...(event.batchId ? { batchId: event.batchId } : {}),
        ...(event.rehiredAt ? { rehire: true } : {}),
      },
      { tenantId, actor },
    );
    return { outcome: 'started', workflowId };
  }

  /** Close a joiner without starting it; a joiner already started is left as it is. */
  async close(
    tenantId: string,
    eventId: string,
    status: 'superseded' | 'rejected',
    reason: string,
    decidedBy?: string,
  ): Promise<void> {
    await this.eventModel
      .updateOne(
        { _id: eventId, tenantId, status: { $in: OPEN_JOINER_STATUSES } },
        {
          $set: {
            status,
            open: false,
            closeReason: reason,
            ...(decidedBy ? { decidedBy } : {}),
          },
        },
      )
      .exec();
  }

  private async requestOnboarding(
    tenantId: string,
    event: StoredJoinerEvent,
    actor: string,
  ): Promise<string> {
    // No email in the event: the onboarding handler reads it from the identity
    const results = await this.eventEmitter.emitAndWait<IdentityProvisionRequestedPayload, unknown>(
      DomainEventType.IDENTITY_PROVISION_REQUESTED,
      event.identityId,
      { reason: `joiner:hr-sync:${event.sourceName}` },
      { tenantId, actor },
    );
    const workflowId = results.find((r): r is string => typeof r === 'string' && r.length > 0);
    if (!workflowId) throw new Error('No onboarding workflow was started');
    return workflowId;
  }
}
