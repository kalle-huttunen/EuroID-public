/**
 * Live identities of a tenant by HR employee id (`profile.employeeId`), read through an index.
 *
 * An HR feed may name a person's manager only by `managerId`, the manager's employee id. An
 * access review gives such a person's items to that manager (AccessReviewCampaignService
 * resolveReviewer), so the manager is looked up by employee id among the tenant's live
 * identities. EMPLOYEE_ID_INDEX keeps that lookup to the matching identities.
 */

/** Name of the index (identity.schema.ts, migration 20261126000004). */
export const EMPLOYEE_ID_INDEX = 'tenantId_1_profile.employeeId_1';

/** The index key and options; the schema and the migration both use these. */
export const EMPLOYEE_ID_INDEX_KEY = { tenantId: 1, 'profile.employeeId': 1 } as const;
export const EMPLOYEE_ID_INDEX_OPTIONS = { name: EMPLOYEE_ID_INDEX };

/** The live identities of the tenant whose employee id is one of `employeeIds`. */
export function liveEmployeeIdFilter(
  tenantId: string,
  employeeIds: string[],
): Record<string, unknown> {
  return { tenantId, 'profile.employeeId': { $in: employeeIds }, deletedAt: null };
}
