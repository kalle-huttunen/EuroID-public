/**
 * The failure evaluateUser (activities/policy.activities.ts) throws when a BLOCK SoD policy
 * refuses the access the policies give a person. Not retryable: the same evaluation gives the
 * same answer until a policy or a rule changes. Pure: imported by the policy and mover activities
 * and by the onboarding workflow.
 */

/** ApplicationFailure type of that failure (also the mover's MOVER_SOD_VIOLATION). */
export const SOD_VIOLATION_FAILURE = 'SoDViolation';
