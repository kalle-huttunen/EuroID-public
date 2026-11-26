import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DevAuthProvider } from '../DevAuthProvider';
import { useAuthContext } from '../auth-context';
import * as tokenStore from '../token-store';

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

describe('DevAuthProvider', () => {
  beforeEach(() => {
    vi.spyOn(tokenStore, 'setAccessToken');
    vi.spyOn(tokenStore, 'setTenantId');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('provides correct auth context (isAuthenticated: true, user with super-admin role)', () => {
    render(
      <DevAuthProvider>
        <TestChild />
      </DevAuthProvider>,
    );
    expect(screen.getByTestId('authenticated')).toHaveTextContent('true');
    expect(screen.getByTestId('loading')).toHaveTextContent('false');
    expect(screen.getByTestId('email')).toHaveTextContent('dev@localhost');
    expect(screen.getByTestId('roles')).toHaveTextContent('super-admin');
  });

  it('sets access token in token-store synchronously', () => {
    render(
      <DevAuthProvider>
        <span>x</span>
      </DevAuthProvider>,
    );
    expect(tokenStore.setAccessToken).toHaveBeenCalledWith('dev-token-not-a-real-jwt');
  });

  // The token store's tenant is what the API client sends as X-Tenant-Id. The provider reads
  // VITE_DEV_TENANT_ID when its module loads, so the test loads it again with the variable set.
  it('sets tenant id in token-store', async () => {
    vi.stubEnv('VITE_DEV_TENANT_ID', 'tenant-from-env');
    vi.resetModules();
    const store = await import('../token-store');
    const { DevAuthProvider: ReloadedProvider } = await import('../DevAuthProvider');

    render(
      <ReloadedProvider>
        <span>x</span>
      </ReloadedProvider>,
    );

    expect(store.getTenantId()).toBe('tenant-from-env');
  });
});
