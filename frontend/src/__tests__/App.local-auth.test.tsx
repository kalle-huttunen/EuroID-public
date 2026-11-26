import React from 'react';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MFA_ENROLLMENT_PATH } from '../auth/mfa-enrollment';

// Local (email/password) auth mode: neither the dev bypass nor OIDC is configured.
// App.tsx reads these at module load, so they are stubbed before the dynamic import.
vi.stubEnv('VITE_AUTH_DISABLED', 'false');
vi.stubEnv('VITE_OIDC_AUTHORITY', '');

const mockGet = vi.fn();
const mockPost = vi.fn();
vi.mock('@api/data', () => ({
  axiosInstance: {
    get: (...args: unknown[]) => mockGet(...args),
    post: (...args: unknown[]) => mockPost(...args),
  },
}));

// No socket in jsdom; the real-time layer is not under test here.
vi.mock('@api/realtime', () => ({
  SocketProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useEventNotifications: () => {},
  useRealTimeQueryInvalidation: () => {},
  // The app layout's top bar (NotificationCenter, ConnectionStatus).
  useRealTimeEvents: () => {},
  useSocket: () => ({ socket: null, status: 'disconnected' }),
}));

function answerAsSignedOut(url: string) {
  if (url.endsWith('/auth/me')) return Promise.reject(new Error('401'));
  if (url.endsWith('/auth/setup-status')) return Promise.resolve({ data: { hasAdminUsers: true } });
  if (url.endsWith('/auth/saml/config')) return Promise.resolve({ data: { enabled: false } });
  return Promise.reject(new Error(`unexpected GET ${url}`));
}

/** POST /auth/login when the tenant requires MFA and the admin has none (completeSignIn). */
const ENROLLMENT_ANSWER = {
  mfa_enrollment_required: true,
  message: 'MFA is required by your organization. Please set up MFA to continue.',
  mfa_enrollment_token: 'enrollment.jwt.token',
  user: {
    id: '65f0c1a2b3c4d5e6f7a8b9c0',
    email: 'mia@tenant-mfa.example',
    name: 'Mia Mfa',
    role: 'super-admin',
    tenantId: 'tenant-mfa',
  },
};

/** GETs other than the sign-in's own: session check, setup status, SSO config, MFA status. */
const appQueries = () =>
  mockGet.mock.calls
    .map(([url]) => String(url))
    .filter((url) => !/\/auth\/(me|setup-status|saml\/config|mfa\/status)$/.test(url));

const setupRequests = () =>
  mockPost.mock.calls.filter(([url]) => String(url).endsWith('/auth/mfa/setup'));

/** Every address the app puts in the browser's history from now on, in order. */
function recordAddresses(): string[] {
  const addresses: string[] = [];
  for (const method of ['pushState', 'replaceState'] as const) {
    const original = window.history[method].bind(window.history);
    vi.spyOn(window.history, method).mockImplementation((data, unused, url) => {
      if (url != null) addresses.push(String(url));
      original(data, unused, url);
    });
  }
  return addresses;
}

