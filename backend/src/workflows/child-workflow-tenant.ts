/**
 * Start options that carry the parent workflow's tenant to a child workflow.
 *
 * Temporal copies neither search attributes nor memo to a child. getTenantWorkflow()
 * (infrastructure/temporal/tenant-workflow.ts) answers 404 for a workflow without the TenantId
 * search attribute, and the dev-tools list filters on it, so a child started without it was
 * unreadable for its own tenant. Each parent calls this behind its own patch: histories from
 * before the patch started their children without these options.
 */
import { workflowInfo, type ChildWorkflowOptions } from '@temporalio/workflow';
import { TENANT_SEARCH_ATTRIBUTE } from '../infrastructure/temporal/tenant-search-attribute';
import { isPatched } from './workflow-versioning';

export function inheritTenantAttributes(
  patchId: string,
): Pick<ChildWorkflowOptions, 'searchAttributes' | 'memo'> {
  if (!isPatched(patchId)) return {};
  // The untyped form: services start workflows with untyped searchAttributes, whose payloads
  // carry no type metadata, so typedSearchAttributes would not list TenantId.
  const { searchAttributes, memo } = workflowInfo();
  const tenant = searchAttributes?.[TENANT_SEARCH_ATTRIBUTE];
  return {
    ...(tenant?.length ? { searchAttributes: { [TENANT_SEARCH_ATTRIBUTE]: tenant } } : {}),
    ...(memo ? { memo } : {}),
  };
}
