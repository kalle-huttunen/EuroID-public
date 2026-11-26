import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders, mockAuthValue } from '../../../test/test-utils';
import { clearTokens, getAccessToken, getRefreshToken } from '../../../auth/token-store';
import { SamlCallbackPage } from '../SamlCallbackPage';

const mockPost = vi.fn();
vi.mock('@api/data', () => ({
  axiosInstance: { post: (...args: unknown[]) => mockPost(...args) },
}));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => mockNavigate,
}));

const signedOut = {
  ...mockAuthValue,
  user: null,
  isAuthenticated: false,
  isLoading: false,
} as unknown as typeof mockAuthValue;

/** The admin of POST /auth/saml/exchange (AdminUserSafe). */
const admin = {
  id: '65f0c1a2b3c4d5e6f7a8b9c0',
  email: 'sso.user@tenant-a.example',
  name: 'Sanna SSO',
  role: 'viewer',
  tenantId: 'tenant-a',
};

describe('SamlCallbackPage', () => {
  let signedIn: Array<{ id: string; tenantId: string }>;
  const onSignedIn = (e: Event) => signedIn.push((e as CustomEvent).detail.user);

  beforeEach(() => {
    vi.clearAllMocks();
    clearTokens();
    window.sessionStorage.clear();
    signedIn = [];
    window.addEventListener('euroid-login-success', onSignedIn);
    return () => window.removeEventListener('euroid-login-success', onSignedIn);
  });

  /** The IdP redirect back with a one-time code, exchanged for `answer`. */
  async function exchange(answer: object, query = '') {
    mockPost.mockResolvedValue({ data: answer });
    renderWithProviders(<SamlCallbackPage />, {
      authValue: signedOut,
      initialRoute: `/auth/saml-callback?code=one-time-code${query}`,
    });
    await waitFor(() => expect(mockNavigate).toHaveBeenCalled());
    expect(mockPost).toHaveBeenCalledWith(expect.stringMatching(/\/auth\/saml\/exchange$/), {
      code: 'one-time-code',
    });
  }

  // The same MFA gate as a password sign-in (AuthLocalService.completeSignIn).
  it('a tenant that requires MFA: signs in with the setup-only token and opens MFA setup', async () => {
    await exchange({
      mfa_enrollment_required: true,
      message: 'MFA is required by your organization. Please set up MFA to continue.',
      mfa_enrollment_token: 'enrollment.jwt.token',
      user: admin,
    });

    expect(getAccessToken()).toBe('enrollment.jwt.token');
    expect(getRefreshToken()).toBeNull();
    expect(signedIn).toMatchObject([{ id: admin.id, tenantId: 'tenant-a' }]);
    expect(mockNavigate.mock.calls).toEqual([
      ['/settings/security?mfa_enrollment=true', { replace: true }],
    ]);
    expect(screen.queryByText(/Invalid authentication response/)).toBeNull();
  });

  it('a session answer still signs in and opens the app', async () => {
    await exchange({ access_token: 'access.jwt', refresh_token: 'refresh-token', user: admin });

    expect(getAccessToken()).toBe('access.jwt');
    expect(getRefreshToken()).toBe('refresh-token');
    expect(signedIn).toMatchObject([{ id: admin.id }]);
    expect(mockNavigate.mock.calls).toEqual([['/', { replace: true }]]);
  });

  // The page asked for before the SAML sign-in comes back through the RelayState (API), and the
  // console checks it again before going there.
  it('opens the page the sign-in was started for', async () => {
    const session = { access_token: 'access.jwt', refresh_token: 'refresh-token', user: admin };

    await exchange(session, `&returnUrl=${encodeURIComponent('/identities/abc?tab=access')}`);

    expect(mockNavigate.mock.calls).toEqual([['/identities/abc?tab=access', { replace: true }]]);
    expect(window.sessionStorage.getItem('euroid.returnUrl')).toBeNull();
  });

  it.each(['https://evil.example/x', '//evil.example', '/\\evil.example'])(
    'opens the app instead of the unsafe return URL %s',
    async (returnUrl) => {
      const session = { access_token: 'access.jwt', refresh_token: 'refresh-token', user: admin };

      await exchange(session, `&returnUrl=${encodeURIComponent(returnUrl)}`);

      expect(mockNavigate.mock.calls).toEqual([['/', { replace: true }]]);
    },
  );

  it('keeps the page asked for across the MFA step on /login', async () => {
    await exchange(
      { mfa_required: true, mfa_token: 'mfa.pending' },
      `&returnUrl=${encodeURIComponent('/audit')}`,
    );

    expect(mockNavigate.mock.calls).toEqual([['/login?mfa_required=true', { replace: true }]]);
    expect(window.sessionStorage.getItem('euroid.returnUrl')).toBe('/audit');
  });
});
