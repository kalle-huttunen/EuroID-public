/**
 * Tenant management (sidebar entry, command palette entry, /admin/tenants route) is shown only
 * when GET /auth/me says the user is a platform admin. A tenant super-admin, whom /tenants
 * answers with 403, must not see it, and the client's own role or dev mode never grants it.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import { renderWithProviders, mockAuthValue } from '../../test/test-utils';
import { CustomSider } from '../../components/layout/CustomSider';
import { CommandPalette } from '../../components/common/CommandPalette';
import { useCommandPaletteStore } from '@stores/command-palette-store';
import { PlatformAdminRoute } from '../PlatformAdminRoute';

const mockGet = vi.fn();
vi.mock('@api/data', () => ({
  axiosInstance: { get: (...args: unknown[]) => mockGet(...args) },
}));

/** The backend: /auth/me reports the platform admin flag; counts are zero. */
function backend(isPlatformAdmin: boolean) {
  mockGet.mockImplementation((url: string) => {
    if (url.endsWith('/auth/me')) {
      return Promise.resolve({
        data: { ...mockAuthValue.user.profile, isPlatformAdmin },
      });
    }
    return Promise.resolve({ data: { count: 0 } });
  });
}

const meCalls = () => mockGet.mock.calls.filter(([url]) => String(url).endsWith('/auth/me'));

describe('platform admin gating', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_AUTH_DISABLED', 'false');
    mockGet.mockReset();
    // A desktop-width screen, so the sidebar renders its menu (not the closed mobile drawer).
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (query: string) =>
        ({
          matches: true,
          media: query,
          onchange: null,
          addListener: () => {},
          removeListener: () => {},
          addEventListener: () => {},
          removeEventListener: () => {},
          dispatchEvent: () => false,
        }) as MediaQueryList,
    );
    // cmdk scrolls the selected item into view; jsdom has no layout.
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    act(() => useCommandPaletteStore.getState().setOpen(false));
  });

  it('the sidebar hides Tenants from a tenant super-admin', async () => {
    backend(false);
    renderWithProviders(<CustomSider />);

    expect(await screen.findByText('SCIM settings')).toBeInTheDocument();
    await waitFor(() => expect(meCalls()).toHaveLength(1));
    expect(screen.queryByText('Tenants')).not.toBeInTheDocument();
  });

  it('the sidebar shows Tenants to a platform admin', async () => {
    backend(true);
    renderWithProviders(<CustomSider />);

    expect(await screen.findByText('Tenants')).toBeInTheDocument();
  });

  it('the command palette offers Tenants only to a platform admin', async () => {
    backend(false);
    act(() => useCommandPaletteStore.getState().setOpen(true));
    const { unmount } = renderWithProviders(<CommandPalette />);
    expect(await screen.findByText('SCIM settings')).toBeInTheDocument();
    await waitFor(() => expect(meCalls()).toHaveLength(1));
    expect(screen.queryByText('Tenants')).not.toBeInTheDocument();
    unmount();

    backend(true);
    renderWithProviders(<CommandPalette />);
    expect(await screen.findByText('Tenants')).toBeInTheDocument();
  });

  it('the tenants route answers 403 to a tenant super-admin and renders for a platform admin', async () => {
    backend(false);
    const { unmount } = renderWithProviders(
      <PlatformAdminRoute>
        <div>Tenant management</div>
      </PlatformAdminRoute>,
    );
    expect(await screen.findByText('Access Denied')).toBeInTheDocument();
    expect(screen.queryByText('Tenant management')).not.toBeInTheDocument();
    unmount();

    backend(true);
    renderWithProviders(
      <PlatformAdminRoute>
        <div>Tenant management</div>
      </PlatformAdminRoute>,
    );
    expect(await screen.findByText('Tenant management')).toBeInTheDocument();
  });

  it('dev mode (every role granted on the client) still asks the server', async () => {
    vi.stubEnv('VITE_AUTH_DISABLED', 'true');
    backend(false);
    renderWithProviders(
      <PlatformAdminRoute>
        <div>Tenant management</div>
      </PlatformAdminRoute>,
    );

    expect(await screen.findByText('Access Denied')).toBeInTheDocument();
    expect(screen.queryByText('Tenant management')).not.toBeInTheDocument();
  });

  it('asks nothing and shows no tenant management while signed out', async () => {
    backend(true);
    renderWithProviders(
      <PlatformAdminRoute>
        <div>Tenant management</div>
      </PlatformAdminRoute>,
      {
        authValue: {
          ...mockAuthValue,
          isAuthenticated: false,
          user: null,
        } as unknown as typeof mockAuthValue,
      },
    );

    expect(await screen.findByText('Access Denied')).toBeInTheDocument();
    expect(meCalls()).toHaveLength(0);
  });
});
