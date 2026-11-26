/**
 * Per-system outcome of removing a leaver's access. Pure types: imported by connectors,
 * activities, the offboarding workflow (type-only), domain events and the leavers module.
 *
 * - deprovisioned: the target removed or disabled the account in this run
 * - already-gone: the target has no such account any more (404, no match): nothing to do
 * - not-applicable: the target keeps no account (notification or log targets)
 * - failed: the account may still have access; `reason` says why (after Temporal's retries)
 * - removed-manually: it had failed, and an admin confirmed removing the account by hand
 *   (`manualRemoval`); EuroID did not remove it
 */
export type DeprovisionOutcome =
  | 'deprovisioned'
  | 'already-gone'
  | 'not-applicable'
  | 'failed'
  | 'removed-manually';

/** A connector's answer to a deprovision call. A failure is thrown, not returned. */
export interface DeprovisionResult {
  outcome: 'deprovisioned' | 'already-gone';
  /** What the target did, e.g. "deactivated", "pending invitation cancelled". No personal data. */
  detail?: string;
}

/** One target system in an offboarding result. */
export interface OffboardingSystemResult {
  system: string;
  outcome: DeprovisionOutcome;
  /** What the target did (deprovisioned, already-gone). */
  detail?: string;
  /** Why it failed or why it is not applicable (kept when an admin closes a failed target). */
  reason?: string;
  /** removed-manually: the admin who confirmed it (authenticated user), when, and their note. */
  manualRemoval?: ManualRemoval;
}

/** An admin's confirmation that a failed target's account was removed outside EuroID. */
export interface ManualRemoval {
  by: string;
  /** ISO timestamp. */
  at: string;
  reason: string;
}

/**
 * What became of a linked admin identity (PAM) when the person it belongs to was offboarded:
 * - offboarded: its own offboarding (a child workflow) removed its accounts and deleted it
 * - failed: the account may still exist, so the person's offboarding counts it as failed (Golden
 *   Record suspended): its offboarding failed or left a target failed, or the admin identity was
 *   still live right before the person would have been deleted (its offboarding elsewhere had
 *   not finished, or it was linked while the person's offboarding ran); `reason` says which
 * - running-elsewhere: an offboarding of it was already running (another trigger); that run
 *   reports its own result, the person's offboarding did not wait for it. It had finished (the
 *   admin identity deleted) by the time the person was deleted, else it would be `failed`
 */
export type LinkedAdminOffboardingOutcome = 'offboarded' | 'failed' | 'running-elsewhere';

/** One linked admin identity in an offboarding result. */
export interface OffboardingLinkedAdminResult {
  identityId: string;
  /** Its offboarding workflow (`t-<tenant>-offboard-<identityId>`). */
  workflowId: string;
  outcome: LinkedAdminOffboardingOutcome;
  /** Why it failed or why it was not waited for. */
  reason?: string;
}

/**
 * Result of one offboarding run. `hubStatus`: the Golden Record is soft-deleted when no target
 * and no linked admin account failed, otherwise suspended (login disabled) and kept so the
 * remaining access stays visible. `linkedAdmins`: the person's live linked admin identities, each
 * offboarded first (absent when there were none, and for runs from before the cascade).
 */
export interface OffboardingResult {
  identityId: string;
  workflowId: string;
  status: 'completed' | 'partial-failure';
  hubStatus: 'deleted' | 'suspended';
  systems: OffboardingSystemResult[];
  linkedAdmins?: OffboardingLinkedAdminResult[];
}
