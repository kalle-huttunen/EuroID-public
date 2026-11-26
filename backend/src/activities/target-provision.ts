/**
 * Onboarding's provision calls to the targets without a task queue of their own (GitHub,
 * ServiceNow, Discord webhook, Google Sheets, File outbound): their result, and how a failure
 * reaches Temporal. The connectors load their saved config themselves, so no secret passes
 * through workflow history.
 */
import { ApplicationFailure } from '@temporalio/common';
import { RateLimitedException } from '@shared/errors/rate-limited.exception';
import { maskPersonalData } from './deprovision-failure';

/** A target's answer to an onboarding provision call. A failure is thrown, not returned. */
export interface TargetProvisionResult {
  success: true;
  /**
   * The account's id in the target, which onboarding writes back to the identity's account
   * record (offboarding reads it there). Absent when the target keeps no account.
   */
  objectId?: string;
  /** What the target did, e.g. "no account: welcome message posted". No personal data. */
  detail: string;
}

/**
 * Whom a provisioning event (provisioning.completed / .failed) is about: the identity's id from
 * the profile the activity got, never its email. A profile without `_id` (bulk rows, PAM admin
 * profiles) has no identity id: the event then goes under the connector, identityId left out.
 */
export function provisioningSubject(
  user: { _id?: unknown },
  connector: string,
): { aggregateId: string; identityId?: string } {
  const identityId = user._id ? String(user._id) : undefined;
  return { aggregateId: identityId ?? connector, identityId };
}

/**
 * The account id a provisioning or deprovision event may carry: none when it is an email address
 * or a UPN (an Entra ID user removed by UPN, a target that keys accounts by email), because the
 * event reaches the audit log and the websocket. Callers leave an AD DN out themselves: it holds
 * the person's name.
 */
export function eventAccountId(accountId: string | undefined): string | undefined {
  return accountId && !accountId.includes('@') ? accountId : undefined;
}

/**
 * The error to throw from a provision activity for `err`: rate limits and Temporal failures pass
 * through, anything else keeps its retry behaviour (CONNECTOR_RETRY) with the email addresses in
 * its message masked, because the message reaches workflow history.
 */
export function asProvisionFailure(system: string, err: unknown): unknown {
  if (err instanceof RateLimitedException || err instanceof ApplicationFailure) return err;
  const message = maskPersonalData(
    `${system}: ${err instanceof Error ? err.message : String(err)}`,
  );
  if (err instanceof Error) {
    err.message = message;
    return err;
  }
  return new Error(message);
}
