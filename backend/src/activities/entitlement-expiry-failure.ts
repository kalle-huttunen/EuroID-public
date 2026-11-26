/**
 * Expired provisioning entries that entitlementExpiryWorkflow could not deprovision. The run
 * records each failure on the entry (`provisioning[].expiryFailure`) for the expiresAt it was for,
 * so neither its own next batch nor later runs pick the entry again before they should:
 * - not retryable (a target with no deprovision, no connector config, no account to find, a
 *   client error from the target): skipped until the entry's expiresAt changes, or until an admin
 *   retries it or closes it as removed manually (POST /identity/:id/access/expiry/...);
 * - retryable (5xx, network, timeout, 429): tried again from `nextAttemptAt`, ENTITLEMENT_EXPIRY_
 *   RETRY_BASE_MS (1 hour) after the first failure, doubling up to ENTITLEMENT_EXPIRY_RETRY_MAX_MS
 *   (1 day).
 * Retryable or not follows offboarding's rule (asDeprovisionFailure). Reasons are masked (emails,
 * LDAP DN names): they reach the audit log, the identity timeline and webhook subscribers.
 */
import { ApplicationFailure } from '@temporalio/common';
import type { ProvisioningState } from '../modules/identity/schemas/identity.schema';
import type { DeprovisionResult } from '@shared/types/deprovision';
import { maskPersonalData } from './deprovision-failure';

const HOUR_MS = 60 * 60 * 1000;

/** A positive number of milliseconds from the environment, else the fallback. */
function positiveMs(value: string | undefined, fallback: number): number {
  const ms = parseInt(value ?? '', 10);
  return Number.isFinite(ms) && ms > 0 ? ms : fallback;
}

export const EXPIRY_RETRY_BASE_MS = positiveMs(
  process.env.ENTITLEMENT_EXPIRY_RETRY_BASE_MS,
  HOUR_MS,
);
export const EXPIRY_RETRY_MAX_MS = positiveMs(
  process.env.ENTITLEMENT_EXPIRY_RETRY_MAX_MS,
  24 * HOUR_MS,
);

export type ExpiryFailure = NonNullable<ProvisioningState['expiryFailure']>;

/**
 * What deprovisioning one expired entry came to. Removed (the entry becomes DEPROVISIONED) as in
 * offboarding: the target removed or disabled the account, it had no such account any more
 * (already-gone), or it keeps no account (not-applicable); `detail` says what the target did.
 */
export type DeprovisionOutcome =
  | {
      deprovisioned: true;
      outcome: DeprovisionResult['outcome'] | 'not-applicable';
      detail?: string;
    }
  | { deprovisioned: false; reason: string; retryable: boolean };
export type DeprovisionFailure = Extract<DeprovisionOutcome, { deprovisioned: false }>;

/** A failure no retry gets past (no deprovision for the target, no config or account id). */
export function notDeprovisionable(reason: string): DeprovisionFailure {
  return { deprovisioned: false, reason: maskPersonalData(reason), retryable: false };
}

/**
 * The failure of a deprovision activity that threw `err`. The activities pass their errors
 * through asDeprovisionFailure (offboarding's rule), which names the target and masks the
 * message: what retrying cannot fix is a non-retryable ApplicationFailure, the rest is retryable.
 */
export function failedWith(err: unknown): DeprovisionFailure {
  const retryable = !(err instanceof ApplicationFailure && err.nonRetryable);
  const message = err instanceof Error ? err.message : String(err);
  return { deprovisioned: false, reason: maskPersonalData(message), retryable };
}

/** Wait before the next attempt after `attempts` retryable failures in a row. */
export function retryDelayMs(attempts: number): number {
  const doublings = Math.max(0, Math.min(attempts - 1, 30));
  return Math.min(EXPIRY_RETRY_BASE_MS * 2 ** doublings, EXPIRY_RETRY_MAX_MS);
}

const time = (value: Date | string | undefined | null) => (value ? new Date(value).getTime() : NaN);

/** The failure recorded for the entry's current expiresAt, if any. */
function currentFailure(entry: ProvisioningState): ExpiryFailure | undefined {
  const failure = entry.expiryFailure;
  if (!failure || time(failure.expiresAt) !== time(entry.expiresAt)) return undefined;
  return failure;
}

/**
 * True when a run at `now` should deprovision the entry: expired, not DEPROVISIONED, and no
 * failure recorded for this expiresAt, or a retryable one whose next attempt is due.
 */
export function isExpiryDue(entry: ProvisioningState, now: Date): boolean {
  const expiresAt = time(entry.expiresAt);
  if (!(expiresAt <= now.getTime()) || entry.status === 'DEPROVISIONED') return false;
  const failure = currentFailure(entry);
  return !failure || time(failure.nextAttemptAt) <= now.getTime();
}

/**
 * isExpiryDue as a query condition: an identity with at least one such entry. `$expr` compares an
 * entry's expiryFailure.expiresAt with its own expiresAt, which `$elemMatch` cannot.
 */
export function expiryDueExpr(now: Date): Record<string, unknown> {
  const isDate = (path: string) => ({ $eq: [{ $type: path }, 'date'] });
  return {
    $anyElementTrue: [
      {
        $map: {
          input: { $ifNull: ['$provisioning', []] },
          as: 'p',
          in: {
            $and: [
              isDate('$$p.expiresAt'),
              { $lte: ['$$p.expiresAt', now] },
              { $ne: ['$$p.status', 'DEPROVISIONED'] },
              {
                $or: [
                  { $ne: ['$$p.expiryFailure.expiresAt', '$$p.expiresAt'] },
                  {
                    $and: [
                      isDate('$$p.expiryFailure.nextAttemptAt'),
                      { $lte: ['$$p.expiryFailure.nextAttemptAt', now] },
                    ],
                  },
                ],
              },
            ],
          },
        },
      },
    ],
  };
}

/**
 * The failure to record on the entry after a failed attempt at `now`: attempts counts the
 * failures for the same expiresAt; a retryable one gets its next attempt time.
 */
export function nextExpiryFailure(
  entry: ProvisioningState,
  failure: DeprovisionFailure,
  now: Date,
  failedAt: Date,
): ExpiryFailure {
  const attempts = (currentFailure(entry)?.attempts ?? 0) + 1;
  return {
    expiresAt: entry.expiresAt as Date,
    failedAt,
    reason: failure.reason,
    retryable: failure.retryable,
    attempts,
    ...(failure.retryable
      ? { nextAttemptAt: new Date(now.getTime() + retryDelayMs(attempts)) }
      : {}),
  };
}
