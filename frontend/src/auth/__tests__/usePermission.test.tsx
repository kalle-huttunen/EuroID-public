/**
 * 09 F10: usePermission treated VITE_AUTH_DISABLED=true as dev mode in any build, so a production
 * build made with the variable set showed every control to every role. ProtectedRoute requires a
 * development build as well (import.meta.env.DEV); both now agree.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import React from 'react';
import { AuthContext } from '../auth-context';
import { usePermission } from '../usePermission';

const viewer = {
  user: { profile: { roles: ['viewer'] } },
  isAuthenticated: true,
  isLoading: false,
};
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <AuthContext.Provider value={viewer}>{children}</AuthContext.Provider>
);

describe('usePermission', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('grants nothing extra in a production build with VITE_AUTH_DISABLED set', () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('VITE_AUTH_DISABLED', 'true');

    const { result } = renderHook(() => usePermission('operator'), { wrapper });

    expect(result.current).toBe(false);
  });

  it('grants every role in a development build with auth disabled', () => {
    vi.stubEnv('DEV', true);
    vi.stubEnv('VITE_AUTH_DISABLED', 'true');

    const { result } = renderHook(() => usePermission('super-admin'), { wrapper });

    expect(result.current).toBe(true);
  });
});
