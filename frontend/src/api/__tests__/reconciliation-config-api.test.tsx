/**
 * useDefaultMastery: the tenant's default mastery (GET /admin/reconciliation-config, policy-admin)
 * as the Design studio's Field Mastery tab shows it.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { axiosInstance } from '@api/data';
import { useDefaultMastery } from '@api/reconciliation-config-api';

vi.mock('@api/data', () => ({
  axiosInstance: { get: vi.fn() },
}));

const get = vi.mocked(axiosInstance.get);

function renderUseDefaultMastery(canRead: boolean) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(() => useDefaultMastery(canRead), { wrapper });
}

describe('useDefaultMastery', () => {
  beforeEach(() => vi.clearAllMocks());

  it("gives the tenant's default mastery", async () => {
    get.mockResolvedValue({
      data: { configured: true, config: { defaultMastery: { email: ['entra-id', 'csv-hr'] } } },
    });

    const { result } = renderUseDefaultMastery(true);

    await waitFor(() =>
      expect(result.current).toEqual({
        state: 'loaded',
        mastery: { email: ['entra-id', 'csv-hr'] },
      }),
    );
    expect(get).toHaveBeenCalledWith(expect.stringMatching(/\/admin\/reconciliation-config$/));
  });

  it('says when the tenant has no Recon Config', async () => {
    get.mockResolvedValue({ data: { configured: false, config: null } });

    const { result } = renderUseDefaultMastery(true);

    await waitFor(() => expect(result.current).toEqual({ state: 'unconfigured' }));
  });

  it('asks nothing for a role the endpoint refuses, as for a refused request', async () => {
    const { result } = renderUseDefaultMastery(false);
    expect(result.current).toEqual({ state: 'unreadable' });
    expect(get).not.toHaveBeenCalled();

    get.mockRejectedValue(Object.assign(new Error('Forbidden'), { response: { status: 403 } }));
    const refused = renderUseDefaultMastery(true);
    await waitFor(() => expect(refused.result.current).toEqual({ state: 'unreadable' }));
  });
});
