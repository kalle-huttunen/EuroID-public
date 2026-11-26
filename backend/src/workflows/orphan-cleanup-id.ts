/**
 * Workflow id of an orphan drift's cleanup (orphan-cleanup.workflow.ts): one per drift, under the
 * tenant prefix every tenant workflow id has (`t-<tenant>-`). A second start for the same drift
 * collides with a running cleanup instead of starting another; once that cleanup has closed, the
 * id is free for a fresh run (Temporal's default id reuse policy). The drift id is a MongoDB
 * ObjectId, so the id holds no personal data.
 *
 * dailyReconciliationWorkflow starts cleanups under it (patch reconciliation:start-orphan-cleanup)
 * and OrphanCleanupService starts one for a drift whose cleanup is not running. Dependency-free:
 * workflow code imports it.
 */
export function orphanCleanupWorkflowId(tenantId: string, driftId: string): string {
  return `t-${tenantId}-orphan-cleanup-${driftId}`;
}
