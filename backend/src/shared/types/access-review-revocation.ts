/**
 * Access review revocation: what happened to one revoked entitlement. Pure types: imported by
 * the access review activities, the review item schema and the access review workflow
 * (type-only, plus the constant list), so this file must stay free of runtime dependencies.
 *
 * - removed: the target removed the access in this run
 * - already-gone: the target no longer has it (not a member any more, or the group or the
 *   account no longer exists)
 * - manual-action-needed: EuroID cannot remove this kind of access in that system; nothing was
 *   changed and `reason` says what an admin must do
 * - failed: removing it failed (after Temporal's retries); the access may still be there and
 *   `reason` says why
 */
export type RevocationOutcome = 'removed' | 'already-gone' | 'manual-action-needed' | 'failed';

/** Connectors an access review revokes through, each on its own task queue. */
export const REVOCATION_CONNECTORS = ['entra', 'ad', 'okta', 'scim'] as const;
export type RevocationConnector = (typeof REVOCATION_CONNECTORS)[number];

/**
 * How a task is revoked: a group membership through its connector, or `account` (runs with the
 * workflow patch access-review:account-revocation): the entitlement is the identity's account in
 * a target whose memberships EuroID cannot read, removed through offboarding's per-target
 * deprovision on the default queue (revokeReviewAccount).
 */
export type RevocationVia = RevocationConnector | 'account';

/** A connector's answer to one revocation. A failure is thrown, not returned. */
export interface ConnectorRevocationResult {
  outcome: 'removed' | 'already-gone' | 'manual-action-needed';
  /** What the target did or found, e.g. "removed from group". No personal data. */
  detail?: string;
  /** manual-action-needed: what an admin must do instead. */
  reason?: string;
}

/**
 * One entitlement to revoke as it travels through workflow history: ids only. The activity
 * reads the account and the group from the review item, so no email or DN enters the history.
 */
export interface RevocationTask {
  itemId: string;
  /** Position of the entitlement in the review item's `entitlements`. */
  entitlementIndex: number;
  connector: RevocationVia;
}

/** The outcome of one task, recorded on the review item's entitlement. */
export interface RevocationTaskResult {
  itemId: string;
  entitlementIndex: number;
  outcome: RevocationOutcome;
  detail?: string;
  reason?: string;
}

/** One batch of tasks; `more` is true when the batch was full and further items may wait. */
export interface RevocationBatch {
  tasks: RevocationTask[];
  more: boolean;
}

/**
 * Payload of access_review.account_revoked (re-exported by event-payloads.ts): the removal of a
 * revoked account item at campaign close. Actor: the reviewer who revoked it, or the system for
 * an expired item the campaign auto-revokes. Ids and the target system only; detail and reason
 * are masked.
 */
export interface AccessReviewAccountRevokedPayload {
  identityId: string;
  campaignId: string;
  itemId: string;
  targetSystem: string;
  outcome: RevocationOutcome;
  /** What the target did or found (removed, already-gone). */
  detail?: string;
  /** Why it failed, or what an admin must do (manual-action-needed). */
  reason?: string;
}

/**
 * Payload of access_review.membership_revoked (re-exported by event-payloads.ts): the removal of
 * a revoked group membership (Entra ID, AD, Okta, SCIM) at campaign close. Actor as for
 * access_review.account_revoked. Ids and the target system only: `groupId` is the group's id in
 * the target (the review entitlement's nativeId), never its name; detail and reason are masked.
 */
export interface AccessReviewMembershipRevokedPayload extends AccessReviewAccountRevokedPayload {
  groupId?: string;
}

/** Per-outcome counts over a campaign's revoked entitlements (campaign `revocationSummary`). */
export interface RevocationSummary {
  removed: number;
  alreadyGone: number;
  manualActionNeeded: number;
  failed: number;
}
