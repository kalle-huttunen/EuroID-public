/**
 * Real-time WebSocket provider — connects to backend event gateway.
 * Bridges domain events to React via hooks. Supports notifications and query invalidation.
 */

import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { useQueryClient } from '@tanstack/react-query';
import { App } from 'antd';
import { useAuthContext } from '../auth/auth-context';
import { intelligenceKeys } from './intelligence-api';
import { reconciliationKeys } from './reconciliation-api';
import { identityKeys } from './identity-api';
import { identityMapKeys } from './identity-map-api';
import { auditKeys } from './audit-api';
import { leaverKeys } from './leavers-api';
import { moverKeys } from './hr-movers-api';
import { joinerKeys } from './joiners-api';
import { reviewExclusionKeys } from './review-exclusions-api';
import { POLL_INTERVALS } from '@config/polling';

// ── Types ────────────────────────────────────────────────────────────────

export interface DomainEventMessage {
  eventType: string;
  timestamp: string;
  payload: unknown;
}

export interface SocketContextValue {
  socket: Socket | null;
  status: 'connected' | 'connecting' | 'disconnected';
}

// ── URL helper ─────────────────────────────────────────────────────────────

function getWebSocketUrl(): string {
  const base =
    (typeof import.meta !== 'undefined' &&
      (
        import.meta as {
          env?: { VITE_API_BASE_URL?: string; VITE_API_URL?: string; VITE_API_BASE?: string };
        }
      )?.env?.VITE_API_BASE_URL) ||
    (typeof import.meta !== 'undefined' &&
      (import.meta as { env?: { VITE_API_URL?: string } })?.env?.VITE_API_URL) ||
    (typeof import.meta !== 'undefined' &&
      (import.meta as { env?: { VITE_API_BASE?: string } })?.env?.VITE_API_BASE);
  // Use same origin when base is relative (Vite proxy) so /events goes through proxy
  if (!base || base.startsWith('/')) {
    return `${window.location.origin}/events`;
  }
  try {
    const origin = base.startsWith('http') ? new URL(base).origin : window.location.origin;
    return `${origin}/events`;
  } catch {
    return `${window.location.origin}/events`;
  }
}

// ── Context ────────────────────────────────────────────────────────────────

const SocketContext = createContext<SocketContextValue>({
  socket: null,
  status: 'disconnected',
});

// ── Provider ────────────────────────────────────────────────────────────────

const isAuthDisabled = import.meta.env.DEV && import.meta.env.VITE_AUTH_DISABLED === 'true';

export function SocketProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const auth = useAuthContext();
  const [socket, setSocket] = useState<Socket | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<
    'connected' | 'connecting' | 'disconnected'
  >('disconnected');

  useEffect(() => {
    if (!auth.isAuthenticated) {
      queueMicrotask(() => setSocket(null));
      return;
    }

    const url = getWebSocketUrl();
    const token = auth.user?.access_token;

    const opts: { auth?: { token?: string }; withCredentials?: boolean } = {
      withCredentials: true,
    };
    if (!isAuthDisabled && token) {
      opts.auth = { token };
    }

    const s = io(url, opts);
    let cancelled = false;

    s.on('connect', () => setConnectionStatus('connected'));
    s.on('disconnect', () => setConnectionStatus('disconnected'));

    queueMicrotask(() => {
      if (!cancelled) {
        setSocket(s);
        setConnectionStatus('connecting');
      } else {
        s.disconnect();
      }
    });
    return () => {
      cancelled = true;
      s.disconnect();
      setSocket(null);
    };
  }, [auth.isAuthenticated, auth.user?.access_token]);

  const status = socket ? connectionStatus : 'disconnected';

  return <SocketContext.Provider value={{ socket, status }}>{children}</SocketContext.Provider>;
}

// ── useSocket ───────────────────────────────────────────────────────────────

export function useSocket(): SocketContextValue {
  return useContext(SocketContext);
}

// ── useRealTimeEvents ───────────────────────────────────────────────────────

