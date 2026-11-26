import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { LocalAuthProvider } from '../LocalAuthProvider';
import { queryClient } from '@api/query-client';
import { useConnectorStore } from '@stores/connector-store';
import { usePolicyDraftStore } from '@stores/policy-draft-store';

// Nobody is signed in: the session check is refused.
vi.mock('@api/data', () => ({
  axiosInstance: {
    get: vi.fn(() => Promise.reject({ response: { status: 401 } })),
    post: vi.fn(() => Promise.resolve({ data: {} })),
  },
}));

/** The handler the axios interceptor calls after a 401 it could not refresh. */
let on401: (() => unknown) | null = null;
vi.mock('../token-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../token-store')>()),
  setOn401: (handler: (() => unknown) | null) => {
    on401 = handler;
  },
}));

function renderAt(path: string) {
  // The provider reads the browser path; the router renders from its own entries.
  window.history.replaceState(null, '', path);
  render(
    <MemoryRouter initialEntries={[path]}>
      <LocalAuthProvider>
        <Routes>
          <Route path="/reset-password" element={<p>reset page</p>} />
          <Route path="/dashboard" element={<p>dashboard</p>} />
          <Route path="/login" element={<p>sign-in page</p>} />
        </Routes>
      </LocalAuthProvider>
    </MemoryRouter>,
  );
}

describe('LocalAuthProvider after a refused session', () => {
  beforeEach(() => {
    on401 = null;
  });

  afterEach(() => {
    window.history.replaceState(null, '', '/');
  });

  // The reset page holds the token from the emailed link: sending its visitor to /login would
  // lose it.
  it('leaves a signed-out visitor on the password reset page', async () => {
    renderAt('/reset-password');
    await waitFor(() => expect(on401).not.toBeNull());

    // act: every state update and navigation the handler causes is applied before the check.
    await act(async () => {
      await on401!();
    });

    expect(screen.getByText('reset page')).toBeInTheDocument();
    expect(screen.queryByText('sign-in page')).not.toBeInTheDocument();
  });

  it('still sends an expired session on another page to the sign-in page', async () => {
    renderAt('/dashboard');
    await waitFor(() => expect(on401).not.toBeNull());

    await act(async () => {
      await on401!();
    });

    expect(await screen.findByText('sign-in page')).toBeInTheDocument();
  });
});

// 09 F2: one QueryClient serves the whole tab, and most query keys carry no user or tenant, so
// a next user signing in without a reload saw the previous user's cached rows.
describe('LocalAuthProvider signing out', () => {
  afterEach(() => {
    window.history.replaceState(null, '', '/');
    queryClient.clear();
  });

  it("drops the previous user's cached data, connectors and canvas draft when the session ends", async () => {
    queryClient.setQueryData(['access-requests', 'list'], [{ _id: 'request-of-tenant-x' }]);
    useConnectorStore.setState({
      installed: [{ connectorName: 'okta', config: {}, installedAt: '2026-11-01T00:00:00.000Z' }],
    });
    usePolicyDraftStore.setState({
      draftNodes: [{ id: 'n1', type: 'condition', data: {}, position: { x: 0, y: 0 } }],
    });
    renderAt('/dashboard');
    await waitFor(() => expect(on401).not.toBeNull());
    // The refused session check on mount clears too: seed again for the 401 path itself.
    queryClient.setQueryData(['access-requests', 'list'], [{ _id: 'request-of-tenant-x' }]);
    usePolicyDraftStore.setState({
      draftNodes: [{ id: 'n1', type: 'condition', data: {}, position: { x: 0, y: 0 } }],
    });

    await act(async () => {
      await on401!();
    });

    expect(queryClient.getQueryData(['access-requests', 'list'])).toBeUndefined();
    expect(useConnectorStore.getState().installed).toEqual([]);
    expect(usePolicyDraftStore.getState().draftNodes).toEqual([]);
  });
});
