import { HttpException, Injectable, Logger } from '@nestjs/common';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/common';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import type { IdentityProvisionRequestedPayload } from '@infrastructure/events/event-payloads';
import {
  ReviewExclusionService,
  type ReviewExclusionView,
} from '../policy/review-exclusion.service';
import { maskEmails } from '../../activities/deprovision-failure';
import { AccessReevaluationService } from './access-reevaluation.service';

/** The run that gives a lifted exclusion's access back, or why none started. */
export type ReviewExclusionLiftRun =
  | { type: 'reevaluation' | 'onboarding'; started: true; workflowId: string }
  | { type: 'reevaluation' | 'onboarding'; started: false; reason: string };

/** POST /identity/:id/access/review-exclusions/:exclusionId/lift */
export interface ReviewExclusionLiftResult {
  /** The exclusion, now lifted. */
  exclusion: ReviewExclusionView;
  /** reevaluation for an entitlement exclusion, onboarding for an account exclusion. */
  run: ReviewExclusionLiftRun;
}

/** Why onboarding starts after a lift (identity.provision_requested, kept in the memo). */
export const ACCOUNT_LIFT_ONBOARDING_REASON = 'access-review-exclusion-lifted';

const UNREACHABLE: Record<ReviewExclusionLiftRun['type'], string> = {
  reevaluation:
    'The re-evaluation could not be started (the workflow service did not answer). ' +
    'Run Re-evaluate access on the Access tab to give the access back.',
  onboarding:
    'Onboarding could not be started (the workflow service did not answer). ' +
    'Provision the identity again from its page to create the account.',
};
const ONBOARDING_RUNNING =
  'An onboarding run for this identity is already in progress. Provision the identity again ' +
  'once it has finished, to create the account.';
const NO_EMAIL =
  'Onboarding did not start: the identity has no email address to provision the account with.';

/**
 * Lifting an access review exclusion (policy-admin): the exclusion is lifted (audited,
 * ReviewExclusionService.lift), then the run that gives the access back starts at once, with the
 * admin as actor:
 * - an entitlement exclusion: the identity's re-evaluation (AccessReevaluationService.reevaluate,
 *   audited as ACCESS_REEVALUATION_REQUESTED). Its "before" side still counts the just-lifted
 *   exclusion (the access baseline predates the lift), so the lifted grant is an add.
 * - an account exclusion: onboarding for the identity (identity.provision_requested, audited
 *   with the admin as actor). The re-evaluation creates no account; onboarding skips the SYNCED
 *   targets and creates the missing one, with the system's grants.
 * When the run cannot start (no access baseline, no provisioned target, a run in progress, no
 * email, Temporal unreachable) the lift stays done and the result says why.
 */
@Injectable()
export class ReviewExclusionLiftService {
  private readonly logger = new Logger(ReviewExclusionLiftService.name);

  constructor(
    private readonly exclusions: ReviewExclusionService,
    private readonly reevaluation: AccessReevaluationService,
    private readonly eventEmitter: DomainEventEmitterService,
  ) {}

  async lift(
    identityId: string,
    exclusionId: string,
    actor: string,
  ): Promise<ReviewExclusionLiftResult> {
    const exclusion = await this.exclusions.lift(identityId, exclusionId, actor);
    const run =
      exclusion.scope === 'account'
        ? await this.startOnboarding(identityId, actor)
        : await this.startReevaluation(identityId, actor);
    if (!run.started) {
      this.logger.warn(
        `[ReviewExclusion] ${exclusionId} lifted for identity ${identityId}; ${run.type} not ` +
          `started: ${run.reason}`,
      );
    }
    return { exclusion, run };
  }

  private async startReevaluation(
    identityId: string,
    actor: string,
  ): Promise<ReviewExclusionLiftRun> {
    try {
      const { workflowId } = await this.reevaluation.reevaluate(identityId, actor);
      return { type: 'reevaluation', started: true, workflowId };
    } catch (error: unknown) {
      // A refusal the re-evaluation explains (409, 404) is shown as it is; anything else not
      return {
        type: 'reevaluation',
        started: false,
        reason: error instanceof HttpException ? error.message : this.unreachable(error),
      };
    }
  }

  private async startOnboarding(
    identityId: string,
    actor: string,
  ): Promise<ReviewExclusionLiftRun> {
    try {
      // The onboarding handler reads the identity (and its email) by the aggregate id
      const results = await this.eventEmitter.emitAndWait<
        IdentityProvisionRequestedPayload,
        unknown
      >(
        DomainEventType.IDENTITY_PROVISION_REQUESTED,
        identityId,
        { reason: ACCOUNT_LIFT_ONBOARDING_REASON },
        { actor },
      );
      const workflowId = results.find((r): r is string => typeof r === 'string' && r.length > 0);
      return workflowId
        ? { type: 'onboarding', started: true, workflowId }
        : { type: 'onboarding', started: false, reason: NO_EMAIL };
    } catch (error: unknown) {
      return {
        type: 'onboarding',
        started: false,
        reason:
          error instanceof WorkflowExecutionAlreadyStartedError
            ? ONBOARDING_RUNNING
            : this.unreachable(error, 'onboarding'),
      };
    }
  }

  /** The generic reason; the error itself is logged only (masked: it may name internals). */
  private unreachable(
    error: unknown,
    type: ReviewExclusionLiftRun['type'] = 'reevaluation',
  ): string {
    const message = error instanceof Error ? error.message : String(error);
    this.logger.error(`[ReviewExclusion] ${type} could not be started: ${maskEmails(message)}`);
    return UNREACHABLE[type];
  }
}
