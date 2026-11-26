export interface ActivityContext {
  tenantId: string;
  correlationId?: string;
  actor?: string;
}

/**
 * Validates that activity context has a non-empty tenantId.
 * Call at the start of every activity method that uses tenant context.
 * @throws Error if tenantId is empty — multi-tenancy boundary violation
 */
export function validateActivityContext(ctx: ActivityContext): void {
  if (!ctx.tenantId?.trim()) {
    throw new Error('[SECURITY] tenantId is required for all activity operations');
  }
}
