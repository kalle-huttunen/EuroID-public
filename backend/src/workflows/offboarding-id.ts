/**
 * Workflow id of an identity's offboarding (offboarding.workflow.ts): one per identity, under the
 * tenant prefix every tenant workflow id has (`t-<tenant>-`). A second start for the same identity
 * collides with a running offboarding instead of starting another (OffboardingService starts with
 * WorkflowIdConflictPolicy.FAIL, the cascade to linked admin accounts records "running
 * elsewhere"); once it has closed, the id is free for a rerun. The identity id is a MongoDB
 * ObjectId, so the id holds no personal data.
 *
 * Dependency-free: workflow code imports it.
 */
export function offboardingWorkflowId(tenantId: string, identityId: string): string {
  return `t-${tenantId || 'default'}-offboard-${identityId}`;
}
