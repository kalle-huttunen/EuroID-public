import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthContext } from '../../auth/auth-context';
import { SocketProvider, useRealTimeQueryInvalidation, type DomainEventMessage } from '../realtime';
import { POLL_INTERVALS } from '@config/polling';

/** The console's 'domain-event' listeners, so the test can play the gateway. */
const listeners: Array<(msg: DomainEventMessage) => void> = [];
const fakeSocket = {
  emit: vi.fn(),
  on: (event: string, handler: (msg: DomainEventMessage) => void) => {
    if (event === 'domain-event') listeners.push(handler);
  },
  off: (event: string, handler: (msg: DomainEventMessage) => void) => {
    const at = listeners.indexOf(handler);
    if (event === 'domain-event' && at >= 0) listeners.splice(at, 1);
  },
  disconnect: vi.fn(),
};
vi.mock('socket.io-client', () => ({ io: () => fakeSocket }));

const signedIn = {
  user: { profile: { sub: 'u1' }, access_token: 'token' },
  isAuthenticated: true,
  isLoading: false,
};

function Invalidation() {
  useRealTimeQueryInvalidation();
  return null;
}

const WINDOW = POLL_INTERVALS.REALTIME_INVALIDATION_WINDOW_MS;

function gatewaySends(eventType: string, count = 1) {
  act(() => {
    for (let i = 0; i < count; i += 1) {
      for (const listener of [...listeners]) {
        listener({ eventType, timestamp: `t${i}`, payload: { identityId: `id-${i}` } });
      }
    }
  });
}

describe('useRealTimeQueryInvalidation during a burst of events', () => {
  let queryClient: QueryClient;
  let invalidate: ReturnType<typeof vi.spyOn>;

  /** How many times the identity list queries were invalidated (each one is a refetch). */
  const identityInvalidations = () =>
    invalidate.mock.calls.filter(
      ([filters]) =>
        JSON.stringify((filters as { queryKey?: unknown }).queryKey) === '["identity"]',
    ).length;

  beforeEach(async () => {
    listeners.length = 0;
    queryClient = new QueryClient();
    invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    render(
      <AuthContext.Provider value={signedIn}>
        <SocketProvider>
          <QueryClientProvider client={queryClient}>
            <Invalidation />
          </QueryClientProvider>
        </SocketProvider>
      </AuthContext.Provider>,
    );
    await waitFor(() => expect(listeners.length).toBeGreaterThan(0));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // A bulk run or an HR sync sends one identity.* / provisioning.* event per person; each used to
  // refetch every open identity page.
  it('refetches at once on the first event and once per window for the rest of the burst', () => {
    gatewaySends('identity.updated');
    expect(identityInvalidations()).toBe(1);

    gatewaySends('identity.updated', 40);
    gatewaySends('provisioning.completed', 40);
    expect(identityInvalidations()).toBe(1);

    act(() => vi.advanceTimersByTime(WINDOW));
    expect(identityInvalidations()).toBe(2);

    gatewaySends('identity.updated', 40);
    act(() => vi.advanceTimersByTime(WINDOW));
    expect(identityInvalidations()).toBe(3);

    // A window with no events invalidates nothing and closes.
    act(() => vi.advanceTimersByTime(WINDOW * 3));
    expect(identityInvalidations()).toBe(3);
  });

  it('refetches at once again for the first event after the burst is over', () => {
    gatewaySends('identity.created');
    act(() => vi.advanceTimersByTime(WINDOW * 2));
    expect(identityInvalidations()).toBe(1);

    gatewaySends('identity.deleted');
    expect(identityInvalidations()).toBe(2);
  });

  it('coalesces per key prefix: a drift burst does not hold back an audit refetch', () => {
    gatewaySends('drift.detected', 20);
    gatewaySends('audit.event_recorded');

    const keys = invalidate.mock.calls.map(([filters]) =>
      JSON.stringify((filters as { queryKey?: unknown }).queryKey),
    );
    expect(keys.filter((k) => k === '["identity-map"]')).toHaveLength(1);
    expect(keys).toContain('["audit"]');
  });
});
