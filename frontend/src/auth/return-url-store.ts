/**
 * The page to return to after a sign-in: across the OIDC redirect to the IdP, the SAML sign-in
 * (which also carries it through its RelayState) and the console's own password sign-in.
 *
 * Kept in sessionStorage: the sign-in is a full-page navigation, so module memory is gone when
 * AuthCallback reads it. sessionStorage is per tab and per origin, and only a same-origin path
 * (isSafeReturnUrl) is stored or handed back, so a planted value cannot redirect off the console.
 */
import { isSafeReturnUrl } from './auth-utils';

const KEY = 'euroid.returnUrl';

function storage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null; // storage blocked: the sign-in lands on the default page
  }
}

export function setReturnUrl(url: string): void {
  if (isSafeReturnUrl(url)) storage()?.setItem(KEY, url);
}

/** The stored path, or null when none is stored or it is not a same-origin path. */
export function getReturnUrl(): string | null {
  const url = storage()?.getItem(KEY) ?? null;
  return url && isSafeReturnUrl(url) ? url : null;
}

export function clearReturnUrl(): void {
  storage()?.removeItem(KEY);
}

/** The stored path, used up: the next sign-in goes to the default page again. */
export function takeReturnUrl(fallback = '/'): string {
  const url = getReturnUrl();
  clearReturnUrl();
  return url ?? fallback;
}
