/**
 * Expired access the hourly expiry run could not remove. Backend: `provisioning[]` of
 * GET /identity/v2/:id (viewer), and the admin actions POST /identity/:id/access/expiry/retry
 * (operator) and /removed-manually (policy-admin), modules/identity
 * (IdentityAccessExpiryController).
 */

/** The last failed removal of an expired entry, for the expiry date it names. */
export interface IExpiryFailure {
  /** ISO. A failure for another date than the entry's `expiresAt` counts as none. */
  expiresAt: string;
  /** ISO */
  failedAt: string;
  /** Why it failed; emails and LDAP names masked. */
  reason: string;
  /** False: not tried again until an admin acts or the expiry date changes. */
  retryable: boolean;
  attempts: number;
  /** ISO, retryable only: when the run tries again. */
  nextAttemptAt?: string;
}

/** One `provisioning[]` entry of the identity, the fields the expiry display reads. */
export interface IProvisioningEntry {
  targetSystem: string;
  status: 'PENDING' | 'SYNCING' | 'SYNCED' | 'ERROR' | 'DEPROVISIONED';
  /** ISO, time-bound access only. */
  expiresAt?: string;
  expiryFailure?: IExpiryFailure;
}
