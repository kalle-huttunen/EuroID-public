import { Injectable, Logger } from '@nestjs/common';
import { ApplicationFailure } from '@temporalio/common';
import {
  PolicyEngineService,
  PolicyProvisioningIntent,
} from '../modules/policy/policy-engine.service';
import { SoDViolationException } from '../modules/policy/sod-violation.exception';
import type { SodViolation } from '../modules/policy/sod.service';
import { StandardUserDto } from '@shared/dtos/standard-user.dto';
import { SOD_VIOLATION_FAILURE } from '@shared/types/sod-violation';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { validateActivityContext } from '@shared/utils/activity-context';
import { systemKey } from '@shared/utils/normalize-system-name';
import { maskEmail } from '../modules/identity/identity-pii';
import { ReviewExclusionService } from '../modules/policy/review-exclusion.service';
import { UserEventService } from '../modules/identity/user-event.service';
import { maskEmails } from './deprovision-failure';

/**
 * The failure of an evaluation a BLOCK SoD policy refuses: not retryable (the same evaluation
 * gives the same answer until a policy or a rule changes), type SOD_VIOLATION_FAILURE, the
 * message naming the SoD policies (emails masked).
 */
export function sodViolationFailure(blockers: SodViolation[]): ApplicationFailure {
  const { message } = new SoDViolationException(blockers);
  return ApplicationFailure.nonRetryable(maskEmails(message), SOD_VIOLATION_FAILURE);
}

/**
 * [ACTIVITIES] Policy Engine Activities
 * --------------------------------------
 * Temporal-compatible wrapper around PolicyEngineService.
 * Called by the onboarding workflow at the POLICY_CALC step to determine
 * what groups, licenses, and attributes a user should receive, and before its target loop for
 * the targets an access review excluded for the person (getReviewExcludedTargets).
 */
@Injectable()
export class PolicyActivities {
  private readonly logger = new Logger(PolicyActivities.name);

  constructor(
    private readonly policyEngine: PolicyEngineService,
    private readonly reviewExclusions: ReviewExclusionService,
    private readonly userEvents: UserEventService,
  ) {}

  /**
   * Evaluate all active policies against a single user.
   * Returns the full PolicyProvisioningIntent with operations per target system.
   *
   * The workflow then filters operations by target system and passes
   * the relevant subset to each connector's provisioning activity.
   *
   * A BLOCK SoD conflict fails at once (sodViolationFailure); other failures are retried.
   * `options` (the mover's "before" side, called in-process): reviewExclusionsLiftedSince, the
   * access baseline's time (PolicyEngineService.evaluate). No workflow passes it.
   */
  async evaluateUser(
    user: StandardUserDto,
    tenantId?: string,
    correlationId?: string,
    options?: { reviewExclusionsLiftedSince?: Date },
  ): Promise<PolicyProvisioningIntent> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      async () => {
        let intent: PolicyProvisioningIntent;
        try {
          // The workflow provisions from this result: policy.evaluated says so (timeline)
          intent = await this.policyEngine.evaluate(user, tenantId, {
            forProvisioning: true,
            ...options,
          });
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.error('Policy evaluation failed', message);
          throw ApplicationFailure.create({
            message: `Policy evaluation failed: ${message}`,
            nonRetryable: false,
          });
        }
        if (intent.sodValidation && !intent.sodValidation.passed) {
          throw sodViolationFailure(intent.sodValidation.blockers);
        }
        this.logger.log(
          `Evaluated ${maskEmail(user.email)}: ${intent.operations.length} operations from policy engine`,
        );
        return intent;
      },
      { correlationId },
    );
  }

  /**
   * Onboarding (patch onboarding:review-exclusions): the targets of `targetSystems` an access
   * review excluded for the identity as a whole (a revoked account item: scope account), which
   * the run leaves out instead of creating the account again. Each goes on the identity timeline
   * ("Not provisioned to <target>: excluded by an access review"); a failed timeline write is
   * logged only. Names compared as systemKey does (`entra` is `entra-id`).
   */
  async getReviewExcludedTargets(
    identityId: string,
    targetSystems: string[],
    tenantId: string,
    correlationId?: string,
  ): Promise<string[]> {
    validateActivityContext({ tenantId, correlationId });
    return withTenantContext(
      tenantId,
      async () => {
        const excluded = new Set(
          await this.reviewExclusions.accountExcludedSystems(identityId, tenantId),
        );
        const targets = targetSystems.filter((t) => excluded.has(systemKey(t)));
        for (const target of targets) {
          await this.recordExcluded(identityId, target, correlationId);
        }
        return targets;
      },
      { correlationId },
    );
  }

  private async recordExcluded(
    identityId: string,
    target: string,
    correlationId?: string,
  ): Promise<void> {
    try {
      await this.userEvents.recordEvent({
        userId: identityId,
        type: 'USER_PROVISIONED',
        severity: 'info',
        title: `Not provisioned to ${target}: excluded by an access review`,
        description:
          `An access review revoked this identity's account in ${target}, so onboarding left it ` +
          'out. A policy-admin can lift the exclusion on the Access tab.',
        actor: 'system:onboarding',
        targetSystem: target,
        metadata: {
          workflow: 'onboarding',
          ...(correlationId ? { workflowId: correlationId } : {}),
          reason: 'access-review-exclusion',
        },
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Timeline entry for ${target} not recorded on ${identityId}: ${message}`);
    }
  }
}
