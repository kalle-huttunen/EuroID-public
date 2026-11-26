import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, mockAuthValue } from '../../../test/test-utils';
import { clearTokens, getAccessToken, getRefreshToken } from '../../../auth/token-store';
import { LoginPage } from '../LoginPage';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => mockNavigate,
}));

const mockGet = vi.fn();
const mockPost = vi.fn();
vi.mock('@api/data', () => ({
  axiosInstance: {
    get: (...args: unknown[]) => mockGet(...args),
    post: (...args: unknown[]) => mockPost(...args),
  },
}));

const signedOut = {
  ...mockAuthValue,
  user: null,
  isAuthenticated: false,
  isLoading: false,
} as unknown as typeof mockAuthValue;

const PASSWORD = 'ValidPass1!xx';
const INVITE_CODE = '9f2c4e6a8b0d1f3e5a7c9b1d3f5e7a9c0b2d4f6e8a1c3e5b7d9f1a3c5e7b9d1f';

/**
 * GET /auth/setup-status answers whether any admin exists; SAML is off; a reset link can be
 * mailed unless `byEmail` is false.
 */
function serve(hasAdminUsers: boolean, byEmail = true) {
  mockGet.mockImplementation((url: string) => {
    if (url.endsWith('/auth/setup-status')) return Promise.resolve({ data: { hasAdminUsers } });
    if (url.endsWith('/auth/saml/config')) return Promise.resolve({ data: { enabled: false } });
    if (url.endsWith('/auth/password-reset/config')) {
      return Promise.resolve({ data: { byEmail, tokenTtlMinutes: 30 } });
    }
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
  mockPost.mockResolvedValue({ data: { user: { id: 'new-admin' } } });
}

/** POST /auth/password-reset/request answers the same for every address. */
const NEUTRAL =
  'If an active admin account that signs in with a password uses this address, EuroID emails it a link to set a new password, valid for 30 minutes. No email? Ask a super-admin of your organization for a reset code.';

type User = ReturnType<typeof userEvent.setup>;

async function fill(user: User, label: string, text: string) {
  await user.click(screen.getByLabelText(label));
  await user.paste(text);
}

async function fillAccount(user: User) {
  await fill(user, 'Full name', 'New Admin');
  await fill(user, 'Email address', 'new.admin@corp.example');
  await fill(user, 'Password', PASSWORD);
}

describe('LoginPage header', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the product tagline under the title', async () => {
    serve(true);
    renderWithProviders(<LoginPage />, { authValue: signedOut });
    expect(
      await screen.findByText('Schengen for your apps: one passport, no border checks.'),
    ).toBeInTheDocument();
  });
});

describe('LoginPage registration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // POST /auth/register refuses (403) a registration without an invite once an admin exists.
  it('sends the invite code an invited admin enters', { timeout: 30_000 }, async () => {
    const user = userEvent.setup();
    serve(true);
    renderWithProviders(<LoginPage />, { authValue: signedOut });

    await user.click(await screen.findByRole('button', { name: 'Create an account' }));
    // An invitee gets the invited role, not super-admin.
    expect(screen.queryByText(/First account will be created as Super Admin/)).toBeNull();
    await fillAccount(user);
    await fill(user, 'Invite code', `  ${INVITE_CODE} `);
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith(expect.stringMatching(/\/auth\/register$/), {
        name: 'New Admin',
        email: 'new.admin@corp.example',
        password: PASSWORD,
        inviteToken: INVITE_CODE,
      }),
    );
  });

  it('asks for the invite code once an admin exists', { timeout: 30_000 }, async () => {
    const user = userEvent.setup();
    serve(true);
    renderWithProviders(<LoginPage />, { authValue: signedOut });

    await user.click(await screen.findByRole('button', { name: 'Create an account' }));
    await fillAccount(user);
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(
      await screen.findByText('Enter the invite code from your administrator'),
    ).toBeInTheDocument();
    expect(mockPost).not.toHaveBeenCalled();
  });

  it(
    'creates the first account without a code and says it becomes the super-admin',
    { timeout: 30_000 },
    async () => {
      const user = userEvent.setup();
      serve(false);
      renderWithProviders(<LoginPage />, { authValue: signedOut });

      expect(
        await screen.findByText('First account will be created as Super Admin'),
      ).toBeInTheDocument();
      // The code field takes the server's SETUP_TOKEN, and only when it has one.
      expect(screen.getByLabelText('Setup token')).toBeInTheDocument();
      await fillAccount(user);
      await user.click(screen.getByRole('button', { name: 'Create account' }));

      await waitFor(() =>
        expect(mockPost).toHaveBeenCalledWith(expect.stringMatching(/\/auth\/register$/), {
          name: 'New Admin',
          email: 'new.admin@corp.example',
          password: PASSWORD,
        }),
      );
    },
  );
});

