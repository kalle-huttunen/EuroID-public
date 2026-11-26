/**
 * Onboarding when a BLOCK SoD policy refuses the access the policies give a person (patch
 * onboarding:sod-block-fails-person). evaluateUser then fails without retry (SOD_VIOLATION_FAILURE,
 * activities/policy.activities.ts); the run records the reason on the person's timeline, goes on
 * with the rest of the batch, and fails at the end, naming the refused identities. Before the
 * patch the activity was retried without limit and the run, with every later person of the
 * batch, waited at that person's policy step.
 *
 * Workflow code: bundled into onboardingWorkflow, so it must stay deterministic (no I/O, clock or
 * randomness outside activities).
 */
import { ActivityFailure, ApplicationFailure, proxyActivities } from '@temporalio/workflow';
import type { IdentityActivities } from '../activities/identity.activities';
import { SOD_VIOLATION_FAILURE } from '../shared/types/sod-violation';
import { isPatched } from './workflow-versioning';

export const SOD_BLOCK_PATCH = 'onboarding:sod-block-fails-person';

const { getIdentityByEmail, recordOnboardingBlocked } = proxyActivities<IdentityActivities>({
  startToCloseTimeout: '10 seconds',
});

/** A person the run did not onboard because a BLOCK SoD policy refused their access. */
export interface SodBlockedPerson {
  /** Absent when the hub has no identity for the person. */
  identityId?: string;
  reason: string;
}

/**
 * The reason (the SoD policies) when `err` is evaluateUser failing on a BLOCK SoD conflict in a
 * run with the patch; undefined for any other failure, which the run throws as before.
 */
export function sodBlockReason(err: unknown): string | undefined {
  const cause = err instanceof ActivityFailure ? err.cause : undefined;
  if (!(cause instanceof ApplicationFailure) || cause.type !== SOD_VIOLATION_FAILURE) {
    return undefined;
  }
  return isPatched(SOD_BLOCK_PATCH) ? cause.message : undefined;
}

/** Puts the refusal on the person's timeline (when the hub has them); returns who was refused. */
export async function recordSodBlock(
  email: string,
  reason: string,
  tenantId: string,
  correlationId: string,
): Promise<SodBlockedPerson> {
  const identity = await getIdentityByEmail(email, tenantId, correlationId);
  if (!identity) return { reason };
  await recordOnboardingBlocked(identity._id, reason, tenantId, correlationId);
  return { identityId: identity._id, reason };
}

/** The run's failure after it went through the batch: not retryable; identity ids, no emails. */
export function sodBlockFailure(blocked: SodBlockedPerson[], total: number): ApplicationFailure {
  const who = blocked
    .map(
      (b) =>
        `${b.identityId ? `identity ${b.identityId}` : 'a person not in the hub'}: ${b.reason}`,
    )
    .join('; ');
  return ApplicationFailure.nonRetryable(
    `Onboarding refused by a BLOCK SoD policy for ${blocked.length} of ${total} people (${who})`,
    SOD_VIOLATION_FAILURE,
  );
}
