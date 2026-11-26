/**
 * How a failed deprovision call reaches Temporal. Connectors answer "gone" (404) themselves;
 * what is left here is a real failure:
 * - RateLimitedException (429) passes through: RateLimitActivityInterceptor retries it after
 *   the target's retry-after.
 * - A client error (4xx other than 408/409/429: bad credentials, missing permission, connector
 *   not configured, an account the API cannot resolve) fails at once: retrying cannot fix it.
 * - Anything else (5xx, network, timeout) is rethrown and retried per CONNECTOR_RETRY.
 * Messages reach workflow history and are shown on the identity timeline and the Leavers page,
 * so personal data in them is masked: email addresses, and the common name of an LDAP DN.
 */
import { ApplicationFailure } from '@temporalio/common';
import { RateLimitedException } from '@shared/errors/rate-limited.exception';
import { maskEmail, PII_MASK_CHAR } from '../modules/identity/identity-pii';

const EMAIL = /[^\s@"'<>()]+@[^\s@"'<>()]+\.[^\s@"'<>()]+/g;
/** The value of a DN's CN or UID (a person's name or login), up to the next unescaped comma. */
const DN_NAME = /\b(CN|UID)=((?:\\.|[^,;"'\n])+)/gi;
const RETRYABLE_CLIENT_STATUSES = new Set([408, 409, 429]);
/** Wait before retrying a 429 that names no delay. */
export const DEFAULT_RATE_LIMIT_MS = 60_000;

/** Retrying can fix a failure with this HTTP status: none (no answer), 408, 409, 429, or a 5xx. */
export function isRetryableStatus(status: number | undefined): boolean {
  return (
    status === undefined || status < 400 || status >= 500 || RETRYABLE_CLIENT_STATUSES.has(status)
  );
}

/** Failure type of a deprovision call that retrying cannot fix. */
export const DEPROVISION_REJECTED = 'DeprovisionRejected';

export function maskEmails(text: string): string {
  return text.replace(EMAIL, (match) => maskEmail(match));
}

/** Email addresses masked, and the CN/UID of LDAP DNs (`CN=Ada Lovelace,OU=..` -> `CN=•••,OU=..`). */
export function maskPersonalData(text: string): string {
  return maskEmails(
    text.replace(DN_NAME, (_match, attr: string) => `${attr}=${PII_MASK_CHAR.repeat(3)}`),
  );
}

/** HTTP status of an axios error, a Nest HttpException (ConnectorException, SCIMError). */
export function httpStatusOf(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const response = (err as { response?: { status?: unknown } }).response;
  if (typeof response?.status === 'number') return response.status;
  const getStatus = (err as { getStatus?: () => unknown }).getStatus;
  if (typeof getStatus === 'function') {
    const status = getStatus.call(err);
    return typeof status === 'number' ? status : undefined;
  }
  return undefined;
}

/** A 429 as RateLimitedException, waiting the response's retry-after (seconds). */
function rateLimitOf(system: string, err: unknown): RateLimitedException {
  const headers = (err as { response?: { headers?: Record<string, unknown> } }).response?.headers;
  const retryAfter = parseInt(String(headers?.['retry-after'] ?? ''), 10);
  return new RateLimitedException(
    isNaN(retryAfter) ? DEFAULT_RATE_LIMIT_MS : Math.max(1000, retryAfter * 1000),
    system,
  );
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** The error to throw from a deprovision activity for `err`. */
export function asDeprovisionFailure(system: string, err: unknown): unknown {
  if (err instanceof RateLimitedException || err instanceof ApplicationFailure) return err;
  const status = httpStatusOf(err);
  if (status === 429) return rateLimitOf(system, err);
  const original = messageOf(err);
  const message = maskPersonalData(`${system}: ${original}`);
  if (!isRetryableStatus(status)) {
    return ApplicationFailure.nonRetryable(`${message} (HTTP ${status})`, DEPROVISION_REJECTED);
  }
  if (err instanceof Error) {
    // Temporal writes the stack trace into history too; it starts with the original message.
    // Read it before the message changes: V8 builds its first line from the message lazily.
    const stack = err.stack;
    err.message = message;
    if (original && typeof stack === 'string') {
      err.stack = stack.replace(original, () => message);
    }
    return err;
  }
  return new Error(message);
}
