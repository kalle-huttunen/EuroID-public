import { useEffect } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App as AntdApp } from 'antd';
import {
  MemoryRouter,
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
  useNavigate,
  type NavigateFunction,
} from 'react-router-dom';
import { LocalAuthProvider } from '../LocalAuthProvider';
import { ProtectedRoute } from '../ProtectedRoute';
import { MfaEnrollmentGate } from '../MfaEnrollmentGate';
import { MFA_ENROLLMENT_PATH } from '../mfa-enrollment';
import { clearTokens, getAccessToken } from '../token-store';
import { LoginPage } from '../../features/auth/LoginPage';
import { SamlCallbackPage } from '../../features/auth/SamlCallbackPage';
import { AccountSecurityPage } from '../../features/settings/AccountSecurityPage';

const mockGet = vi.fn();
const mockPost = vi.fn();
vi.mock('@api/data', () => ({
  axiosInstance: {
    get: (...args: unknown[]) => mockGet(...args),
    post: (...args: unknown[]) => mockPost(...args),
  },
}));

const PASSWORD = 'ValidPass1!xx';
const admin = {
  id: '65f0c1a2b3c4d5e6f7a8b9c0',
  email: 'mia@tenant-mfa.example',
  name: 'Mia Mfa',
  role: 'super-admin',
  tenantId: 'tenant-mfa',
};

/** POST /auth/login and /auth/saml/exchange in a tenant that requires MFA (completeSignIn). */
const ENROLLMENT_ANSWER = {
  mfa_enrollment_required: true,
  message: 'MFA is required by your organization. Please set up MFA to continue.',
  mfa_enrollment_token: 'enrollment.jwt.token',
  user: admin,
};

/** Every path the router showed, in order (a path shown twice in a row is listed once). */
let shown: string[];
/** Pages other than MFA setup that rendered: each would run its own queries. */
let opened: string[];
/** The router's navigate: opens a path inside the app, as a link or the Back button would. */
let goTo: NavigateFunction;

function LocationLog() {
  const location = useLocation();
  const path = location.pathname + location.search;
  useEffect(() => {
    if (shown.at(-1) !== path) shown.push(path);
  }, [path]);
  return null;
}

function NavigateHandle() {
  const navigate = useNavigate();
  useEffect(() => {
    goTo = navigate;
  }, [navigate]);
  return null;
}

function Page({ name }: { name: string }) {
  useEffect(() => {
    opened.push(name);
  }, [name]);
  return <p>{name}</p>;
}

/** App.tsx `ProtectedAppLayout`, with a stand-in for the app layout (navigation, counters). */
function SignedInArea() {
  const navigate = useNavigate();
  return (
    <ProtectedRoute onNotAuthenticated={() => navigate('/login', { replace: true })}>
      <MfaEnrollmentGate>
        <Page name="app navigation" />
        <Outlet />
      </MfaEnrollmentGate>
    </ProtectedRoute>
  );
}

/** The routes and router flags of App.tsx, under the local sign-in's auth provider. */
function renderApp(path: string) {
  render(
    <MemoryRouter
      initialEntries={[path]}
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <LocalAuthProvider>
        <AntdApp>
          <LocationLog />
          <NavigateHandle />
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/auth/saml-callback" element={<SamlCallbackPage />} />
            <Route element={<SignedInArea />}>
              <Route index element={<Navigate to="/dashboard" replace />} />
              <Route path="/dashboard" element={<Page name="dashboard" />} />
              <Route path="/users" element={<Page name="users" />} />
              <Route path="/settings/security" element={<AccountSecurityPage />} />
              <Route path="*" element={<Page name="not found" />} />
            </Route>
          </Routes>
        </AntdApp>
      </LocalAuthProvider>
    </MemoryRouter>,
  );
}

