import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { AuthContext } from './auth-context';
import {
  getAccessToken,
  setAccessToken,
  setRefreshToken,
  setTenantId,
  clearTokens,
  setOn401,
} from './token-store';
import { clearSessionState } from './session-reset';
import { axiosInstance } from '@api/data';
import { API_BASE } from '@api/constants';

/**
 * Pages for people who are not signed in, other than /login: a refused session check (the 401 of
 * GET /auth/me on mount) must not send them to /login. The reset page holds a reset token.
 */
const SIGNED_OUT_PAGES = ['/reset-password'];

/**
 * The page a single sign-on returns to with a one-time code: SamlCallbackPage's code exchange
 * decides the session there, so it gets no session check. That check's 401 could come after the
 * exchange stored its tokens, and its failure path (the axios interceptor's failed refresh,
 * `on401`, the catch below) would clear them: an MFA enrollment token, which has no refresh
 * token to recover with, was lost and the admin sent to /login.
 */
const SIGN_IN_CALLBACK_PAGE = '/auth/saml-callback';

/**
 * Auth provider for local email/password authentication.
 * Validates token via GET /auth/me on mount (not on SIGN_IN_CALLBACK_PAGE); clears and
 * redirects to /login on 401.
 * Must render inside the router (it navigates to /login on logout).
 */
export function LocalAuthProvider({ children }: { children: React.ReactNode }) {
  const [checksSession] = useState(() => window.location.pathname !== SIGN_IN_CALLBACK_PAGE);
  const [authState, setAuthState] = useState<{
    user: {
      profile?: {
        sub?: string;
        email?: string;
        name?: string;
        roles?: string[];
        tenantId?: string;
      };
      access_token?: string;
    } | null;
    isAuthenticated: boolean;
    isLoading: boolean;
    /** Set by a sign-in that answered an MFA enrollment token (auth/mfa-enrollment.ts). */
    mfaEnrollmentOnly?: boolean;
  }>({
    user: null,
    isAuthenticated: false,
    // Without a session check, signed out until a sign-in says otherwise.
    isLoading: checksSession,
  });
  const navigate = useNavigate();

  const logout = useCallback(async () => {
    clearTokens();
    clearSessionState();
    try {
      await axiosInstance.post(`${API_BASE}/auth/logout`);
    } catch {
      // Ignore — cookies cleared best-effort
    }
    setAuthState({
      user: null,
      isAuthenticated: false,
      isLoading: false,
    });
    navigate('/login', { replace: true });
  }, [navigate]);

  useEffect(() => {
    if (!checksSession) return;
    // FA-1: No localStorage — auth via httpOnly cookies. Validate via /auth/me (cookies sent with withCredentials).
    axiosInstance
      .get<{ sub: string; email: string; name: string; roles: string[]; tenantId: string }>(
        `${API_BASE}/auth/me`,
      )
      .then(({ data }) => {
        const userProfile = {
          sub: data.sub,
          email: data.email,
          name: data.name,
          roles: data.roles,
          tenantId: data.tenantId,
        };
        setTenantId(data.tenantId);
        setAuthState({
          user: {
            profile: userProfile,
            access_token: undefined,
          },
          isAuthenticated: true,
          isLoading: false,
        });
      })
      .catch(() => {
        clearTokens();
        clearSessionState();
        setAuthState({
          user: null,
          isAuthenticated: false,
          isLoading: false,
        });
      });
    // Once per mount. `logout` is not a dependency: its identity follows the router
    // location, and the session must not be re-validated on every navigation.
  }, [checksSession]);

  useEffect(() => {
    setOn401(() => (SIGNED_OUT_PAGES.includes(window.location.pathname) ? undefined : logout()));
    return () => setOn401(null);
  }, [logout]);

  useEffect(() => {
    const handler = (
      e: CustomEvent<{
        user: { id: string; email: string; name: string; role: string; tenantId: string };
        mfaEnrollmentOnly?: boolean;
      }>,
    ) => {
      const { user, mfaEnrollmentOnly = false } = e.detail;
      setTenantId(user.tenantId);
      setAuthState({
        user: {
          profile: {
            sub: user.id,
            email: user.email,
            name: user.name,
            roles: [user.role],
            tenantId: user.tenantId,
          },
          access_token: undefined,
        },
        isAuthenticated: true,
        isLoading: false,
        mfaEnrollmentOnly,
      });
    };
    window.addEventListener('euroid-login-success', handler as EventListener);
    return () => window.removeEventListener('euroid-login-success', handler as EventListener);
  }, []);

  const value = useMemo(
    () => ({ ...authState, signoutRedirect: authState.isAuthenticated ? logout : undefined }),
    [authState, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
