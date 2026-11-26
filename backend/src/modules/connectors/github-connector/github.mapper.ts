/**
 * GitHub mapping: pure functions, no HTTP, no side effects.
 *
 * - The identity's GitHub login: the custom attribute `githubLogin` (optional; mapped from HR
 *   like any custom attribute, or set on the identity page).
 * - The account id onboarding writes back: `github-user-<id>` (GitHub's durable user id) when it
 *   invited a GitHub account, `github-invitation-<id>` when it invited an email address.
 */

import { HttpStatus } from '@nestjs/common';
import { ConnectorException } from '@shared/exceptions/domain-exceptions';

/** Custom attribute holding the person's GitHub login. */
export const GITHUB_LOGIN_ATTRIBUTE = 'githubLogin';

/**
 * Letters, digits and hyphens, at most 39 characters (GitHub's username limit). Looser than
 * GitHub's current sign-up rule (no leading, trailing or double hyphen) so older logins pass;
 * anything that could change the request path (slash, dot, space) is refused.
 */
const GITHUB_LOGIN = /^[A-Za-z0-9-]{1,39}$/;

const USER_ID_PREFIX = 'github-user-';

/**
 * The GitHub login in `customAttributes`, trimmed; undefined when absent or empty. A value that
 * is not a GitHub login is an error (422): the identity names an account that cannot exist.
 * The message names the attribute, never its value (personal data).
 */
export function githubLoginOf(
  customAttributes: Record<string, unknown> | null | undefined,
): string | undefined {
  const raw = customAttributes?.[GITHUB_LOGIN_ATTRIBUTE];
  if (raw === undefined || raw === null) return undefined;
  const login = typeof raw === 'string' || typeof raw === 'number' ? String(raw).trim() : null;
  if (login === '') return undefined;
  if (login === null || !GITHUB_LOGIN.test(login)) {
    throw new ConnectorException(
      `customAttributes.${GITHUB_LOGIN_ATTRIBUTE} is not a GitHub login ` +
        '(letters, digits and hyphens, at most 39 characters)',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
  return login;
}

/** Account id written back for an invited GitHub account. */
export function githubUserObjectId(userId: number): string {
  return `${USER_ID_PREFIX}${userId}`;
}

/** GitHub's user id in a written-back account id; undefined for any other id (an invitation's). */
export function githubUserIdOf(objectId: string | undefined): number | undefined {
  if (!objectId?.startsWith(USER_ID_PREFIX)) return undefined;
  const digits = objectId.slice(USER_ID_PREFIX.length);
  return /^\d{1,19}$/.test(digits) ? Number(digits) : undefined;
}
