/**
 * Workflow id of an admin identity's privileged session (privileged-session.workflow.ts): one per
 * admin identity, under the tenant prefix every tenant workflow id has (`t-<tenant>-`). An
 * activation collides with a session or disable run that is still running instead of starting a
 * second one; once it has closed, the id is free for the next session (Temporal's default id
 * reuse policy). The admin identity id is a MongoDB ObjectId, so the id holds no personal data.
 *
 * PamSessionService starts, signals and signal-starts runs under it. Dependency-free.
 */
export function privilegedSessionWorkflowId(tenantId: string, adminIdentityId: string): string {
  return `t-${tenantId || 'default'}-pam-session-${adminIdentityId}`;
}
