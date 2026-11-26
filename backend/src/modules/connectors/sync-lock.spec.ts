/**
 * The connector sync lock (lastSyncStatus 'running', lastSyncStartedAt). The hourly scheduler
 * skipped a connector whose status said running, with no staleness check, so after a worker died
 * mid-sync the connector's scheduled sync stopped for good (hunt 05 F6, r2-01 N1). And an ingest
 * longer than the 30-minute stale threshold lost its lock to a retry while it still ran (r2-05
 * N10). A holder now renews the lock while its sync runs; a lock not renewed for 30 minutes is
 * stale everywhere.
 */
import { ConnectorConfigService } from './connector-config.service';
import { SyncSchedulerService } from './sync-scheduler.service';
import { SYNC_LOCK_MAX_HOLD_MS, SYNC_LOCK_RENEW_MS, syncLockHeld } from './sync-lock';

type Ctor = ConstructorParameters<typeof ConnectorConfigService>;
type SchedulerCtor = ConstructorParameters<typeof SyncSchedulerService>;

const MINUTE = 60 * 1000;

describe('syncLockHeld', () => {
  const now = Date.parse('2026-11-26T10:00:00Z');
  const at = (minutesAgo: number) => new Date(now - minutesAgo * MINUTE);

  it.each([
    [
      'a running lock renewed 5 minutes ago',
      { lastSyncStatus: 'running', lastSyncStartedAt: at(5) },
      true,
    ],
    [
      'a running lock not renewed for 31 minutes',
      { lastSyncStatus: 'running', lastSyncStartedAt: at(31) },
      false,
    ],
    ['a running lock without a time', { lastSyncStatus: 'running' }, false],
    ['a finished sync', { lastSyncStatus: 'success', lastSyncStartedAt: at(1) }, false],
    ['no config', null, false],
  ])('%s: held=%s', (_label, doc, held) => {
    expect(syncLockHeld(doc as never, now)).toBe(held);
  });
});

describe('ConnectorConfigService: a held sync lock is renewed', () => {
  const updateOne = jest.fn((_filter: Record<string, unknown>, _update: unknown) => ({
    exec: jest.fn().mockResolvedValue({}),
  }));
  const configModel = {
    findOneAndUpdate: jest.fn().mockResolvedValue({ connectorName: 'csv-hr' }),
    updateOne,
  };
  const service = new ConnectorConfigService(
    configModel as unknown as Ctor[0],
    {} as Ctor[1],
    {} as Ctor[2],
    {} as Ctor[3],
    {} as Ctor[4],
  );

  beforeEach(() => {
    jest.useFakeTimers();
    updateOne.mockClear();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const renewals = () =>
    updateOne.mock.calls.filter(([filter]) => filter.lastSyncStatus === 'running');

  it('renews it while the sync runs, and stops when the status is written', async () => {
    await expect(service.setSyncRunning('csv-hr')).resolves.toBe(true);

    jest.advanceTimersByTime(SYNC_LOCK_RENEW_MS * 3);
    expect(renewals()).toHaveLength(3);
    expect(renewals()[0][0]).toEqual({
      connectorName: 'csv-hr',
      tenantId: 'default',
      lastSyncStatus: 'running',
    });

    await service.updateSyncStatus('csv-hr', { lastSyncAt: new Date(), lastSyncStatus: 'success' });
    updateOne.mockClear();
    jest.advanceTimersByTime(SYNC_LOCK_RENEW_MS * 3);
    expect(renewals()).toHaveLength(0);
  });

  it('stops renewing after SYNC_LOCK_MAX_HOLD_MS, so a lock never released goes stale', async () => {
    await service.setSyncRunning('csv-hr');

    jest.advanceTimersByTime(SYNC_LOCK_MAX_HOLD_MS + SYNC_LOCK_RENEW_MS * 4);

    expect(renewals().length).toBeLessThanOrEqual(SYNC_LOCK_MAX_HOLD_MS / SYNC_LOCK_RENEW_MS + 1);
    updateOne.mockClear();
    jest.advanceTimersByTime(SYNC_LOCK_RENEW_MS * 4);
    expect(renewals()).toHaveLength(0);
    await service.updateSyncStatus('csv-hr', { lastSyncAt: new Date(), lastSyncStatus: 'failed' });
  });
});

describe('SyncSchedulerService: the hourly dispatch and a running lock', () => {
  function scheduler(doc: Record<string, unknown>) {
    const start = jest.fn().mockResolvedValue(undefined);
    const service = new SyncSchedulerService(
      {
        getConfig: jest.fn().mockResolvedValue({ config: { syncIntervalHours: '1' }, ...doc }),
        listInstalledNames: jest.fn().mockResolvedValue(['csv-hr']),
      } as unknown as SchedulerCtor[0],
      { getById: () => ({ capabilities: ['ingest'] }) } as unknown as SchedulerCtor[1],
      {} as SchedulerCtor[2],
      {} as SchedulerCtor[3],
      {} as SchedulerCtor[4],
      {
        findAll: jest.fn().mockResolvedValue([{ tenantId: 't-1', name: 'T', status: 'active' }]),
      } as unknown as SchedulerCtor[5],
      {
        isConnected: () => true,
        getClient: () => ({ workflow: { start } }),
      } as unknown as SchedulerCtor[6],
    );
    return { service, start };
  }
  const twoHoursAgo = new Date(Date.now() - 120 * MINUTE);

  it('dispatches a connector whose running lock went stale (its holder died)', async () => {
    const { service, start } = scheduler({
      lastSyncAt: twoHoursAgo,
      lastSyncStatus: 'running',
      lastSyncStartedAt: new Date(Date.now() - 31 * MINUTE),
    });

    await service.checkAndRunSyncs();

    expect(start).toHaveBeenCalledTimes(1);
  });

  it('leaves a connector whose sync runs and renews its lock', async () => {
    const { service, start } = scheduler({
      lastSyncAt: twoHoursAgo,
      lastSyncStatus: 'running',
      lastSyncStartedAt: new Date(Date.now() - 2 * MINUTE),
    });

    await service.checkAndRunSyncs();

    expect(start).not.toHaveBeenCalled();
  });
});
