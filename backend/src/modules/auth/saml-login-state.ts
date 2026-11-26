/**
 * The state of one SP-initiated SAML sign-in, from GET /auth/saml/login to POST
 * /auth/saml/exchange (docs/architecture/security/PLATFORM_AUTH_ARCHITECTURE.md, SAML).
 *
 * - The login sets a random binding value in an HttpOnly SameSite cookie, and keeps its SHA-256
 *   with the page to return to under a random RelayState id in the security state store.
 * - The IdP posts the RelayState back with the response; the callback takes that state and stores
 *   the binding hash with the one-time code.
 * - The exchange answers only to the browser whose cookie hashes to it. A code opened in another
 *   browser (a victim sent `/auth/saml-callback?code=<attacker's code>`) signs nobody in.
 *
 * The cookie is never read at the callback: that is a cross-site POST from the IdP, which a
 * SameSite cookie does not ride on. The exchange is a same-site request from the console.
 */
import { createHash, timingSafeEqual } from 'crypto';
import type { Response } from 'express';
import { isDevOrTest } from '@infrastructure/config/runtime-env';
import type { SignInResult } from './auth-local.service';

export const SAML_BINDING_COOKIE = 'saml_binding';
/** The SAML routes only: the cookie rides on nothing else. */
const SAML_BINDING_COOKIE_PATH = '/api/v1/auth/saml';
/** A RelayState this deployment issued: 32 hex characters (randomBytes(16)). */
const RELAY_STATE_PATTERN = /^[0-9a-f]{32}$/;
/** The longest return path carried through the sign-in. */
const MAX_RETURN_PATH_LENGTH = 2048;

/** What the login keeps under its RelayState until the IdP posts the response back. */
export interface SamlLoginState {
  bindingHash: string;
  /** A same-origin path of the console (safeReturnPath). */
  returnUrl?: string;
}

/** What a one-time code stands for: the sign-in result, and the browser it is bound to. */
export interface SamlCodeEntry {
  payload: SignInResult;
  /** Unset only for an IdP-initiated sign-in (SAML_VALIDATE_IN_RESPONSE_TO=ifPresent). */
  bindingHash?: string;
}

export const relayStateKey = (relayState: string) => `saml:relay:${relayState}`;

export function isIssuedRelayState(value: unknown): value is string {
  return typeof value === 'string' && RELAY_STATE_PATTERN.test(value);
}

export function hashBinding(binding: string): string {
  return createHash('sha256').update(binding).digest('hex');
}

/** Whether `binding` (the cookie) hashes to `expectedHash`, compared in constant time. */
export function bindingMatches(expectedHash: string, binding: string | undefined): boolean {
  if (!binding) return false;
  const expected = Buffer.from(expectedHash, 'hex');
  const actual = Buffer.from(hashBinding(binding), 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * `url` when it is a path of the console's own origin, else undefined: it starts with one slash,
 * holds no `//`, backslash, colon or control character, and is at most 2048 characters. The same
 * rule as the console's isSafeReturnUrl (frontend/src/auth/auth-utils.ts).
 */
export function safeReturnPath(url: unknown): string | undefined {
  if (typeof url !== 'string' || url.length === 0 || url.length > MAX_RETURN_PATH_LENGTH) {
    return undefined;
  }
  const safe =
    url.startsWith('/') &&
    !url.includes('//') &&
    !url.includes('\\') &&
    !url.includes(':') &&
    !/[\u0000-\u001f\u007f]/.test(url);
  return safe ? url : undefined;
}

const cookieOptions = () => ({
  httpOnly: true,
  secure: !isDevOrTest(),
  sameSite: 'strict' as const,
  path: SAML_BINDING_COOKIE_PATH,
});

export function setBindingCookie(res: Response, binding: string, maxAgeMs: number): void {
  res.cookie(SAML_BINDING_COOKIE, binding, { ...cookieOptions(), maxAge: maxAgeMs });
}

export function clearBindingCookie(res: Response): void {
  res.clearCookie(SAML_BINDING_COOKIE, cookieOptions());
}
