/**
 * Auth-related validation utilities for security (XSS, open redirect defense-in-depth).
 */

/** The longest return URL accepted: the backend's MAX_RETURN_PATH_LENGTH (saml-login-state.ts). */
export const MAX_RETURN_URL_LENGTH = 2048;

/** A control character: a browser strips a tab or newline, so "/\t/evil.example" is "//evil.example". */
function hasControlChar(url: string): boolean {
  for (let i = 0; i < url.length; i++) {
    const code = url.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * Validates returnUrl is a same-origin path before redirect. Prevents open redirect. The same
 * rule as the backend's safeReturnPath (backend/src/modules/auth/saml-login-state.ts).
 */
export function isSafeReturnUrl(url: string): boolean {
  return (
    typeof url === 'string' &&
    url.length > 0 &&
    url.length <= MAX_RETURN_URL_LENGTH &&
    url.startsWith('/') &&
    !url.includes('//') &&
    // A browser reads a backslash as a slash: /\evil.example would leave the origin
    !url.includes('\\') &&
    !url.includes(':') &&
    !hasControlChar(url)
  );
}

/** Returns safe return URL or fallback. */
export function getSafeReturnUrl(stored: string | null, fallback: string): string {
  return stored && isSafeReturnUrl(stored) ? stored : fallback;
}

/** Characters that could enable XSS if rendered. Reject saml_error containing these. */
const UNSAFE_ERROR_CHARS = /[<>"'`]/;

/** Validates saml_error from URL before decode/display. Returns decoded string or null if unsafe. */
export function sanitizeSamlError(raw: string | null): string | null {
  if (!raw || typeof raw !== 'string') return null;
  try {
    const decoded = decodeURIComponent(raw);
    return UNSAFE_ERROR_CHARS.test(decoded) ? null : decoded;
  } catch {
    return null;
  }
}
