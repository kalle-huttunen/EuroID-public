import { randomUUID } from 'crypto';
import {
  requestContext,
  RequestContext,
} from '../middleware/correlation.middleware';

/**
 * Execute a function within an explicit tenant context.
 * Used by Temporal activities, event handlers, and background jobs
 * that run outside of an HTTP request.
 */
export function withTenantContext<T>(
  tenantId: string,
  fn: () => T | Promise<T>,
  options?: { actor?: string; correlationId?: string },
): T | Promise<T> {
  if (!tenantId || typeof tenantId !== 'string' || !tenantId.trim()) {
    throw new Error(
      'withTenantContext() requires a non-empty tenantId. ' +
        'Ensure the caller passes a valid tenantId from the workflow input or event payload.',
    );
  }
  const ctx: RequestContext = {
    correlationId: options?.correlationId ?? randomUUID(),
    actor: options?.actor ?? 'system',
    tenantId,
    startTime: Date.now(),
  };
  return requestContext.run(ctx, fn);
}

/**
 * Get the current tenant ID from AsyncLocalStorage.
 * Throws if no tenant context is set.
 */
export function getCurrentTenantId(): string {
  const ctx = requestContext.getStore();
  if (!ctx?.tenantId) {
    throw new Error(
      'No tenant context available. Ensure request has tenantId or use withTenantContext().',
    );
  }
  return ctx.tenantId;
}
