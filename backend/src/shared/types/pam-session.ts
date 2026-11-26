/**
 * A target system's answer when a privileged session (privilegedSessionWorkflow) enables or
 * disables a linked admin account. Pure types: imported by connectors, activities and workflow
 * code (type-only). A failure is thrown, not returned.
 *
 * - done: the account is enabled (or disabled) now, whether or not it already was
 * - not-found: the target has no such account (the stored id or the login is unknown)
 */
export interface PamAccountResult {
  outcome: 'done' | 'not-found';
  /** What the target did or found, e.g. "unsuspended", "already active". No personal data. */
  detail?: string;
}

/** One account a privileged session enables and disables: a provisioned target of the admin. */
export interface PamSessionTarget {
  targetSystem: string;
  /** The account's id in the target (Entra object id, AD DN, SCIM or Okta id), when stored. */
  externalId?: string;
}

/** The admin identity's accounts, read by the session (getPrivilegedSessionTargets). */
export interface PamSessionTargets {
  /** The admin identity and its parent identity are live (not deleted): only then it is enabled. */
  live: boolean;
  /** The admin identity's UPN (its email): the account's login where no id is stored. */
  login?: string;
  targets: PamSessionTarget[];
}

/**
 * A linked admin account's status as its target reports it, read by the hourly standing-state
 * sweep before it starts a disable-only run (Okta only: an account waiting for its owner's
 * activation cannot sign in and cannot be suspended yet). `statusChanged`: when the target says
 * the status last changed, when it says. Null: the target has no such account.
 */
export interface PamAccountStatus {
  status: string;
  statusChanged?: string;
}

export type PamOktaStatusReader = (account: {
  oktaUserId?: string;
  login: string;
}) => Promise<PamAccountStatus | null>;