describe('App in local-auth mode', () => {
  let App: React.ComponentType;

  // The first import compiles the whole app shell; give it room on a loaded machine.
  beforeAll(async () => {
    App = (await import('../App')).default;
  }, 30_000);

  beforeEach(() => {
    mockGet.mockReset();
    mockGet.mockImplementation(answerAsSignedOut);
    mockPost.mockReset();
    mockPost.mockResolvedValue({ data: {} });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.sessionStorage.clear();
    window.history.pushState({}, '', '/');
  });

  it('renders the login form on /login (auth provider is inside the router)', async () => {
    window.history.pushState({}, '', '/login');
    render(<App />);

    expect(await screen.findByRole('textbox', { name: /email address/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
  });

  it('sends a signed-out visitor of a protected page to /login', async () => {
    window.history.pushState({}, '', '/dashboard');
    render(<App />);

    expect(await screen.findByRole('textbox', { name: /email address/i })).toBeInTheDocument();
    await waitFor(() => expect(window.location.pathname).toBe('/login'));
  });

  /** POST /auth/login (and /auth/mfa/challenge) answering a session. */
  const SESSION_ANSWER = {
    access_token: 'access.jwt',
    refresh_token: 'refresh.jwt',
    user: {
      id: '65f0c1a2b3c4d5e6f7a8b9c1',
      email: 'ola@tenant-a.example',
      role: 'viewer',
      tenantId: 'tenant-a',
    },
  };

  async function signInWithPassword() {
    const user = userEvent.setup();
    await user.click(await screen.findByRole('textbox', { name: /email address/i }));
    await user.paste(SESSION_ANSWER.user.email);
    await user.click(screen.getByLabelText('Password'));
    await user.paste('ValidPass1!xx');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    return user;
  }

  // HX-H fixed the deep link for OIDC only: a password sign-in always went to `/`.
  it(
    'opens the page a signed-out visitor asked for after a password sign-in',
    { timeout: 60_000 },
    async () => {
      mockPost.mockImplementation((url: string) =>
        url.endsWith('/auth/login')
          ? Promise.resolve({ data: SESSION_ANSWER })
          : Promise.reject(new Error(`unexpected POST ${url}`)),
      );
      window.history.pushState({}, '', '/audit?range=7d');
      render(<App />);
      await waitFor(() => expect(window.location.pathname).toBe('/login'));

      await signInWithPassword();

      await waitFor(() =>
        expect(window.location.pathname + window.location.search).toBe('/audit?range=7d'),
      );
      expect(window.sessionStorage.getItem('euroid.returnUrl')).toBeNull();
    },
  );

  it('opens the page asked for after the MFA step too', { timeout: 60_000 }, async () => {
    mockPost.mockImplementation((url: string) => {
      if (url.endsWith('/auth/login')) {
        return Promise.resolve({ data: { mfa_required: true, mfa_token: 'mfa.pending' } });
      }
      if (url.endsWith('/auth/mfa/challenge')) return Promise.resolve({ data: SESSION_ANSWER });
      return Promise.reject(new Error(`unexpected POST ${url}`));
    });
    window.history.pushState({}, '', '/audit?range=7d');
    render(<App />);
    await waitFor(() => expect(window.location.pathname).toBe('/login'));

    const user = await signInWithPassword();
    const code = await screen.findByRole('textbox', { name: /code/i });
    await user.click(code);
    await user.paste('123456');
    await user.click(screen.getByRole('button', { name: /verify/i }));

    await waitFor(() =>
      expect(window.location.pathname + window.location.search).toBe('/audit?range=7d'),
    );
  });

  // Browser check of 2026-11-24: after this sign-in the app went on from MFA setup to `/` and
  // `/dashboard`, whose queries refuse the enrollment token (403), so the setup never showed.
  it(
    'keeps a sign-in that must set up MFA on MFA setup, with no query of the app',
    { timeout: 60_000 },
    async () => {
      mockGet.mockImplementation((url: string) =>
        url.endsWith('/auth/mfa/status')
          ? Promise.resolve({ data: { mfaEnabled: false, backupCodesRemaining: 0 } })
          : answerAsSignedOut(url),
      );
      mockPost.mockImplementation((url: string) => {
        if (url.endsWith('/auth/login')) return Promise.resolve({ data: ENROLLMENT_ANSWER });
        if (url.endsWith('/auth/mfa/setup')) {
          return Promise.resolve({
            data: {
              qrCodeDataUrl: 'data:image/png;base64,AAAA',
              manualEntryKey: 'JBSWY3DPEHPK3PXP',
            },
          });
        }
        return Promise.reject(new Error(`unexpected POST ${url}`));
      });
      window.history.pushState({}, '', '/login');
      const addresses = recordAddresses();
      render(<App />);

      const user = userEvent.setup();
      await user.click(await screen.findByRole('textbox', { name: /email address/i }));
      await user.paste(ENROLLMENT_ANSWER.user.email);
      await user.click(screen.getByLabelText('Password'));
      await user.paste('ValidPass1!xx');
      await user.click(screen.getByRole('button', { name: 'Sign in' }));

      // The sign-in settles on MFA setup (its setup request) or in the app (the app's queries).
      await waitFor(() => expect([...setupRequests(), ...appQueries()]).not.toEqual([]), {
        timeout: 15_000,
      });
      expect(appQueries()).toEqual([]);
      expect([...new Set(addresses)]).toEqual([MFA_ENROLLMENT_PATH]);
      expect(await screen.findByText('MFA Required')).toBeInTheDocument();
      expect(window.location.pathname + window.location.search).toBe(MFA_ENROLLMENT_PATH);
    },
  );
});

// The dev bypass (DevAuthProvider, no sign-in) is `DEV && VITE_AUTH_DISABLED === 'true'`: a
// production build that has the flag set must still send a visitor to the local sign-in.
describe('App built for production with VITE_AUTH_DISABLED=true', () => {
  let App: React.ComponentType;

  beforeAll(async () => {
    vi.stubEnv('VITE_AUTH_DISABLED', 'true');
    vi.stubEnv('DEV', false);
    vi.resetModules();
    App = (await import('../App')).default;
  }, 30_000);

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    mockGet.mockReset();
    mockGet.mockImplementation(answerAsSignedOut);
    mockPost.mockReset();
    mockPost.mockResolvedValue({ data: {} });
  });

  afterEach(() => {
    window.history.pushState({}, '', '/');
  });

  it('sends a signed-out visitor of a protected page to /login', async () => {
    window.history.pushState({}, '', '/dashboard');
    render(<App />);

    expect(await screen.findByRole('textbox', { name: /email address/i })).toBeInTheDocument();
    await waitFor(() => expect(window.location.pathname).toBe('/login'));
  });
});
