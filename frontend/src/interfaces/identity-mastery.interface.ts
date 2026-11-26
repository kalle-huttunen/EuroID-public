/**
 * GET /identity/:id/mastery: which HR source masters each profile field of an identity, and the
 * active overrides of an HR-mastered department or job title (identity controls).
 */

/** An active override (PATCH /identity/v2/:id/controls manualDepartment / manualJobTitle). */
export interface IAttributeControl {
  value: string;
  reason?: string;
  setBy?: string;
  setAt?: string;
  expiresAt?: string;
}

export interface IIdentityMastery {
  identityId: string;
  /** Profile field -> the HR source that masters it; PATCH /identity/:id refuses it (409). */
  masteredBy: Record<string, string>;
  attributeControls: Partial<Record<'departmentName' | 'jobTitle', IAttributeControl>>;
}

/**
 * PATCH /identity/v2/:id/controls for an override (operator): a value with a reason sets it,
 * `''` removes it. `expiresAt` (ISO date-time, future) only with a value.
 */
export interface IAttributeControlUpdate {
  manualDepartment?: string;
  manualJobTitle?: string;
  reason?: string;
  expiresAt?: string;
}
