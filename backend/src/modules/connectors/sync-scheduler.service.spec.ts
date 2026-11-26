/**
 * What a failed scheduled sync stores for GET /connectors (viewers read it). Hunt 2026-11-25
 * (01 F14): the scheduler stored the raw error message as lastSyncError, which can carry a server
 * path or a snippet of the HR feed; the manual ingest route already stores a generic message.
 */
import { SyncSchedulerService } from './sync-scheduler.service';

type Ctor = ConstructorParameters<typeof SyncSchedulerService>;

function scheduler(capability: 'ingest' | 'discover') {
  const configService = {
    getConfig: jest.fn().mockResolvedValue({ config: { host: 'dc', syncIntervalHours: '1' } }),
    setSyncRunning: jest.fn().mockResolvedValue(true),
    updateSyncStatus: jest.fn().mockResolvedValue(undefined),
  };
  const raw = new Error('JsonApiHrConnector: HTTP 500 body {"internal":"/srv/hr/feed.json"}');
  const service = new SyncSchedulerService(
    configService as unknown as Ctor[0],
    { getById: () => ({ capabilities: [capability] }) } as unknown as Ctor[1],
    { ingestFromConnector: jest.fn().mockRejectedValue(raw) } as unknown as Ctor[2],
    { discoverEntitlements: jest.fn().mockRejectedValue(raw) } as unknown as Ctor[3],
    { discoverAdEntitlements: jest.fn().mockRejectedValue(raw) } as unknown as Ctor[4],
    {} as Ctor[5],
    {} as Ctor[6],
  );
  return { service, configService };
}

describe('SyncSchedulerService: a failed sync', () => {
  it.each([
    ['json-api-hr', 'ingest' as const, 'Data synchronization failed'],
    ['ad', 'discover' as const, 'Entitlement discovery failed'],
  ])(
    'stores a generic lastSyncError for %s, never the raw message',
    async (name, capability, text) => {
      const { service, configService } = scheduler(capability);

      await service.executeSync('t-1', name);

      expect(configService.updateSyncStatus).toHaveBeenCalledWith(
        name,
        expect.objectContaining({ lastSyncStatus: 'failed', lastSyncError: text }),
      );
    },
  );
});
