/**
 * isSafeReturnUrl: the console navigates to a stored return URL only when it is a path of its own
 * origin. Final review AU5: it is the same rule as the backend's safeReturnPath
 * (backend/src/modules/auth/saml-login-state.ts), which also refuses control characters and caps
 * the length. A browser strips a tab or newline from a URL, so "/\t/evil.example" becomes
 * "//evil.example", another origin.
 */
import { describe, expect, it } from 'vitest';
import { getSafeReturnUrl, isSafeReturnUrl } from '../auth-utils';

describe('isSafeReturnUrl', () => {
  it.each(['/identities', '/identities/64b7f0c2a1b2c3d4e5f60001?tab=access', '/'])(
    'accepts the path %s',
    (url) => {
      expect(isSafeReturnUrl(url)).toBe(true);
    },
  );

  it.each([
    ['another origin', '//evil.example'],
    ['a backslash', '/\\evil.example'],
    ['a scheme', 'javascript:alert(1)'],
    ['a relative path', 'identities'],
    ['an empty string', ''],
    ['a tab a browser strips', '/\t/evil.example'],
    ['a newline', '/\n/evil.example'],
    ['a carriage return', '/\r/evil.example'],
    ['a NUL', '/\u0000x'],
    ['a DEL', '/\u007fx'],
  ])('refuses %s', (_label, url) => {
    expect(isSafeReturnUrl(url)).toBe(false);
  });

  it('refuses a path longer than 2048 characters, as the backend does', () => {
    expect(isSafeReturnUrl(`/${'a'.repeat(2047)}`)).toBe(true);
    expect(isSafeReturnUrl(`/${'a'.repeat(2048)}`)).toBe(false);
  });

  it('falls back for an unsafe stored URL', () => {
    expect(getSafeReturnUrl('/\t/evil.example', '/dashboard')).toBe('/dashboard');
  });
});
