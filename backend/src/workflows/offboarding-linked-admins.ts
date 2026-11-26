/**
 * Offboarding cascade to a person's linked admin identities (PAM), behind the patch
 * offboarding:linked-admin-cascade. Privileged accounts go first: before the person's own targets,
 * each live linked admin identity is offboarded by a child offboardingWorkflow under its own id
 * (`t-<tenant>-offboard-<adminId>`, as OffboardingService starts one), one after another, so the
 * history stays small and the order clear. A child that fails or leaves a target failed counts as
 * failed for the person (Golden Record suspended, not deleted): a leaver is never deleted while
 * one of their admin accounts may still exist. An offboarding of the admin identity that already
 * runs (another trigger) is recorded as running elsewhere and not waited for: that run reports its
 * own result.
 *
 * Workflow code: bundled into offboardingWorkflow, so it must stay deterministic.
 */
import {
  proxyActivities,
  startChild,
  ParentClosePolicy,
  ChildWorkflowFailure,
  log,
  type ChildWorkflowHandle,
} from '@temporalio/workflow';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/common';
import type {
  LinkedAdminIdentity,
  PrivilegedAccessActivities,
} from '../activities/privileged-access.activities';
import type { OffboardingLinkedAdminResult } from '../shared/types/deprovision';
import type { OffboardingContext } from './offboarding-deprovision';
import type { offboardingWorkflow } from './offboarding.workflow';
import { inheritTenantAttributes } from './child-workflow-tenant';
import { offboardingWorkflowId } from './offboarding-id';

/** Offboard the person's live linked admin identities first (child workflows). */
export const LINKED_ADMIN_CASCADE_PATCH = 'offboarding:linked-admin-cascade';

// Retried until it answers, like getOffboardingTargets: without it nothing is known about the
// admin accounts (an activity worker of an older build does not have it)
const { getLinkedAdminIdentities } = proxyActivities<PrivilegedAccessActivities>({
  startToCloseTimeout: '10s',
});

/** The child's own message (ChildWorkflowFailure only says which child failed). */
function reasonOf(err: unknown): string {
  if (err instanceof ChildWorkflowFailure && err.cause) return err.cause.message;
  return err instanceof Error ? err.message : String(err);
}

/** Offboard each live linked admin identity of the person, in turn, and say what became of it. */
export async function offboardLinkedAdmins(
  ctx: OffboardingContext,
): Promise<OffboardingLinkedAdminResult[]> {
  const admins = await getLinkedAdminIdentities(ctx.userId, ctx.tenantId, ctx.workflowId);
  const results: OffboardingLinkedAdminResult[] = [];
  for (const admin of admins) results.push(await offboardLinkedAdmin(admin, ctx));
  return results;
}

/**
 * Right before the person is deleted: the person's linked admin identities are read again (the
 * cascade's activity). One still live may still hold a privileged account: its offboarding ran
 * elsewhere and has not finished, or it was linked while this run went on. Each such admin
 * identity counts as failed, its reason saying to rerun the person's offboarding, so the person
 * is suspended, not deleted. One whose offboarding finished meanwhile (deleted) does not hold
 * the person. Returns `linkedAdmins` with those entries changed or added.
 */
export async function checkNoLiveLinkedAdmins(
  ctx: OffboardingContext,
  linkedAdmins: OffboardingLinkedAdminResult[],
): Promise<OffboardingLinkedAdminResult[]> {
  const live = await getLinkedAdminIdentities(ctx.userId, ctx.tenantId, ctx.workflowId);
  const results = [...linkedAdmins];
  for (const admin of live) {
    const index = results.findIndex((a) => a.identityId === admin.identityId);
    const known = index >= 0 ? results[index] : undefined;
    if (known?.outcome === 'failed') continue;
    const workflowId = known?.workflowId ?? offboardingWorkflowId(ctx.tenantId, admin.identityId);
    const reason =
      known?.outcome === 'running-elsewhere'
        ? `its offboarding (${workflowId}) had not finished when the person's offboarding ` +
          "ended: rerun the person's offboarding once it has finished"
        : "still live when the person's offboarding ended: rerun the person's offboarding, " +
          'which offboards it first';
    const entry: OffboardingLinkedAdminResult = {
      identityId: admin.identityId,
      workflowId,
      outcome: 'failed',
      reason,
    };
    if (known) results[index] = entry;
    else results.push(entry);
  }
  return results;
}

async function offboardLinkedAdmin(
  admin: LinkedAdminIdentity,
  ctx: OffboardingContext,
): Promise<OffboardingLinkedAdminResult> {
  const workflowId = offboardingWorkflowId(ctx.tenantId, admin.identityId);
  const base = { identityId: admin.identityId, workflowId };
  // The TenantId search attribute, so tenant-checked reads find the child; a memo of its own
  const { searchAttributes } = inheritTenantAttributes(LINKED_ADMIN_CASCADE_PATCH);
  let handle: ChildWorkflowHandle<typeof offboardingWorkflow>;
  try {
    handle = await startChild<typeof offboardingWorkflow>('offboardingWorkflow', {
      args: [{ userId: admin.identityId, userEmail: admin.email, tenantId: ctx.tenantId }],
      workflowId,
      // Once started, removing a privileged account runs to its end even if this run stops
      parentClosePolicy: ParentClosePolicy.PARENT_CLOSE_POLICY_ABANDON,
      ...(searchAttributes ? { searchAttributes } : {}),
      memo: {
        triggeredBy: 'offboardingWorkflow',
        targetDescription:
          `Offboarding: identity ${admin.identityId} ` +
          `(linked admin account of identity ${ctx.userId})`,
      },
    });
  } catch (err: unknown) {
    if (err instanceof WorkflowExecutionAlreadyStartedError) {
      log.info(`Offboarding of linked admin identity ${admin.identityId} already runs: not waited`);
      return {
        ...base,
        outcome: 'running-elsewhere',
        reason:
          'an offboarding of this admin identity was already running; it reports its own result',
      };
    }
    return {
      ...base,
      outcome: 'failed',
      reason: `its offboarding did not start: ${reasonOf(err)}`,
    };
  }
  try {
    const result = await handle.result();
    if (typeof result === 'object' && result.status === 'partial-failure') {
      return { ...base, outcome: 'failed', reason: 'its offboarding left a target failed' };
    }
    return { ...base, outcome: 'offboarded' };
  } catch (err: unknown) {
    return { ...base, outcome: 'failed', reason: reasonOf(err) };
  }
}
