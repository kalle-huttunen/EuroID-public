/**
 * Onboarding's admin accounts (PAM): the intent's adminOperations go to
 * adminAccountProvisioningWorkflow children, awaited.
 *
 * Patch onboarding:provision-every-admin-tier: each admin tier gets its own admin identity and
 * its own child (`admin-provision-<parent>-<identity>-t<n>`) with only that tier's operations.
 * Histories from before it started one child, `admin-provision-<parent>-<identity>`, with the
 * first operation's tier and every operation, so the other tiers got no admin account.
 *
 * Patch onboarding:admin-account-failure-not-fatal: a failed child (a second tier's admin UPN
 * taken, a target refusing the admin account) no longer fails the run before the person's own
 * targets. Every tier's child is started; the failed tiers, with the child's own reason, go on
 * the person's timeline (recordAdminAccountFailed) and back to onboarding, which provisions the
 * person and then ends failed (adminAccountsFailure). Histories from before it failed the run at
 * the first failed child.
 *
 * Workflow code: bundled into onboardingWorkflow, so it must stay deterministic.
 */
import {
  ActivityFailure,
  ApplicationFailure,
  ChildWorkflowFailure,
  executeChild,
  isCancellation,
  ParentClosePolicy,
  proxyActivities,
  workflowInfo,
} from '@temporalio/workflow';
import type { IdentityActivities } from '../activities/identity.activities';
import { tierToken } from '../modules/privileged-access/admin-upn';
import { adminAccountProvisioningWorkflow } from './admin-account-provisioning.workflow';
import { inheritTenantAttributes } from './child-workflow-tenant';
import { isPatched } from './workflow-versioning';

const EVERY_ADMIN_TIER_PATCH = 'onboarding:provision-every-admin-tier';
const ADMIN_FAILURE_PATCH = 'onboarding:admin-account-failure-not-fatal';

/** Failure type of an onboarding run that provisioned the people but not all admin accounts. */
export const ADMIN_ACCOUNT_FAILED = 'AdminAccountFailed';

const { recordAdminAccountFailed } = proxyActivities<
  Pick<IdentityActivities, 'recordAdminAccountFailed'>
>({ startToCloseTimeout: '10 seconds' });

/** An admin tier whose child failed, with the child's own reason. */
export interface AdminAccountFailure {
  adminTier: string;
  reason: string;
}

/** The failed tiers of one person. */
export interface AdminAccountsFailed {
  identityId: string;
  failures: AdminAccountFailure[];
}

/** The child's own reason: its failure, unwrapped from the child and activity failures. */
function childFailureReason(err: unknown): string {
  let current: unknown = err;
  while (
    (current instanceof ChildWorkflowFailure || current instanceof ActivityFailure) &&
    current.cause
  ) {
    current = current.cause;
  }
  return current instanceof Error ? current.message : String(current);
}

/** The run's failure after it went through the people: not retryable; identity ids, no emails. */
export function adminAccountsFailure(
  failed: AdminAccountsFailed[],
  total: number,
): ApplicationFailure {
  const who = failed
    .map(
      (f) =>
        `identity ${f.identityId}: ` +
        f.failures.map((x) => `${x.adminTier}: ${x.reason}`).join(', '),
    )
    .join('; ');
  return ApplicationFailure.nonRetryable(
    `Admin accounts not provisioned for ${failed.length} of ${total} people (${who})`,
    ADMIN_ACCOUNT_FAILED,
  );
}

/** The tier an operation without one counts as (as the single child before the patch). */
const DEFAULT_ADMIN_TIER = 'TIER_1';

type AdminOperation = Record<string, unknown>;

/** The admin operations grouped by tier, the tiers in the order they first appear. */
export function adminOperationsByTier(
  adminOperations: AdminOperation[],
): Array<[string, AdminOperation[]]> {
  const byTier = new Map<string, AdminOperation[]>();
  for (const op of adminOperations) {
    const tier =
      typeof op.adminTier === 'string' && op.adminTier ? op.adminTier : DEFAULT_ADMIN_TIER;
    byTier.set(tier, [...(byTier.get(tier) ?? []), op]);
  }
  return [...byTier.entries()];
}

/**
 * Provision the person's admin accounts for these admin operations (see the module comment).
 * `childTenantPatch`: onboarding's patch for the children's TenantId search attribute and memo.
 * Returns the tiers whose child failed (ADMIN_FAILURE_PATCH), already on the person's timeline;
 * before that patch a failed child throws.
 */
export async function provisionAdminAccounts(
  adminOperations: AdminOperation[],
  identityId: string,
  tenantId: string,
  childTenantPatch: string,
): Promise<AdminAccountFailure[]> {
  const parentWorkflowId = workflowInfo().workflowId;
  const start = (adminTier: string, operations: AdminOperation[], workflowId: string) =>
    executeChild(adminAccountProvisioningWorkflow, {
      args: [
        {
          parentIdentityId: identityId,
          adminTier,
          adminOperations: operations,
          tenantId,
        } as unknown as Parameters<typeof adminAccountProvisioningWorkflow>[0],
      ],
      workflowId,
      parentClosePolicy: ParentClosePolicy.PARENT_CLOSE_POLICY_ABANDON,
      ...inheritTenantAttributes(childTenantPatch),
    });

  if (isPatched(EVERY_ADMIN_TIER_PATCH)) {
    const goOnAfterFailure = isPatched(ADMIN_FAILURE_PATCH);
    const failures: AdminAccountFailure[] = [];
    for (const [adminTier, operations] of adminOperationsByTier(adminOperations)) {
      const workflowId = `admin-provision-${parentWorkflowId}-${identityId}-${tierToken(adminTier)}`;
      if (!goOnAfterFailure) {
        await start(adminTier, operations, workflowId);
        continue;
      }
      try {
        await start(adminTier, operations, workflowId);
      } catch (err: unknown) {
        if (isCancellation(err)) throw err;
        failures.push({ adminTier, reason: childFailureReason(err) });
      }
    }
    if (failures.length > 0) {
      await recordAdminAccountFailed(identityId, failures, tenantId, parentWorkflowId);
    }
    return failures;
  }
  const adminTier = (adminOperations[0]?.adminTier as string) ?? DEFAULT_ADMIN_TIER;
  await start(adminTier, adminOperations, `admin-provision-${parentWorkflowId}-${identityId}`);
  return [];
}
