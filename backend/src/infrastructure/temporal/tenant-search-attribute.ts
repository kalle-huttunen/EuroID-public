/**
 * Search attribute every tenant workflow is started with (registered as Keyword or Text).
 *
 * Dependency-free so workflow code can import it (child-workflow-tenant.ts); the Nest side reads
 * it in tenant-workflow.ts.
 */
export const TENANT_SEARCH_ATTRIBUTE = 'TenantId';

/**
 * The visibility query (list filter) for the workflows of `tenantId`. The id is written as one
 * double-quoted string literal with its backslashes and double quotes escaped, so an id from an
 * IdP claim cannot end the literal and widen the query to other tenants.
 */
export function tenantVisibilityQuery(tenantId: string): string {
  const literal = tenantId.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `${TENANT_SEARCH_ATTRIBUTE} = "${literal}"`;
}
