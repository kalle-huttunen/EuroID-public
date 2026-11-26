/**
 * Shared constants for Identity sub-services.
 */

/** Fields that trigger auto-sync to target systems when changed. */
export const CRITICAL_FIELDS = ['departmentName', 'jobTitle', 'location', 'managerEmail'];

/** Filter to exclude soft-deleted identities. Use `{ ...NOT_DELETED }` in queries. */
export const NOT_DELETED = { deletedAt: null } as const;

/**
 * Default tenant for legacy documents when context/config omit tenantId.
 * WARNING: Falling back to this value indicates a missing tenant context.
 * All new code paths should ensure tenantId is set via request context or
 * withTenantContext() rather than relying on this fallback.
 */
export const DEFAULT_TENANT = process.env.DEFAULT_TENANT_ID || 'default';

let _tenantFallbackWarned = false;
/** Return DEFAULT_TENANT but log a one-time warning so operators can track fallback usage. */
export function getDefaultTenantWithWarning(caller: string): string {
  if (!_tenantFallbackWarned) {
    // eslint-disable-next-line no-console
    console.warn(
      `[SECURITY] ${caller}: falling back to DEFAULT_TENANT "${DEFAULT_TENANT}". ` +
        `This indicates a missing tenant context — investigate and fix the caller.`,
    );
    _tenantFallbackWarned = true;
  }
  return DEFAULT_TENANT;
}

/**
 * Max sources (linked accounts) per Identity to prevent unbounded array growth.
 *
 * Rationale: Each source carries rawData (full connector payload), so 50 sources
 * can produce ~500KB documents. MongoDB per-document updates become costly above
 * this threshold. In practice, an identity rarely connects to more than 20 systems
 * (1 HR + a handful of target systems). The cap of 50 provides generous headroom
 * while preventing accidental runaway growth from misconfigured connectors.
 */
export const MAX_SOURCES = 50;

/**
 * Warning threshold: emit IDENTITY_SOURCES_APPROACHING_LIMIT when source count
 * reaches this value. Allows operators to investigate before the hard cap is hit.
 */
export const SOURCES_WARNING_THRESHOLD = 40;

/** Max candidates for heuristic name correlation — prevents memory DoS on common surnames (IV-5). */
export const CORRELATION_NAME_CANDIDATE_LIMIT =
  parseInt(process.env.CORRELATION_NAME_CANDIDATE_LIMIT ?? '500', 10) || 500;

/** Max page size for identity list — prevents pagination DoS (F2). */
export const IDENTITY_PAGE_MAX = parseInt(process.env.IDENTITY_PAGE_MAX ?? '500', 10) || 500;