describe('LoginPage forgot password', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it(
    'asks for a reset link and shows the answer, which is the same for every address',
    { timeout: 30_000 },
    async () => {
      const user = userEvent.setup();
      serve(true);
      mockPost.mockResolvedValue({ data: { message: NEUTRAL } });
      renderWithProviders(<LoginPage />, { authValue: signedOut });

      await user.click(await screen.findByRole('button', { name: 'Forgot password?' }));
      await fill(user, 'Email address', ' alice@corp.example ');
      await user.click(screen.getByRole('button', { name: 'Send reset link' }));

      await waitFor(() =>
        expect(mockPost).toHaveBeenCalledWith(
          expect.stringMatching(/\/api\/v1\/auth\/password-reset\/request$/),
          { email: 'alice@corp.example' },
        ),
      );
      expect(await screen.findByText(NEUTRAL)).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'I have a reset code' })).toHaveAttribute(
        'href',
        '/reset-password',
      );
    },
  );

  it('shows the API message when the request is refused', { timeout: 30_000 }, async () => {
    const user = userEvent.setup();
    serve(true);
    mockPost.mockRejectedValue({
      response: {
        status: 429,
        data: { message: 'Too many password reset attempts. Try again in 12 minutes.' },
      },
    });
    renderWithProviders(<LoginPage />, { authValue: signedOut });

    await user.click(await screen.findByRole('button', { name: 'Forgot password?' }));
    await fill(user, 'Email address', 'alice@corp.example');
    await user.click(screen.getByRole('button', { name: 'Send reset link' }));

    expect(
      await screen.findByText('Too many password reset attempts. Try again in 12 minutes.'),
    ).toBeInTheDocument();
  });

  it('without email, sends the admin to a super-admin for a code', async () => {
    const user = userEvent.setup();
    serve(true, false);
    renderWithProviders(<LoginPage />, { authValue: signedOut });

    await user.click(await screen.findByRole('button', { name: 'Forgot password?' }));

    expect(await screen.findByText(/This EuroID does not send email/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send reset link' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'I have a reset code' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Back to sign in' }));
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });
});

describe('LoginPage sign-in', () => {
  const admin = {
    id: '65f0c1a2b3c4d5e6f7a8b9c0',
    email: 'ops@tenant-a.example',
    name: 'Oscar Operator',
    role: 'operator',
    tenantId: 'tenant-a',
  };
  let signedIn: Array<{ id: string; tenantId: string }>;
  const onSignedIn = (e: Event) => signedIn.push((e as CustomEvent).detail.user);

  beforeEach(() => {
    vi.clearAllMocks();
    clearTokens();
    signedIn = [];
    window.addEventListener('euroid-login-success', onSignedIn);
    return () => window.removeEventListener('euroid-login-success', onSignedIn);
  });

  async function signIn(answer: object) {
    const user = userEvent.setup();
    serve(true);
    mockPost.mockResolvedValue({ data: answer });
    renderWithProviders(<LoginPage />, { authValue: signedOut });
    const submit = await screen.findByRole('button', { name: 'Sign in' });
    await fill(user, 'Email address', admin.email);
    await fill(user, 'Password', PASSWORD);
    await user.click(submit);
    await waitFor(() => expect(mockNavigate).toHaveBeenCalled());
  }

  // POST /auth/login when the tenant requires MFA and the admin has none (completeSignIn).
  it(
    'a tenant that requires MFA: signs in with the setup-only token and opens MFA setup',
    { timeout: 30_000 },
    async () => {
      await signIn({
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
    },
  );

  it('a session answer still signs in and opens the app', { timeout: 30_000 }, async () => {
    await signIn({ access_token: 'access.jwt', refresh_token: 'refresh-token', user: admin });

    expect(getAccessToken()).toBe('access.jwt');
    expect(getRefreshToken()).toBe('refresh-token');
    expect(signedIn).toMatchObject([{ id: admin.id }]);
    expect(mockNavigate.mock.calls).toEqual([['/']]);
  });
});
