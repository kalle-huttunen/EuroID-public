/**
 * 09 F7: the return URL lived in a module variable, and the OIDC sign-in is a full-page
 * navigation, so AuthCallback always read null and a deep link was lost: the user landed on /.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/** The store as a page loaded after the IdP's redirect sees it: a fresh module instance. */
async function afterRedirect() {
  vi.resetModules();
  return import('../return-url-store');
}

describe('return URL store', () => {
  beforeEach(() => sessionStorage.clear());

  it('keeps the page asked for across the sign-in redirect, once', async () => {
    const before = await import('../return-url-store');
    before.setReturnUrl('/identities/65f0c1a2b3c4d5e6f7a8b9c0?tab=access');

    const after = await afterRedirect();
    expect(after.getReturnUrl()).toBe('/identities/65f0c1a2b3c4d5e6f7a8b9c0?tab=access');
    after.clearReturnUrl();
    expect((await afterRedirect()).getReturnUrl()).toBeNull();
  });

  it.each(['https://evil.example/x', '//evil.example', '/\\evil.example', 'javascript:alert(1)'])(
    'never hands back a path that leaves the console: %s',
    async (url) => {
      const store = await import('../return-url-store');
      store.setReturnUrl(url);
      sessionStorage.setItem('euroid.returnUrl', url);

      expect((await afterRedirect()).getReturnUrl()).toBeNull();
    },
  );
});
