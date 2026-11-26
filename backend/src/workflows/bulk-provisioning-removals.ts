/**
 * The last step of bulkProvisioningWorkflow, after any rollback: the provisioning entries of the
 * accounts its DISABLE and DELETE operations removed are marked DEPROVISIONED (the activity
 * markRemovedAccounts, activities/bulk-provisioning-removals.ts), so offboarding and the mover
 * stop taking them for active. A removal the run rolled back is not marked. Workflow code:
 * bundled into the workflow, so it must stay deterministic.
 */
import { proxyActivities, log } from '@temporalio/workflow';
import type { BulkProvisioningActivities } from '../activities/bulk-provisioning.activities';
import type { RemovedAccount } from '../activities/bulk-provisioning-removals';
import {
  BulkOperationType,
  type BulkOperationRequest,
  type OperationResult,
} from './workflow-types';
import { BATCH_OPERATION_RETRY } from '../infrastructure/config/retry-policies';
import { isPatched } from './workflow-versioning';

/**
 * The removed accounts' provisioning entries are marked DEPROVISIONED at the end of the run.
 * Histories from before this patch tell the Hub nothing (the entry stays SYNCED until
 * reconciliation finds the drift).
 */
const MARK_REMOVED_PATCH = 'bulk-provisioning:mark-removed-accounts';

/** Removals per activity call, so one call's input stays far below Temporal's payload limit. */
const REMOVALS_PER_CALL = 200;

const bulkActivities = proxyActivities<Pick<BulkProvisioningActivities, 'markRemovedAccounts'>>({
  startToCloseTimeout: '2 minutes',
  retry: BATCH_OPERATION_RETRY,
});

/** The DISABLE and DELETE operations still done, each with the systems where it succeeded. */
export function removedAccountsOf(
  request: BulkOperationRequest,
  results: OperationResult[],
): RemovedAccount[] {
  const operations = new Map(request.operations.map((op) => [op.id, op]));
  const removals: RemovedAccount[] = [];
  for (const result of results) {
    if (result.type !== BulkOperationType.DISABLE && result.type !== BulkOperationType.DELETE) {
      continue;
    }
    const systems = result.systemResults
      .filter((sr) => sr.success && !sr.skipped && !sr.rolledBack)
      .map((sr) => sr.system);
    const user = operations.get(result.operationId)?.user as
      | { email?: string; sourceSystem?: string; sourceUserId?: string }
      | undefined;
    if (systems.length === 0 || !user) continue;
    removals.push({
      operationId: result.operationId,
      email: user.email ?? result.email,
      ...(user.sourceSystem ? { sourceSystem: user.sourceSystem } : {}),
      ...(user.sourceUserId ? { sourceUserId: user.sourceUserId } : {}),
      systems,
    });
  }
  return removals;
}

/**
 * Marks the removed accounts (MARK_REMOVED_PATCH). The target accounts are already changed, so a
 * failure here does not change the batch's outcome: it is logged, and reconciliation reports the
 * entries as drift as before.
 */
export async function markRemovedAccounts(
  request: BulkOperationRequest,
  results: OperationResult[],
  tenantId: string,
): Promise<void> {
  const removals = removedAccountsOf(request, results);
  if (removals.length === 0 || !isPatched(MARK_REMOVED_PATCH)) return;
  try {
    for (let i = 0; i < removals.length; i += REMOVALS_PER_CALL) {
      await bulkActivities.markRemovedAccounts(removals.slice(i, i + REMOVALS_PER_CALL), tenantId);
    }
  } catch (error: unknown) {
    log.error('[BulkWorkflow] Could not mark the removed accounts in the Hub', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
