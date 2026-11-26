/**
 * useIdentity (the identity page's GET /identity/:id). The client here keeps TanStack Query's
 * default retries, as the app's QueryClient does, so the hook's own retry rule is what is tested.
 * Only the delay between retries is zero, which the rule does not depend on.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { axiosInstance } from '@api/data';
import { useIdentity } from '@api/identity-api';

vi.mock('@api/data', () => ({
  axiosInstance: { get: vi.fn() },
}));

const get = vi.mocked(axiosInstance.get);
const ID = '64b7f0c2a1b2c3d4e5f60001';

const httpError = (status: number, message: string) =>
  Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data: { statusCode: status, message } },
  });

function renderUseIdentity() {
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: 0, retryDelay: 0 } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(() => useIdentity(ID), { wrapper });
}

describe('useIdentity', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows a missing identity at once: a 404 is not retried', async () => {
    // Three retries of the 404 kept the page on its skeleton for about 8 s.
    get.mockRejectedValue(httpError(404, `Identity with ID ${ID} not found`));

    const { result } = renderUseIdentity();

    await waitFor(() => expect(result.current.isError).toBe(true), { timeout: 500 });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('still retries other failures', async () => {
    get
      .mockRejectedValueOnce(httpError(503, 'Service Unavailable'))
      .mockResolvedValueOnce({ data: { _id: ID, email: 'maija.meikalainen@corp.example' } });

    const { result } = renderUseIdentity();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(get).toHaveBeenCalledTimes(2);
  });
});
