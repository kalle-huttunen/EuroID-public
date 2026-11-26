import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { AuthContext } from '../../auth/auth-context';
import { SocketProvider, useRealTimeEvents } from '../realtime';

/** What the console sent the gateway, in order. */
const emitted: Array<[string, unknown]> = [];
const fakeSocket = {
  emit: (event: string, body: unknown) => emitted.push([event, body]),
  on: vi.fn(),
  off: vi.fn(),
  disconnect: vi.fn(),
};
vi.mock('socket.io-client', () => ({ io: () => fakeSocket }));

const signedIn = {
  user: { profile: { sub: 'u1' }, access_token: 'token' },
  isAuthenticated: true,
  isLoading: false,
};

function Listener({ rooms }: { rooms: string | string[] }) {
  useRealTimeEvents(rooms, () => undefined);
  return null;
}

function Page({ canvasOpen }: { canvasOpen: boolean }) {
  return (
    <AuthContext.Provider value={signedIn}>
      <SocketProvider>
        {/* The global notifications listen on every room; the Design studio on 'pipeline'. */}
        <Listener rooms={['pipeline', 'drift']} />
        {canvasOpen && <Listener rooms="pipeline" />}
      </SocketProvider>
    </AuthContext.Provider>
  );
}

/** Rooms named in the unsubscribe messages sent so far. */
const unsubscribed = () =>
  emitted
    .filter(([event]) => event === 'unsubscribe')
    .flatMap(([, body]) => (body as { rooms: string[] }).rooms);

describe('useRealTimeEvents room subscriptions', () => {
  beforeEach(() => {
    emitted.length = 0;
  });

  // 08 F2: the gateway does not count room members per socket, so one consumer's unsubscribe
  // took the room away from every other consumer on the page.
  it('keeps a room another consumer still listens on when one consumer unmounts', async () => {
    const { rerender } = render(<Page canvasOpen />);
    await waitFor(() => expect(emitted.some(([event]) => event === 'subscribe')).toBe(true));

    rerender(<Page canvasOpen={false} />);

    expect(unsubscribed()).not.toContain('pipeline');
  });

  it('leaves a room once its last consumer unmounts', async () => {
    const { unmount } = render(<Page canvasOpen />);
    await waitFor(() => expect(emitted.some(([event]) => event === 'subscribe')).toBe(true));

    unmount();

    expect(unsubscribed().sort()).toEqual(['drift', 'pipeline']);
  });
});
