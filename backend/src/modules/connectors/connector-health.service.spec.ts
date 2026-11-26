import { Logger } from '@nestjs/common';
import { createCache } from 'cache-manager';
import { ConnectorHealthService } from './connector-health.service';
import type { ConnectorConfigService } from './connector-config.service';
import { ConnectorConfigDecryptError } from './connector-config.errors';
import type { PluginRegistryService } from './plugin/plugin-registry.service';
import {
  CONNECTOR_HEALTH_CACHE_TTL_MS,
  CONNECTOR_HEALTH_TIMEOUT_MS,
} from '@infrastructure/config/defaults';

describe('ConnectorHealthService', () => {
  let installed: string[];
  let configs: Record<string, Record<string, string>>;
  let entraCheck: jest.Mock;
  let scimCheck: jest.Mock;
  let getConfig: jest.Mock;
  let service: ConnectorHealthService;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    installed = ['entra-id', 'scim'];
    configs = {
      'entra-id': { tenantId: 'aad-tenant', clientId: 'app' },
      scim: { baseUrl: 'https://scim.example' },
    };
    entraCheck = jest.fn().mockResolvedValue(true);
    scimCheck = jest.fn().mockResolvedValue(false);
    getConfig = jest.fn(async (name: string) => ({ config: configs[name] }));
    // Names only: listing the installed connectors decrypts no config
    const configService = {
      listInstalledNames: jest.fn(async () => installed),
      getConfig,
    } as unknown as ConnectorConfigService;
    const names: Record<string, string> = { 'entra-id': 'Microsoft Entra ID', scim: 'SCIM 2.0' };
    const pluginRegistry = {
      getById: (id: string) => (names[id] ? { name: names[id] } : undefined),
    } as unknown as PluginRegistryService;
    service = new ConnectorHealthService(configService, pluginRegistry, createCache(), {
      'entra-id': entraCheck,
      scim: scimCheck,
    });
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("runs each installed connector's check with the tenant's saved config", async () => {
    const health = await service.getTenantHealth('tenant-a');

    expect(entraCheck).toHaveBeenCalledWith(configs['entra-id'], 'tenant-a');
    expect(scimCheck).toHaveBeenCalledWith(configs.scim, 'tenant-a');
    expect(health).toEqual([
      expect.objectContaining({
        connectorId: 'entra-id',
        connectorName: 'Microsoft Entra ID',
        status: 'healthy',
        monitored: true,
        lastChecked: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
        responseTimeMs: expect.any(Number),
      }),
      expect.objectContaining({
        connectorId: 'scim',
        status: 'down',
        monitored: true,
        lastError: 'Health check failed',
      }),
    ]);
    expect(health[0]).not.toHaveProperty('lastError');
  });

  it('reports a check that throws as down, without the error detail', async () => {
    entraCheck.mockRejectedValue(new Error('getaddrinfo ENOTFOUND login.internal.example'));

    const [entra] = await service.getTenantHealth('tenant-a');

    expect(entra).toMatchObject({ status: 'down', lastError: 'Health check failed' });
    expect(JSON.stringify(entra)).not.toContain('internal.example');
  });

  it('reports a config this process cannot decrypt as down with what to check, and checks the others', async () => {
    const decryptError = new ConnectorConfigDecryptError('entra-id');
    getConfig.mockImplementation(async (name: string) => {
      if (name === 'entra-id') throw decryptError;
      return { config: configs[name] };
    });

    const [entra, scim] = await service.getTenantHealth('tenant-a');

    expect(entra).toMatchObject({ status: 'down', lastError: decryptError.message });
    expect(entraCheck).not.toHaveBeenCalled();
    expect(scim).toMatchObject({ connectorId: 'scim', monitored: true });
    expect(scimCheck).toHaveBeenCalledWith(configs.scim, 'tenant-a');
  });

  it('reports a check that does not answer in time as down', async () => {
    jest.useFakeTimers();
    entraCheck.mockReturnValue(new Promise(() => undefined));

    const pending = service.getTenantHealth('tenant-a');
    await jest.advanceTimersByTimeAsync(CONNECTOR_HEALTH_TIMEOUT_MS);
    const [entra] = await pending;

    expect(entra).toMatchObject({
      status: 'down',
      lastError: `No answer within ${CONNECTOR_HEALTH_TIMEOUT_MS} ms`,
    });
  });

  it('reuses a result within the cache TTL, keeping the time its check ran', async () => {
    jest.useFakeTimers({ now: new Date('2026-11-22T10:00:00Z') });
    const first = await service.getTenantHealth('tenant-a');

    jest.setSystemTime(new Date('2026-11-22T10:00:10Z'));
    const second = await service.getTenantHealth('tenant-a');

    expect(entraCheck).toHaveBeenCalledTimes(1);
    expect(second[0].lastChecked).toBe('2026-11-22T10:00:00.000Z');
    expect(second).toEqual(first);

    jest.setSystemTime(
      new Date(Date.parse('2026-11-22T10:00:00Z') + CONNECTOR_HEALTH_CACHE_TTL_MS + 1),
    );
    const third = await service.getTenantHealth('tenant-a');
    expect(entraCheck).toHaveBeenCalledTimes(2);
    expect(third[0].lastChecked).not.toBe('2026-11-22T10:00:00.000Z');
  });

  it("never serves one tenant's result to another", async () => {
    await service.getTenantHealth('tenant-a');
    entraCheck.mockResolvedValue(false);

    const [entra] = await service.getTenantHealth('tenant-b');

    expect(entraCheck).toHaveBeenLastCalledWith(configs['entra-id'], 'tenant-b');
    expect(entra.status).toBe('down');
  });

  it('reports a connector without a health check as not monitored, never healthy', async () => {
    installed = ['legacy-hr'];

    const [legacy] = await service.getTenantHealth('tenant-a');

    expect(legacy).toEqual(
      expect.objectContaining({
        connectorId: 'legacy-hr',
        connectorName: 'legacy-hr',
        status: 'unknown',
        monitored: false,
        lastChecked: null,
        lastError: 'Not monitored: this connector has no health check',
      }),
    );
  });

  it('lists only the connectors installed for the tenant', async () => {
    installed = [];

    await expect(service.getTenantHealth('tenant-a')).resolves.toEqual([]);
    expect(entraCheck).not.toHaveBeenCalled();
  });
});
