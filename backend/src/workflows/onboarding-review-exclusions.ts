/**
 * Onboarding and access review exclusions (patch onboarding:review-exclusions). A target an
 * access review excluded for the person as a whole (a revoked account item, so an account
 * exclusion of that system) is left out of the person's provisioning: no provisioning, no
 * provisioning entry and no account there (the health check still runs, once per run, before
 * any person). The run's result names it with its reason, as a target left out as not
 * configured; it is not a failure. The activity
 * (PolicyActivities.getReviewExcludedTargets, default queue) also puts it on the person's
 * timeline. Histories from before the patch ask nothing and provision every target.
 *
 * Workflow code: bundled into onboardingWorkflow, so it must stay deterministic (no I/O, clock or
 * randomness outside activities).
 */
import { proxyActivities } from '@temporalio/workflow';
import type { PolicyActivities } from '../activities/policy.activities';
import { QUERY_RETRY } from '../infrastructure/config/retry-policies';
import { isPatched } from './workflow-versioning';

export const REVIEW_EXCLUSIONS_PATCH = 'onboarding:review-exclusions';

const { getReviewExcludedTargets } = proxyActivities<
  Pick<PolicyActivities, 'getReviewExcludedTargets'>
>({ startToCloseTimeout: '10 seconds', retry: QUERY_RETRY });

/**
 * The run's targets an access review excluded for this identity; none for a person without an
 * identity record, a run without targets, or a history from before the patch.
 */
export async function reviewExcludedTargets(
  identityId: string | null,
  targetSystems: string[],
  tenantId: string,
  correlationId: string,
): Promise<string[]> {
  if (!identityId || targetSystems.length === 0) return [];
  if (!isPatched(REVIEW_EXCLUSIONS_PATCH)) return [];
  return getReviewExcludedTargets(identityId, targetSystems, tenantId, correlationId);
}

/** The run's result with the targets left out for access review exclusions named after it. */
export function withReviewExcludedTargets(result: string, excluded: Iterable<string>): string {
  const systems = [...new Set(excluded)];
  if (systems.length === 0) return result;
  return `${result} Left out by an access review exclusion: ${systems.join(', ')}.`;
}
