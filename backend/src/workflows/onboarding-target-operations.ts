/**
 * Onboarding's per-target view of the policy intent: the operations meant for one target system,
 * and the end of the access they grant when a policy limits it (timeConstraint.durationDays).
 *
 * Workflow code: bundled into onboardingWorkflow, so it must stay deterministic (pure functions;
 * the caller passes the workflow time).
 */
import { getSystemType } from '../shared/utils/normalize-system-name';

/** The part of a policy operation these functions read. */
export interface TargetOperation {
  target: string;
  type: string;
  timeConstraint?: { durationDays?: number; expiresAt?: Date };
}

/**
 * The intent's operations for `system`: Entra ID its groups, directory roles and licenses; AD its
 * groups and licenses; any other system every operation named for it, for `<system>-id` or `all`.
 */
export function targetOperations<T extends TargetOperation>(operations: T[], system: string): T[] {
  if (getSystemType(system) === 'entra') {
    return operations.filter(
      (op) =>
        (op.target === 'entra' || op.target === 'entra-id' || op.target === 'all') &&
        (op.type === 'group' || op.type === 'role' || op.type === 'license'),
    );
  }
  if (getSystemType(system) === 'ad') {
    return operations.filter(
      (op) =>
        (op.target === 'ad' || op.target === 'active-directory' || op.target === 'all') &&
        (op.type === 'group' || op.type === 'license'),
    );
  }
  return operations.filter(
    (op) => op.target === system || op.target === `${system}-id` || op.target === 'all',
  );
}

/**
 * The provisioning entry's time constraint: the shortest positive durationDays of the target's
 * operations, counted from `now`, granted by policy; undefined when none limits the access.
 */
export function policyTimeConstraint(
  operations: TargetOperation[],
  now: Date,
): { expiresAt?: Date; grantedBy?: 'policy' } | undefined {
  const days = operations
    .map((op) => op.timeConstraint?.durationDays)
    .filter((d): d is number => typeof d === 'number' && d > 0);
  if (days.length === 0) return undefined;
  const minDays = Math.min(...days);
  return { expiresAt: new Date(now.getTime() + minDays * 86_400_000), grantedBy: 'policy' };
}
