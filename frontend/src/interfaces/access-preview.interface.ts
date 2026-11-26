/**
 * Access preview and re-evaluation of one identity (backend: modules/mover,
 * GET /identity/:id/access/preview, POST /identity/:id/access/re-evaluate).
 * The preview compares the current profile with the access baseline: the profile values the
 * identity's access was last applied with.
 */

/** One entitlement a re-evaluation would add or remove. */
export interface IAccessPreviewEntitlement {
  type: string;
  target: string;
  targetId: string;
  sourcePolicy?: string;
  /**
   * False for a change the mover does not apply: a system other than Entra ID, AD, Okta and SCIM,
   * or a kind of entitlement its connector does not change.
   */
  appliedByMover: boolean;
}

export interface IAccessPreview {
  identityId: string;
  /** When the baseline was last recorded (ISO); null when the identity has none. */
  baselineRecordedAt: string | null;
  /** Attributes that changed since access was last applied: baseline value, current value. */
  changes: Array<{ field: string; before: unknown; after: unknown }>;
  toAdd: IAccessPreviewEntitlement[];
  toRemove: IAccessPreviewEntitlement[];
  /** Target systems where the identity has an account (SYNCED once, also while in ERROR). */
  provisionedTargets: string[];
  canReevaluate: boolean;
  /** Why it cannot be re-evaluated, when canReevaluate is false. */
  blockedReason?: string;
}

/** 202 answer of POST /identity/:id/access/re-evaluate. */
export interface IAccessReevaluation {
  workflowId: string;
  changedFields: string[];
}
