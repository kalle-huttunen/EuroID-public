import React, { useEffect } from 'react';
import { AuthContext } from './auth-context';
import { setAccessToken, setTenantId } from './token-store';
import { clearSessionState } from './session-reset';

const devTenantId = import.meta.env?.VITE_DEV_TENANT_ID ?? 'dev-tenant';
const devEmail = import.meta.env?.VITE_DEV_EMAIL ?? 'dev@localhost';

const devUser = {
  profile: {
    sub: 'dev-user',
    email: devEmail,
    name: 'Developer',
    roles: ['super-admin'],
    tenantId: devTenantId,
    tenantName: 'Development Tenant',
  },
  access_token: 'dev-token-not-a-real-jwt',
};

const devAuthValue = {
  user: devUser,
  isAuthenticated: true,
  isLoading: false,
  signoutRedirect: () => {
    clearSessionState();
    // In dev mode, "sign out" just reloads - no real IdP
    window.location.href = '/';
  },
};

/**
 * When VITE_AUTH_DISABLED=true, this provider wraps the app instead of the real OIDC provider.
 * Provides a fake auth context so dev mode works without configuring an IdP.
 */
export function DevAuthProvider({ children }: { children: React.ReactNode }) {
  // Synchronous initialization so token is available before first data provider request
  setAccessToken(devUser.access_token);
  setTenantId(devUser.profile.tenantId ?? null);

  useEffect(() => {
    return () => {
      setAccessToken(null);
      setTenantId(null);
    };
  }, []);

  return <AuthContext.Provider value={devAuthValue}>{children}</AuthContext.Provider>;
}
