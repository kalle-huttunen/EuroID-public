/**
 * Onboarding's input: `{ targetEmail, tenantId, syncToEntra? }`, or the legacy call signature
 * `(targetEmail, tenantId)` of runs started before the input object, still accepted (deprecated).
 *
 * Workflow code: bundled into onboardingWorkflow, so it must stay deterministic.
 */
import { ApplicationFailure, log } from '@temporalio/workflow';
import { isPatched } from './workflow-versioning';

/**
 * A run needs its person. The all-users run (no targetEmail) returned every active identity's
 * profile in one activity result (fetchNewHires), over Temporal's payload limit on a large
 * tenant, and no caller starts it any more: a run started without a person fails at once, not
 * retried. Histories recorded before this patch keep the all-users path.
 */
const TARGET_REQUIRED_PATCH = 'onboarding:target-required';

export interface OnboardingWorkflowInput {
  /** The person's email; the workflow reads the identity by it. */
  targetEmail: string;
  tenantId: string;
  /** PATCH /identity/:id?syncToEntra=true: provision Entra ID again even when it is SYNCED. */
  syncToEntra?: boolean;
}

/**
 * The run's person (none: an all-users run, which only histories from before
 * TARGET_REQUIRED_PATCH have), tenant and Entra ID sync flag.
 */
export function onboardingInputOf(
  input: OnboardingWorkflowInput | string,
  tenantIdArg?: string,
): Required<Pick<OnboardingWorkflowInput, 'tenantId' | 'syncToEntra'>> & {
  targetEmail?: string;
} {
  if (typeof input === 'string') {
    log.warn(
      'DEPRECATED: onboardingWorkflow(string, string) call signature is deprecated. ' +
        'Use onboardingWorkflow({ targetEmail, tenantId }) instead. Will be removed in v2.0.',
    );
    return { targetEmail: input, tenantId: tenantIdArg ?? '', syncToEntra: false };
  }
  return {
    targetEmail: input && typeof input === 'object' ? input.targetEmail : undefined,
    tenantId:
      typeof input === 'object' && input && 'tenantId' in input
        ? input.tenantId
        : (tenantIdArg ?? ''),
    syncToEntra: typeof input === 'object' && input?.syncToEntra === true,
  };
}

/** Fails a run started without its person (TARGET_REQUIRED_PATCH), before any activity. */
export function failWithoutTarget(targetEmail: string | undefined): void {
  if (targetEmail || !isPatched(TARGET_REQUIRED_PATCH)) return;
  throw ApplicationFailure.nonRetryable(
    'An onboarding run needs its person (targetEmail): the all-users run is no longer started',
    'OnboardingTargetRequired',
  );
}
