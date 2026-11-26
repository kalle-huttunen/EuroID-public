/**
 * The connector sync lock: a connector config's `lastSyncStatus: 'running'` and
 * `lastSyncStartedAt`, the time the lock was taken or last renewed
 * (ConnectorConfigService.setSyncRunning). Every holder (the scheduled sync, the inline
 * scheduler, the manual ingest and discover routes) renews it every SYNC_LOCK_RENEW_MS until it
 * writes the sync's status (updateSyncStatus), so a lock not renewed for SYNC_LOCK_STALE_MS
 * belongs to a process that died: the scheduler dispatches the connector again and the next
 * holder takes it. A live sync longer than the stale threshold keeps its lock, and a retry of
 * it finds the lock held. Renewal stops after SYNC_LOCK_MAX_HOLD_MS, so a lock its holder never
 * released goes stale too. No I/O of its own: SyncLockRenewals calls the renewal it is given.
 */

/** A lock not renewed for this long is stale. */
export const SYNC_LOCK_STALE_MS = 30 * 60 * 1000;

/** How often a holder renews its lock. */
export const SYNC_LOCK_RENEW_MS = 5 * 60 * 1000;

/** How long a holder renews at most (a sync running longer loses its lock after the threshold). */
export const SYNC_LOCK_MAX_HOLD_MS = 6 * 60 * 60 * 1000;

/** The lock fields of a connector config. */
export interface SyncLockState {
  lastSyncStatus?: string | null;
  lastSyncStartedAt?: Date | string | null;
}

/** Whether a live holder has the lock: running, and renewed within SYNC_LOCK_STALE_MS. */
export function syncLockHeld(
  doc: SyncLockState | null | undefined,
  now: number = Date.now(),
): boolean {
  if (doc?.lastSyncStatus !== 'running' || !doc.lastSyncStartedAt) return false;
  const renewedAt = new Date(doc.lastSyncStartedAt).getTime();
  return Number.isFinite(renewedAt) && now - renewedAt < SYNC_LOCK_STALE_MS;
}

/** The $or of a connector config whose sync lock can be taken at `now`: free, or stale. */
export function takeableSyncLock(now: Date): Array<Record<string, unknown>> {
  const staleBefore = new Date(now.getTime() - SYNC_LOCK_STALE_MS);
  return [
    { lastSyncStatus: { $ne: 'running' } },
    { lastSyncStartedAt: { $lt: staleBefore } },
    { lastSyncStartedAt: { $exists: false } },
  ];
}

/**
 * The renewals of the sync locks one process holds, by tenant and connector: start() when the
 * lock is taken, stop() when the sync's status is written. Each renewal calls `renew` every
 * SYNC_LOCK_RENEW_MS for at most SYNC_LOCK_MAX_HOLD_MS; a failed renewal is reported to `onError`
 * and the next one tries again. The timers do not keep the process alive.
 */
export class SyncLockRenewals {
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>();

  constructor(
    private readonly renew: (tenantId: string, name: string) => Promise<unknown>,
    private readonly onError: (name: string, err: unknown) => void,
  ) {}

  start(tenantId: string, name: string): void {
    this.stop(tenantId, name);
    const heldSince = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - heldSince >= SYNC_LOCK_MAX_HOLD_MS) {
        this.stop(tenantId, name);
        return;
      }
      this.renew(tenantId, name).catch((err: unknown) => this.onError(name, err));
    }, SYNC_LOCK_RENEW_MS);
    timer.unref?.();
    this.timers.set(`${tenantId}/${name}`, timer);
  }

  stop(tenantId: string, name: string): void {
    const key = `${tenantId}/${name}`;
    const timer = this.timers.get(key);
    if (timer) clearInterval(timer);
    this.timers.delete(key);
  }
}
