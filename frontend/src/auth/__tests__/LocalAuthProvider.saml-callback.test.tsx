import axios, { type AxiosAdapter, type InternalAxiosRequestConfig } from 'axios';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Navigate, Outlet, Route, Routes, useNavigate } from 'react-router-dom';
import { axiosInstance } from '@api/data';
import { API_BASE } from '@api/constants';
import { LocalAuthProvider } from '../LocalAuthProvider';
import { ProtectedRoute } from '../ProtectedRoute';
import { MfaEnrollmentGate } from '../MfaEnrollmentGate';
import { clearTokens, getAccessToken } from '../token-store';
import { SamlCallbackPage } from '../../features/auth/SamlCallbackPage';

// The real axios instance and its interceptor (refresh, on401) run against a fake API: a refused
// session check clears tokens through that interceptor as well as through LocalAuthProvider.

const CALLBACK = '/auth/saml-callback?code=one-time-code';
const SESSION_CHECK = 'GET /auth/me';
const EXCHANGE = 'POST /auth/saml/exchange';

const admin = {
  id: '65f0c1a2b3c4d5e6f7a8b9c0',
  email: 'sso.user@tenant-mfa.example',
  displayName: 'Sanna SSO',
  role: 'viewer',
  tenantId: 'tenant-mfa',
};

/** POST /auth/saml/exchange answers (AuthLocalService.completeSignIn). */
const SIGN_INS = {
  'an MFA enrollment token': {
    answer: {
      mfa_enrollment_required: true,
      message: 'MFA is required by your organization. Please set up MFA to continue.',
      mfa_enrollment_token: 'enrollment.jwt.token',
      user: admin,
    },
    page: 'mfa setup',
  },
  'a session': {
    answer: { access_token: 'access.jwt', refresh_token: 'refresh-token', user: admin },
    page: 'dashboard',
  },
} as const;

type Answer = { status: number; data?: unknown };

/** Requests the page sent, as "METHOD path" (the path after API_BASE), in order. */
let sent: string[];
/** Requests the test answers itself, by "METHOD path". */
let held: Map<string, (answer: Answer) => void>;

function reply(config: InternalAxiosRequestConfig, { status, data }: Answer) {
  const response = { status, statusText: String(status), data, headers: {}, config };
  if (status < 400) return Promise.resolve(response);
  return Promise.reject(
    Object.assign(new Error(`Request failed with status code ${status}`), { response, config }),
  );
}

/**
 * Nobody is signed in before the exchange (no cookies). A refresh works only with the refresh
 * token of a session; a session check sent again after a refresh answers that session.
 */
const fakeApi: AxiosAdapter = (config) => {
  const request = `${config.method?.toUpperCase()} ${config.url?.replace(API_BASE, '')}`;
  sent.push(request);
  if (request === EXCHANGE || (request === SESSION_CHECK && !('_retry' in config))) {
    return new Promise((resolve, reject) =>
      held.set(request, (answer) => reply(config, answer).then(resolve, reject)),
    );
  }
  if (request === SESSION_CHECK) {
    const { id: sub, email, displayName: name, tenantId } = admin;
    return reply(config, { status: 200, data: { sub, email, name, roles: ['viewer'], tenantId } });
  }
  if (request === 'POST /auth/refresh') {
    const body = typeof config.data === 'string' ? JSON.parse(config.data) : {};
    if (!body.refresh_token) {
      return reply(config, { status: 401, data: { message: 'Refresh token required' } });
    }
    return reply(config, {
      status: 200,
      data: { access_token: 'access-2', refresh_token: 'refresh-2' },
    });
  }
  if (request === 'POST /auth/logout') return reply(config, { status: 200, data: {} });
  return reply(config, { status: 404, data: { message: `unexpected ${request}` } });
};

/** App.tsx `ProtectedAppLayout` without the app layout. */
function SignedIn() {
  const navigate = useNavigate();
  return (
    <ProtectedRoute onNotAuthenticated={() => navigate('/login', { replace: true })}>
      <MfaEnrollmentGate>
        <Outlet />
      </MfaEnrollmentGate>
    </ProtectedRoute>
  );
}

function renderCallback() {
  // LocalAuthProvider reads the browser path; the router renders from its own entries.
  window.history.replaceState(null, '', CALLBACK);
  render(
    <MemoryRouter
      initialEntries={[CALLBACK]}
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <LocalAuthProvider>
        <Routes>
          <Route path="/auth/saml-callback" element={<SamlCallbackPage />} />
          <Route path="/login" element={<p>sign-in page</p>} />
          <Route element={<SignedIn />}>
            <Route index element={<Navigate to="/dashboard" replace />} />
            <Route path="/dashboard" element={<p>dashboard</p>} />
            <Route path="/settings/security" element={<p>mfa setup</p>} />
          </Route>
        </Routes>
      </LocalAuthProvider>
    </MemoryRouter>,
  );
}

/**
 * Answers a held request (one the page never sent has nothing to answer), then lets every
 * request, state update and navigation that answer causes run to its end.
 */
async function answer(request: string, response: Answer) {
  await act(async () => {
    held.get(request)?.(response);
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

describe('LocalAuthProvider on the single sign-on callback', () => {
  const realAdapters = { instance: axiosInstance.defaults.adapter, axios: axios.defaults.adapter };

  beforeEach(() => {
    vi.stubEnv('VITE_AUTH_DISABLED', 'false');
    clearTokens();
    sent = [];
    held = new Map();
    axiosInstance.defaults.adapter = fakeApi;
    axios.defaults.adapter = fakeApi;
  });

  afterEach(() => {
    axiosInstance.defaults.adapter = realAdapters.instance;
    axios.defaults.adapter = realAdapters.axios;
    vi.unstubAllEnvs();
    window.history.replaceState(null, '', '/');
  });

  // A session check started as the page opened must not undo the sign-in of the code exchange,
  // whichever of the two answers first.
  it.each([
    ['an MFA enrollment token', [SESSION_CHECK, EXCHANGE]],
    ['an MFA enrollment token', [EXCHANGE, SESSION_CHECK]],
    ['a session', [SESSION_CHECK, EXCHANGE]],
    ['a session', [EXCHANGE, SESSION_CHECK]],
  ] as const)('a sign-in with %s survives the answer order %j', async (signIn, order) => {
    const { answer: signInAnswer, page } = SIGN_INS[signIn];
    renderCallback();
    await waitFor(() => expect(sent).toContain(EXCHANGE));

    for (const request of order) {
      await answer(
        request,
        request === EXCHANGE ? { status: 200, data: signInAnswer } : { status: 401 },
      );
    }

    expect(screen.getByText(page)).toBeInTheDocument();
    expect(screen.queryByText('sign-in page')).toBeNull();
    if (signIn === 'an MFA enrollment token') {
      expect(getAccessToken()).toBe('enrollment.jwt.token');
    } else {
      expect(getAccessToken()).not.toBeNull();
    }
  });
});
