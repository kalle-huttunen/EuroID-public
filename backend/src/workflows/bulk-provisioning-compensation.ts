/**
 * Rollback phase of bulkProvisioningWorkflow. Workflow code: bundled into the workflow, so it
 * must stay deterministic (no I/O, clock or randomness outside activities).
 */
import { proxyActivities } from '@temporalio/workflow';
import type { BulkProvisioningActivities } from '../activities/bulk-provisioning.activities';
import type { OperationResult } from './workflow-types';
import { BATCH_OPERATION_RETRY } from '../infrastructure/config/retry-policies';
import { isPatched } from './workflow-versioning';

/**
 * Rollback calls compensateOperation, which undoes each system it can and reports the others as
 * not rolled back with a reason, and also covers operations that failed on some systems but
 * succeeded on others. Histories from before this patch call rollbackOperation for fully
 * successful operations only.
 */
const COMPENSATE_PATCH = 'bulk-provisioning:compensate-operation';

const bulkActivities = proxyActivities<
  Pick<BulkProvisioningActivities, 'compensateOperation' | 'rollbackOperation'>
>({
  startToCloseTimeout: '2 minutes',
  retry: BATCH_OPERATION_RETRY,
});

/**
 * Compensate every system change and Golden Record write not yet rolled back. Each operation,
 * each of its systems and its Hub write get the outcome: rolled back, or not, with the reason (a
 * DELETE, a connector that cannot deprovision, a Hub write kept for a change that stays), so the
 * result never claims a rollback that did not happen. A failed operation's Hub write is undone
 * too. Results from before the bulk-provisioning:hub-compensation patch have no hubWrite.
 */
export async function rollBackSuccesses(
  results: OperationResult[],
  tenantId: string,
): Promise<void> {
  if (!isPatched(COMPENSATE_PATCH)) return legacyRollBackSuccesses(results, tenantId);
  const changed = (r: OperationResult) =>
    !r.rolledBack &&
    (r.systemResults.some((sr) => sr.success && !sr.skipped) || r.hubWrite !== undefined);
  for (const result of results.filter(changed)) {
    const outcome = await bulkActivities.compensateOperation(result, tenantId);
    if (outcome.rolledBack) result.rolledBack = true;
    result.rollbackReason = outcome.reason;
    for (const { system, rolledBack, reason } of outcome.systems) {
      const systemResult = result.systemResults.find((sr) => sr.system === system);
      if (systemResult) {
        systemResult.rolledBack = rolledBack;
        systemResult.rollbackReason = reason;
      }
    }
    if (result.hubWrite && outcome.hub) {
      result.hubWrite.rolledBack = outcome.hub.rolledBack;
      result.hubWrite.rollbackReason = outcome.hub.reason;
    }
  }
}

/** Rollback for histories from before COMPENSATE_PATCH: fully successful operations only. */
async function legacyRollBackSuccesses(
  results: OperationResult[],
  tenantId: string,
): Promise<void> {
  for (const result of results.filter((r) => r.success && !r.rolledBack)) {
    const rollbackSuccess = await bulkActivities.rollbackOperation(result, tenantId);
    if (rollbackSuccess) {
      result.rolledBack = true;
      result.rollbackReason = 'Batch failed, compensating transaction';
    } else if (result.type === 'DELETE') {
      result.rollbackReason = 'Not rolled back: a DELETE is not reversible';
    }
  }
}
