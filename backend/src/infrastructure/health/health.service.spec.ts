import { HealthService, ConnectorHealthSummary } from './health.service';

const RECENT = () => new Date(Date.now() - 60_000);
const OLD = new Date('2020-01-01T00:00:00Z');

/** A connector_configs model whose find().setOptions().lean().exec() answers `rows`. */
function configModelWith(rows: unknown[] | Error) {
  const exec = jest.fn(() =>
    rows instanceof Error ? Promise.reject(rows) : Promise.resolve(rows),
  );
  const query = { setOptions: jest.fn(), lean: jest.fn(), exec };
  query.setOptions.mockReturnValue(query);
  query.lean.mockReturnValue(query);
  return { find: jest.fn().mockReturnValue(query), query };
}

const tenantsWith = (tenants: Array<{ tenantId: string; status: string }>) => ({
  findAll: jest.fn().mockResolvedValue(tenants),
});

const summary = (counts: Partial<ConnectorHealthSummary> = {}): ConnectorHealthSummary => ({
  ok: 0,
  stale: 0,
  unknown: 0,
  checkedAt: new Date().toISOString(),
  ...counts,
});

describe('HealthService', () => {
  const savedCacheMs = process.env.HEALTH_CONNECTOR_CACHE_MS;

  afterEach(() => {
    process.env.HEALTH_CONNECTOR_CACHE_MS = savedCacheMs;
    jest.restoreAllMocks();
  });

  describe('computeOverallStatus', () => {
    const service = new HealthService(null as never, null as never);

    it('should return unhealthy when mongodb is down', () => {
      const result = service.computeOverallStatus('error', summary());
      expect(result.overallStatus).toBe('unhealthy');
      expect(result.httpStatus).toBe(503);
    });

    it('should return ok when mongodb is ok and no connector is stale', () => {
      const result = service.computeOverallStatus('ok', summary({ ok: 2, unknown: 1 }));
      expect(result.overallStatus).toBe('ok');
      expect(result.httpStatus).toBe(200);
    });

    it('should return degraded when any connector is stale', () => {
      const result = service.computeOverallStatus('ok', summary({ ok: 1, stale: 1 }));
      expect(result.overallStatus).toBe('degraded');
      expect(result.httpStatus).toBe(200);
    });

    it('is degraded, not unavailable, while the security state store fails', () => {
      // Lockout, break-glass and SAML checks deny then; every instance shares the store.
      expect(service.computeOverallStatus('ok', summary(), 'failing')).toEqual({
        overallStatus: 'degraded',
        httpStatus: 200,
      });
      expect(service.computeOverallStatus('ok', summary(), 'ok').overallStatus).toBe('ok');
      expect(service.computeOverallStatus('error', summary(), 'failing').overallStatus).toBe(
        'unhealthy',
      );
    });

    it('is degraded while a configured access graph is not connected, ok without one', () => {
      // The access explorer answers 503 and the event sync skips its writes then.
      expect(service.computeOverallStatus('ok', summary(), 'ok', 'not-connected')).toEqual({
        overallStatus: 'degraded',
        httpStatus: 200,
      });
      expect(
        service.computeOverallStatus('ok', summary(), 'ok', 'not-configured').overallStatus,
      ).toBe('ok');
      expect(service.computeOverallStatus('ok', summary(), 'ok', 'ok').overallStatus).toBe('ok');
    });

    it('should return ok when no connectors installed', () => {
      expect(service.computeOverallStatus('ok', summary()).overallStatus).toBe('ok');
    });
  });

  /**
   * The probe is public: it counts connectors by status and names none (hunt 07 F6). Before, it
   * answered every tenant's connector names and last-sync times to anyone, with a query per
   * tenant on every call, and left out tenants without a tenants document.
   */
  describe('getConnectorSummary', () => {
    it('counts the connectors of every active tenant by status, and names none', async () => {
      const model = configModelWith([
        { tenantId: 'acme', lastSyncAt: RECENT(), lastSyncStatus: 'success' },
        { tenantId: 'acme', lastSyncAt: OLD, lastSyncStatus: 'success' },
        { tenantId: 'acme' },
        // A tenant without a tenants document (a single-tenant deployment) counts.
        { tenantId: 'default', lastSyncAt: RECENT(), lastSyncStatus: 'failed' },
        // A suspended tenant's connectors do not.
        { tenantId: 'paused', lastSyncAt: OLD, lastSyncStatus: 'failed' },
      ]);
      const service = new HealthService(
        model as never,
        tenantsWith([
          { tenantId: 'acme', status: 'active' },
          { tenantId: 'paused', status: 'suspended' },
        ]) as never,
      );

      const result = await service.getConnectorSummary();

      expect(result).toEqual({ ok: 1, stale: 2, unknown: 1, checkedAt: expect.any(String) });
      // One system query over every tenant, reading no config, no connector name, no id.
      expect(model.find).toHaveBeenCalledTimes(1);
      expect(model.find).toHaveBeenCalledWith({}, '-_id tenantId lastSyncAt lastSyncStatus');
      expect(model.query.setOptions).toHaveBeenCalledWith({ skipTenantScope: true });
    });

    it('reads once per HEALTH_CONNECTOR_CACHE_MS, also for calls at the same time', async () => {
      process.env.HEALTH_CONNECTOR_CACHE_MS = '20000';
      const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
      const model = configModelWith([{ tenantId: 'acme', lastSyncAt: OLD }]);
      const service = new HealthService(model as never, tenantsWith([]) as never);

      await Promise.all([service.getConnectorSummary(), service.getConnectorSummary()]);
      now.mockReturnValue(1_019_999);
      await service.getConnectorSummary();
      expect(model.find).toHaveBeenCalledTimes(1);

      now.mockReturnValue(1_020_001);
      await service.getConnectorSummary();
      expect(model.find).toHaveBeenCalledTimes(2);
    });

    it('answers the counts as not read when the read fails, and reads again on the next call', async () => {
      const model = configModelWith(new Error('connection reset'));
      const service = new HealthService(model as never, tenantsWith([]) as never);

      await expect(service.getConnectorSummary()).resolves.toEqual({
        ok: 0,
        stale: 0,
        unknown: 0,
        checkedAt: null,
      });
      await service.getConnectorSummary();
      expect(model.find).toHaveBeenCalledTimes(2);
    });
  });
});