/** Nobody is signed in yet (GET /auth/me is refused); MFA is off until verify-setup. */
function serve(signInAnswer: object) {
  let mfaEnabled = false;
  mockGet.mockImplementation((url: string) => {
    if (url.endsWith('/auth/me')) return Promise.reject({ response: { status: 401 } });
    if (url.endsWith('/auth/setup-status')) {
      return Promise.resolve({ data: { hasAdminUsers: true } });
    }
    if (url.endsWith('/auth/saml/config')) return Promise.resolve({ data: { enabled: false } });
    if (url.endsWith('/auth/mfa/status')) {
      return Promise.resolve({
        data: { mfaEnabled, backupCodesRemaining: mfaEnabled ? 10 : 0 },
      });
    }
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
  mockPost.mockImplementation((url: string) => {
    if (url.endsWith('/auth/login')) return Promise.resolve({ data: signInAnswer });
    if (url.endsWith('/auth/mfa/setup')) {
      return Promise.resolve({
        data: { qrCodeDataUrl: 'data:image/png;base64,AAAA', manualEntryKey: 'JBSWY3DPEHPK3PXP' },
      });
    }
    if (url.endsWith('/auth/mfa/verify-setup')) {
      mfaEnabled = true;
      return Promise.resolve({ data: { backupCodes: ['code-1', 'code-2'] } });
    }
    if (url.endsWith('/auth/logout')) return Promise.resolve({ data: { success: true } });
    return Promise.reject(new Error(`unexpected POST ${url}`));
  });
}

type User = ReturnType<typeof userEvent.setup>;

async function signInWithPassword(user: User) {
  renderApp('/login');
  const submit = await screen.findByRole('button', { name: 'Sign in' });
  await user.click(screen.getByLabelText('Email address'));
  await user.paste(admin.email);
  await user.click(screen.getByLabelText('Password'));
  await user.paste(PASSWORD);
  await user.click(submit);
}

describe('A sign-in that must set up MFA (MfaEnrollmentGate)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('VITE_AUTH_DISABLED', 'false');
    clearTokens();
    shown = [];
    opened = [];
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    window.history.replaceState(null, '', '/');
  });

  // The password sign-in itself, with the real app layout: App.local-auth.test.tsx.
  it(
    'while the session can only set up MFA, every other page sends back to MFA setup',
    { timeout: 30_000 },
    async () => {
      const user = userEvent.setup();
      serve(ENROLLMENT_ANSWER);
      await signInWithPassword(user);
      expect(await screen.findByText('MFA Required')).toBeInTheDocument();
      expect(shown).toEqual(['/login', MFA_ENROLLMENT_PATH]);
      expect(getAccessToken()).toBe('enrollment.jwt.token');

      const elsewhere = ['/dashboard', '/users', '/no-such-page', '/settings/security', '/login'];
      for (const path of elsewhere) {
        const before = shown.length;
        act(() => {
          void goTo(path);
        });
        await waitFor(() => expect(shown.slice(before)).toEqual([path, MFA_ENROLLMENT_PATH]));
        expect(await screen.findByText('MFA Required')).toBeInTheDocument();
      }
      expect(opened).toEqual([]);
    },
  );

  // SamlCallbackPage begins the enrollment through the same helper (beginMfaEnrollment).
  // The order of its answer and a session check: LocalAuthProvider.saml-callback.test.tsx.
  it('a single sign-on reaches MFA setup the same way', { timeout: 30_000 }, async () => {
    serve({});
    mockPost.mockImplementationOnce(() => Promise.resolve({ data: ENROLLMENT_ANSWER }));
    // LocalAuthProvider reads the browser path; the router renders from its own entries.
    window.history.replaceState(null, '', '/auth/saml-callback?code=one-time-code');
    renderApp('/auth/saml-callback?code=one-time-code');

    expect(await screen.findByText('MFA Required')).toBeInTheDocument();
    expect(mockPost).toHaveBeenCalledWith(expect.stringMatching(/\/auth\/saml\/exchange$/), {
      code: 'one-time-code',
    });
    expect(shown).toEqual(['/auth/saml-callback?code=one-time-code', MFA_ENROLLMENT_PATH]);
    expect(opened).toEqual([]);
    expect(getAccessToken()).toBe('enrollment.jwt.token');
  });

  it(
    'when the setup is done, the admin is signed out and signs in again',
    { timeout: 30_000 },
    async () => {
      const user = userEvent.setup();
      serve(ENROLLMENT_ANSWER);
      await signInWithPassword(user);
      expect(await screen.findByText('MFA Required')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Next: Verify Code' }));
      await user.click(screen.getByLabelText('Verification Code'));
      await user.paste('123456');
      await user.click(screen.getByRole('button', { name: /Verify & Enable MFA/ }));
      await user.click(await screen.findByRole('button', { name: 'Done' }));

      expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
      // LocationLog records the path in an effect, which can run after the page is on screen
      await waitFor(() => expect(shown.at(-1)).toBe('/login'));
      expect(getAccessToken()).toBeNull();
      expect(mockPost).toHaveBeenCalledWith(expect.stringMatching(/\/auth\/logout$/));
      expect(opened).toEqual([]);
    },
  );

  it('a sign-in that answers a session still opens the app', { timeout: 30_000 }, async () => {
    const user = userEvent.setup();
    serve({ access_token: 'access.jwt', refresh_token: 'refresh-token', user: admin });
    await signInWithPassword(user);

    expect(await screen.findByText('dashboard')).toBeInTheDocument();
    expect(screen.getByText('app navigation')).toBeInTheDocument();
    await waitFor(() => expect(shown.at(-1)).toBe('/dashboard'));
  });
});
