import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useAuth } from 'react-oidc-context';
import { OIDCAuthBridge } from '../OIDCAuthBridge';
import { useAuthContext } from '../auth-context';
import * as tokenStore from '../token-store';

vi.mock('react-oidc-context', () => ({
  useAuth: vi.fn(),
}));

const mockUseAuth = vi.mocked(useAuth);

/** react-oidc-context's state for a signed-in user; `auth` overrides its functions. */
function signedIn(
  user: { profile: Record<string, unknown>; access_token?: string },
  auth: Partial<Record<'signinSilent' | 'signinRedirect', ReturnType<typeof vi.fn>>> = {},
) {
  return {
    user: { access_token: 'oidc-access-token', ...user },
    isAuthenticated: true,
    isLoading: false,
    signoutRedirect: vi.fn(),
    signinRedirect: vi.fn(),
    signinSilent: vi.fn(),
    ...auth,
  } as unknown as ReturnType<typeof useAuth>;
}

function TestChild() {
  const auth = useAuthContext();
  return (
    <div>
      <span data-testid="authenticated">{String(auth.isAuthenticated)}</span>
      <span data-testid="loading">{String(auth.isLoading)}</span>
      <span data-testid="email">{auth.user?.profile?.email}</span>
      <span data-testid="roles">{auth.user?.profile?.roles?.join(',')}</span>
    </div>
  );
}

