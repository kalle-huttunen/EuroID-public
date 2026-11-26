import React, { useEffect } from 'react';
import { useAuth } from 'react-oidc-context';
import { AuthContext } from './auth-context';
import { setAccessToken, setTenantId, setOn401 } from './token-store';
import { clearSessionState } from './session-reset';
import { setReturnUrl } from './return-url-store';
import { JwtClaimsSchema } from '@api/schemas/auth-responses';

function getRolesFromProfile(profile: Record<string, unknown>, roleClaimName: string): string[] {
  const parts = roleClaimName.split('.');
  let value: unknown = profile;
  for (const p of parts) {
    value = (value as Record<string, unknown>)?.[p];
  }
  return Array.isArray(value) ? value : [];
}

/**
 * Bridges react-oidc-context to our AuthContext and token store.
 * Must be rendered inside AuthProvider from react-oidc-context.
 * Role claim name is configurable via VITE_OIDC_ROLE_CLAIM (default: roles).
 * Entra ID uses 'roles', Auth0 may use namespace, Keycloak uses 'realm_access.roles'.
 */
export function OIDCAuthBridge({ children }: { children: React.ReactNode }) {
  const auth = useAuth();

  useEffect(() => {
    const user = auth.user;
    const token = user?.access_token ?? null;
    const profile = user?.profile as { tenantId?: string } | undefined;
    const tid = profile?.tenantId ?? null;
    setAccessToken(token);
    setTenantId(tid);
    return () => {
      setAccessToken(null);
      setTenantId(null);
    };
  }, [auth.user]);

  useEffect(() => {
    const handler = async () => {
      try {
        const user = await auth.signinSilent();
        if (user?.access_token) {
          setAccessToken(user.access_token);
          const profile = user.profile as { tenantId?: string } | undefined;
          const tid = profile?.tenantId ?? null;
          setTenantId(tid);
        }
      } catch (e) {
        // Back to this page after the IdP's sign-in (AuthCallback reads it)
        setReturnUrl(window.location.pathname + window.location.search);
        auth.signinRedirect();
        throw e;
      }
    };
    setOn401(handler);
    return () => setOn401(null);
  }, [auth]);

  const roleClaimName = import.meta.env.VITE_OIDC_ROLE_CLAIM || 'roles';
  const rawProfile = auth.user?.profile;
  const profileResult = rawProfile
    ? JwtClaimsSchema.safeParse(rawProfile)
    : { success: false as const, data: null };
  const validatedProfile = profileResult.success ? profileResult.data : null;
  const resolvedRoles = validatedProfile
    ? getRolesFromProfile(validatedProfile as Record<string, unknown>, roleClaimName)
    : [];
  if (rawProfile && !profileResult.success) {
    console.warn('[OIDCAuthBridge] JWT claims validation failed, using empty roles');
  }

  const value = {
    user: auth.user
      ? {
          profile: {
            ...(validatedProfile ?? {}),
            roles: resolvedRoles,
          } as {
            sub?: string;
            email?: string;
            name?: string;
            roles?: string[];
            tenantId?: string;
            tenantName?: string;
          },
          access_token: auth.user.access_token,
        }
      : null,
    isAuthenticated: auth.isAuthenticated ?? false,
    isLoading: auth.isLoading ?? true,
    signoutRedirect: auth.signoutRedirect
      ? () => {
          clearSessionState();
          auth.signoutRedirect();
        }
      : undefined,
    signinRedirect: auth.signinRedirect ? () => auth.signinRedirect() : undefined,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
