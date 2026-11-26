/**
 * Tenant ownership of Temporal workflows read or controlled by id.
 *
 * Workflow ids are guessable (`t-<tenant>-bulk-<batch>-<ms>`, `t-<tenant>-onboard-<identityId>`,
 * never an email: plan 2.0dn), and a Temporal handle answers for any id in the namespace. So a
 * route that describes, queries, fetches the result or history of, signals or cancels a workflow
 * by an id from the request gets its handle here: every tenant workflow is started with the
 * `TenantId` search attribute, and a workflow without it, or with another tenant's, answers 404
 * exactly like a missing one. scripts/check-workflow-tenant-reads.sh fails on a getHandle()
 * anywhere else that is not allow-listed.
 */

import { NotFoundException } from '@nestjs/common';
import type { Client, WorkflowExecutionDescription, WorkflowHandle } from '@temporalio/client';
import { WorkflowNotFoundError } from '@temporalio/common';
import { getCurrentTenantId } from '../multi-tenancy/tenant-context.helper';
import { TENANT_SEARCH_ATTRIBUTE } from './tenant-search-attribute';

export { TENANT_SEARCH_ATTRIBUTE };

const firstString = (value: unknown): string | undefined => {
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' ? first : undefined;
};

/** The tenant a workflow was started for, from its `TenantId` search attribute. */
export function workflowTenantId(description: WorkflowExecutionDescription): string | undefined {
  const typed = description.typedSearchAttributes
    ?.getAll()
    .find((pair) => pair.key.name === TENANT_SEARCH_ATTRIBUTE);
  if (typed) return firstString(typed.value);
  // Untyped form: a server that returns no type metadata for the attribute.
  return firstString(description.searchAttributes?.[TENANT_SEARCH_ATTRIBUTE]);
}

/**
 * Handle and description of a workflow of the caller's tenant (request context), or 404.
 * `tenantId` overrides the request context for callers that already hold it.
 */
export async function getTenantWorkflow(
  client: Client,
  workflowId: string,
  tenantId: string = getCurrentTenantId(),
): Promise<{ handle: WorkflowHandle; description: WorkflowExecutionDescription }> {
  const handle = client.workflow.getHandle(workflowId);
  let description: WorkflowExecutionDescription;
  try {
    description = await handle.describe();
  } catch (err: unknown) {
    if (err instanceof WorkflowNotFoundError) throw new NotFoundException('Workflow not found');
    throw err;
  }
  if (workflowTenantId(description) !== tenantId) {
    throw new NotFoundException('Workflow not found');
  }
  return { handle, description };
}