describe('OIDCAuthBridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(tokenStore, 'setAccessToken');
    vi.spyOn(tokenStore, 'setTenantId');
    vi.spyOn(tokenStore, 'setOn401');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    tokenStore.clearTokens();
  });

  it('maps OIDC user profile to AuthContext value', () => {
    vi.stubEnv('VITE_OIDC_ROLE_CLAIM', 'roles');
    mockUseAuth.mockReturnValue({
      user: {
        profile: {
          sub: 'oidc-user',
          email: 'user@example.com',
          name: 'Test User',
          roles: ['operator'],
          tenantId: 'tenant-1',
        },
        access_token: 'oidc-access-token',
      },
      isAuthenticated: true,
      isLoading: false,
      signoutRedirect: vi.fn(),
      signinRedirect: vi.fn(),
      signinSilent: vi.fn(),
    } as unknown as ReturnType<typeof useAuth>);

    render(
      <OIDCAuthBridge>
        <TestChild />
      </OIDCAuthBridge>,
    );

    expect(screen.getByTestId('authenticated')).toHaveTextContent('true');
    expect(screen.getByTestId('loading')).toHaveTextContent('false');
    expect(screen.getByTestId('email')).toHaveTextContent('user@example.com');
    expect(screen.getByTestId('roles')).toHaveTextContent('operator');
  });

  it('resolves roles from configurable claim name (default: roles)', () => {
    vi.stubEnv('VITE_OIDC_ROLE_CLAIM', 'roles');
    mockUseAuth.mockReturnValue({
      user: {
        profile: {
          sub: 'u1',
          roles: ['policy-admin', 'viewer'],
        },
        access_token: 't',
      },
      isAuthenticated: true,
      isLoading: false,
      signoutRedirect: vi.fn(),
      signinRedirect: vi.fn(),
      signinSilent: vi.fn(),
    } as unknown as ReturnType<typeof useAuth>);

    render(
      <OIDCAuthBridge>
        <TestChild />
      </OIDCAuthBridge>,
    );

    expect(screen.getByTestId('roles')).toHaveTextContent('policy-admin,viewer');
  });

  it('resolves nested role claims (e.g., realm_access.roles)', () => {
    vi.stubEnv('VITE_OIDC_ROLE_CLAIM', 'realm_access.roles');
    mockUseAuth.mockReturnValue({
      user: {
        profile: {
          sub: 'u1',
          realm_access: { roles: ['admin', 'user'] },
        },
        access_token: 't',
      },
      isAuthenticated: true,
      isLoading: false,
      signoutRedirect: vi.fn(),
      signinRedirect: vi.fn(),
      signinSilent: vi.fn(),
    } as unknown as ReturnType<typeof useAuth>);

    render(
      <OIDCAuthBridge>
        <TestChild />
      </OIDCAuthBridge>,
    );

    expect(screen.getByTestId('roles')).toHaveTextContent('admin,user');
  });

  it('sets access token in token-store', () => {
    mockUseAuth.mockReturnValue({
      user: {
        profile: { sub: 'u1' },
        access_token: 'my-token',
      },
      isAuthenticated: true,
      isLoading: false,
      signoutRedirect: vi.fn(),
      signinRedirect: vi.fn(),
      signinSilent: vi.fn(),
    } as unknown as ReturnType<typeof useAuth>);

    render(
      <OIDCAuthBridge>
        <span>x</span>
      </OIDCAuthBridge>,
    );

    expect(tokenStore.setAccessToken).toHaveBeenCalledWith('my-token');
  });

  // The API client calls this handler on a 401 the refresh endpoint could not fix.
  it('sets 401 handler for silent renewal', async () => {
    const signinSilent = vi.fn().mockResolvedValue({
      access_token: 'renewed-token',
      profile: { sub: 'u1', tenantId: 'tenant-2' },
    });
    const signinRedirect = vi.fn();
    mockUseAuth.mockReturnValue(
      signedIn({ profile: { sub: 'u1', tenantId: 'tenant-1' } }, { signinSilent, signinRedirect }),
    );
    render(
      <OIDCAuthBridge>
        <span>x</span>
      </OIDCAuthBridge>,
    );

    await tokenStore.getOn401()!();

    expect(signinSilent).toHaveBeenCalledTimes(1);
    expect(tokenStore.getAccessToken()).toBe('renewed-token');
    expect(tokenStore.getTenantId()).toBe('tenant-2');
    expect(signinRedirect).not.toHaveBeenCalled();
  });

  it('sends the user to sign in when silent renewal fails, and fails the retried request', async () => {
    const signinSilent = vi.fn().mockRejectedValue(new Error('login_required'));
    const signinRedirect = vi.fn();
    mockUseAuth.mockReturnValue(
      signedIn({ profile: { sub: 'u1' } }, { signinSilent, signinRedirect }),
    );
    render(
      <OIDCAuthBridge>
        <span>x</span>
      </OIDCAuthBridge>,
    );

    await expect(tokenStore.getOn401()!()).rejects.toThrow('login_required');

    expect(signinRedirect).toHaveBeenCalledTimes(1);
  });

  it('handles missing user (not authenticated state)', () => {
    mockUseAuth.mockReturnValue({
      user: null,
      isAuthenticated: false,
      isLoading: false,
      signoutRedirect: undefined,
      signinRedirect: vi.fn(),
      signinSilent: vi.fn(),
    } as unknown as ReturnType<typeof useAuth>);

    render(
      <OIDCAuthBridge>
        <TestChild />
      </OIDCAuthBridge>,
    );

    expect(screen.getByTestId('authenticated')).toHaveTextContent('false');
    expect(screen.getByTestId('email')).toBeEmptyDOMElement();
    expect(screen.getByTestId('roles')).toBeEmptyDOMElement();
  });

  it('keeps the tenant of the signed-in profile in the token store', () => {
    mockUseAuth.mockReturnValue(signedIn({ profile: { sub: 'u1', tenantId: 'tenant-1' } }));

    render(
      <OIDCAuthBridge>
        <span>x</span>
      </OIDCAuthBridge>,
    );

    expect(tokenStore.getTenantId()).toBe('tenant-1');
  });

  // Fail closed: claims that do not pass JwtClaimsSchema (here no `sub`) grant no role.
  it('gives a profile whose claims fail validation no roles', () => {
    vi.stubEnv('VITE_OIDC_ROLE_CLAIM', 'roles');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockUseAuth.mockReturnValue(
      signedIn({ profile: { email: 'user@example.com', roles: ['super-admin'] } }),
    );

    render(
      <OIDCAuthBridge>
        <TestChild />
      </OIDCAuthBridge>,
    );

    expect(screen.getByTestId('roles')).toBeEmptyDOMElement();
    expect(screen.getByTestId('email')).toBeEmptyDOMElement();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('JWT claims validation failed'));
  });
});