/**
 * Consumers per room, per socket. The gateway's unsubscribe leaves the room for the whole socket
 * (it counts no members), so the room is left only when its last consumer on the page unmounts.
 */
const roomConsumers = new WeakMap<Socket, Map<string, number>>();

function addConsumer(socket: Socket, rooms: string[]): void {
  const counts = roomConsumers.get(socket) ?? new Map<string, number>();
  roomConsumers.set(socket, counts);
  for (const room of rooms) counts.set(room, (counts.get(room) ?? 0) + 1);
}

/** Removes one consumer of each room; returns the rooms nobody listens on any more. */
function removeConsumer(socket: Socket, rooms: string[]): string[] {
  const counts = roomConsumers.get(socket);
  if (!counts) return rooms;
  const unused: string[] = [];
  for (const room of rooms) {
    const left = (counts.get(room) ?? 1) - 1;
    if (left > 0) {
      counts.set(room, left);
    } else {
      counts.delete(room);
      unused.push(room);
    }
  }
  return unused;
}

export function useRealTimeEvents(
  rooms: string | string[],
  callback: (event: DomainEventMessage) => void,
): void {
  const { socket } = useSocket();
  const callbackRef = useRef(callback);

  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  const roomKey = Array.isArray(rooms) ? rooms.join(',') : rooms;
  const roomList = useMemo(
    () => (Array.isArray(rooms) ? rooms : [rooms]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [roomKey],
  );

  useEffect(() => {
    if (!socket) return;

    const subscribe = () => {
      socket.emit('subscribe', { rooms: roomList });
    };

    const handleEvent = (msg: DomainEventMessage) => {
      callbackRef.current(msg);
    };

    addConsumer(socket, roomList);
    subscribe();
    socket.on('domain-event', handleEvent);
    socket.on('connect', subscribe);

    return () => {
      socket.off('domain-event', handleEvent);
      socket.off('connect', subscribe);
      const unused = removeConsumer(socket, roomList);
      if (unused.length > 0) socket.emit('unsubscribe', { rooms: unused });
    };
  }, [socket, roomList]);
}

// ── useEventNotifications ───────────────────────────────────────────────────

const NOTIFICATION_HANDLERS: Array<{
  pattern: string | RegExp;
  type: 'warning' | 'info' | 'success' | 'error';
  message: (p: Record<string, unknown>) => string;
}> = [
  {
    pattern: 'anomaly.detected',
    type: 'warning',
    message: (p) =>
      `Anomaly Detected — ${(p as { title?: string; type?: string }).title ?? (p as { type?: string }).type ?? 'Unknown'} for ${(p as { identityId?: string }).identityId ?? '—'}`,
  },
  {
    pattern: 'access_review.campaign_activated',
    type: 'info',
    message: (p) => `Access Review Started — ${(p as { name?: string }).name ?? '—'}`,
  },
  {
    pattern: 'access_review.item_expired',
    type: 'warning',
    message: (p) => `Review Item Expired — ${(p as { identityId?: string }).identityId ?? '—'}`,
  },
  {
    pattern: 'provisioning.completed',
    type: 'success',
    message: (p) =>
      `Provisioning Complete — ${(p as { connector?: string }).connector ?? '—'} for ${(p as { identityId?: string }).identityId ?? '—'}`,
  },
  {
    pattern: 'provisioning.failed',
    type: 'error',
    message: (p) =>
      `Provisioning Failed — ${(p as { connector?: string }).connector ?? '—'}: ${(p as { error?: string }).error ?? '—'}`,
  },
  {
    pattern: 'drift.detected',
    type: 'warning',
    message: (p) => {
      const payload = p as {
        identityId?: string;
        userDisplayName?: string;
        system?: string;
        targetSystem?: string;
      };
      const user = payload.userDisplayName ?? payload.identityId ?? '—';
      const connector = payload.targetSystem ?? payload.system ?? '—';
      return `Drift detected for ${user} on ${connector}`;
    },
  },
  {
    pattern: 'drift.resolved',
    type: 'success',
    message: (p) => {
      const payload = p as { identityId?: string; userDisplayName?: string };
      const user = payload.userDisplayName ?? payload.identityId ?? '—';
      return `Drift resolved for ${user}`;
    },
  },
  {
    pattern: 'drift.circuit_breaker_tripped',
    type: 'error',
    message: (p) => `Circuit Breaker Tripped — ${(p as { system?: string }).system ?? '—'}`,
  },
  {
    pattern: 'identity.created',
    type: 'info',
    // The event carries no name or email (identity.created schema), only ids and the source
    message: (p) => {
      const source = (p as { sourceSystem?: string }).sourceSystem;
      return source ? `New identity created via ${source}` : 'New identity created';
    },
  },
  {
    pattern: 'connector.health_changed',
    type: 'warning',
    message: (p) => {
      const payload = p as { name?: string; connectorName?: string; status?: string };
      const name = payload.connectorName ?? payload.name ?? '—';
      const status = payload.status ?? '—';
      return `Connector ${name} status changed to ${status}`;
    },
  },
  {
    pattern: 'pipeline.circuit_breaker_triggered',
    type: 'error',
    message: (p) => {
      const payload = p as { message?: string; errorRate?: number; threshold?: number };
      return (
        payload.message ??
        `Pipeline auto-paused: Error rate ${((payload.errorRate ?? 0) * 100).toFixed(1)}% exceeded ${payload.threshold ?? 5}% threshold`
      );
    },
  },
];

const ALL_ROOMS = [
  'anomalies',
  'provisioning',
  'drift',
  'reviews',
  'system',
  'audit',
  'identity',
  'connectors',
  'pipeline',
];
const MAX_NOTIFICATIONS_PER_WINDOW = 3;

export function useEventNotifications(): void {
  const { notification: antdNotification } = App.useApp();
  const shownKeys = useRef<Set<string>>(new Set());
  const recentCount = useRef(0);
  const windowStart = useRef<number | null>(null);

  useRealTimeEvents(ALL_ROOMS, (event) => {
    const key = `${event.eventType}-${event.timestamp}`;
    if (shownKeys.current.has(key)) return;

    const now = Date.now();
    if (windowStart.current === null) windowStart.current = now;
    if (now - windowStart.current > POLL_INTERVALS.NOTIFICATION_WINDOW_MS) {
      recentCount.current = 0;
      windowStart.current = now;
    }
    if (recentCount.current >= MAX_NOTIFICATIONS_PER_WINDOW) return;

    const handler = NOTIFICATION_HANDLERS.find((h) =>
      typeof h.pattern === 'string'
        ? event.eventType === h.pattern
        : (h.pattern as RegExp).test(event.eventType),
    );
    if (!handler) return;

    shownKeys.current.add(key);
    recentCount.current += 1;

    antdNotification[handler.type]({
      message: handler.message((event.payload as Record<string, unknown>) ?? {}),
      key,
      placement: 'topRight',
    });

    setTimeout(() => shownKeys.current.delete(key), POLL_INTERVALS.NOTIFICATION_DEDUP_MS);
  });
}

// ── useRealTimeQueryInvalidation ───────────────────────────────────────────

const EVENT_INVALIDATION_MAP: Array<{
  pattern: string | RegExp;
  keys: readonly (string | readonly string[])[];
}> = [
  {
    pattern: /^anomaly\.(detected|resolved)$/,
    keys: [intelligenceKeys.anomaliesPrefix(), intelligenceKeys.riskScores()],
  },
  {
    pattern: /^risk_scores\.calculated$/,
    keys: [['intelligence', 'risk-scores-full'], intelligenceKeys.riskScoreDistribution()],
  },
  {
    pattern: /^access_review\./,
    keys: [
      intelligenceKeys.campaignsPrefix(),
      intelligenceKeys.campaignPrefix(),
      intelligenceKeys.myReviewsPrefix(),
      // access_review.exclusion_created / _lifted: the Access tab block, the counts per policy
      reviewExclusionKeys.all,
      reviewExclusionKeys.counts(),
    ],
  },
  {
    pattern: /^provisioning\.(completed|failed)$/,
    keys: [identityKeys.all(), identityMapKeys.all()],
  },
  {
    pattern: /^drift\.(detected|resolved)$/,
    keys: [
      ['drift'],
      reconciliationKeys.all(),
      reconciliationKeys.driftsPrefix(),
      identityMapKeys.all(),
    ],
  },
  {
    pattern: /^policy\./,
    keys: [['policy']],
  },
  {
    pattern: /^audit\./,
    keys: [auditKeys.all],
  },
  {
    pattern: /^identity\.(created|updated|deleted)$/,
    keys: [identityKeys.all(), identityMapKeys.all()],
  },
  {
    pattern: /^connector\.(installed|updated|removed|health_changed)$/,
    keys: [reconciliationKeys.connectorHealth()],
  },
  {
    // Leaver batches paused or decided, offboarding results (system room); identity timelines
    // change with them.
    pattern:
      /^(leaver\.|identity\.leaver_|identity\.offboarding_(completed|target_removed_manually)$)/,
    keys: [leaverKeys.all, identityKeys.all()],
  },
  {
    // HR mover batches paused or decided, the mass-mover limit changed (system room).
    pattern: /^mover\.(batch_|policy_)/,
    keys: [moverKeys.all],
  },
  {
    // HR joiner batches paused or decided, the mass-joiner limit changed, an HR sync started a
    // joiner's onboarding (system room); identity timelines change with the start.
    pattern: /^(joiner\.(batch_|policy_)|identity\.joiner_)/,
    keys: [joinerKeys.all, identityKeys.all()],
  },
];

/** The query key prefixes an event invalidates, each once even when several patterns match. */
function invalidationKeysFor(eventType: string): Map<string, readonly unknown[]> {
  const found = new Map<string, readonly unknown[]>();
  for (const { pattern, keys } of EVENT_INVALIDATION_MAP) {
    const matches = typeof pattern === 'string' ? eventType === pattern : pattern.test(eventType);
    if (!matches) continue;
    for (const key of keys) found.set(JSON.stringify(key), key as readonly unknown[]);
  }
  return found;
}

/**
 * Invalidates the queries a domain event touches. Per query key prefix, the first event
 * invalidates at once and opens a window of `REALTIME_INVALIDATION_WINDOW_MS`; further events
 * inside the window are coalesced into one invalidation when it closes (which opens the next
 * window). A burst of events refetches an open page once per window instead of once per event.
 */
export function useRealTimeQueryInvalidation(): void {
  const queryClient = useQueryClient();
  /** Open windows per key prefix: whether an event arrived since the window opened. */
  const windows = useRef(
    new Map<string, { pending: boolean; timer: ReturnType<typeof setTimeout> }>(),
  );

  useEffect(() => {
    const open = windows.current;
    return () => {
      for (const { timer } of open.values()) clearTimeout(timer);
      open.clear();
    };
  }, []);

  useRealTimeEvents(ALL_ROOMS, (event) => {
    for (const [id, queryKey] of invalidationKeysFor(event.eventType)) {
      const openWindow = windows.current.get(id);
      if (openWindow) {
        openWindow.pending = true;
        continue;
      }
      void queryClient.invalidateQueries({ queryKey });
      const closeWindow = () => {
        const current = windows.current.get(id);
        if (current?.pending) {
          void queryClient.invalidateQueries({ queryKey });
          current.pending = false;
          current.timer = setTimeout(closeWindow, POLL_INTERVALS.REALTIME_INVALIDATION_WINDOW_MS);
        } else {
          windows.current.delete(id);
        }
      };
      windows.current.set(id, {
        pending: false,
        timer: setTimeout(closeWindow, POLL_INTERVALS.REALTIME_INVALIDATION_WINDOW_MS),
      });
    }
  });
}
