import { Test, TestingModule } from '@nestjs/testing';
import { PluginRegistryService } from './plugin-registry.service';
import type { ConnectorManifest } from './connector-manifest.interface';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';

describe('PluginRegistryService', () => {
  let service: PluginRegistryService;

  const mockManifest: ConnectorManifest = {
    id: 'test-connector',
    name: 'Test Connector',
    version: '1.0.0',
    description: 'A test connector',
    capabilities: ['provision', 'healthCheck'],
    configSchema: [{ key: 'apiKey', label: 'API Key', type: 'text', required: true }],
    module: class MockModule {},
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PluginRegistryService],
    }).compile();

    service = module.get<PluginRegistryService>(PluginRegistryService);
  });

  it('should register and retrieve a manifest', () => {
    service.register(mockManifest);
    const retrieved = service.getById('test-connector');
    expect(retrieved).toBeDefined();
    expect(retrieved?.id).toBe('test-connector');
    expect(retrieved?.name).toBe('Test Connector');
  });

  it('should not overwrite on duplicate ID (logs warning)', () => {
    const logSpy = jest.spyOn(service['logger'], 'warn').mockImplementation();
    service.register(mockManifest);
    service.register({ ...mockManifest, name: 'Dupe Name' });
    const retrieved = service.getById('test-connector');
    expect(retrieved?.name).toBe('Test Connector');
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Duplicate connector ID'));
    logSpy.mockRestore();
  });

  it('getAll should return all registered connectors', () => {
    service.register(mockManifest);
    service.register({ ...mockManifest, id: 'other', name: 'Other' });
    const all = service.getAll();
    expect(all).toHaveLength(2);
  });

  it('getById should return undefined for unknown id', () => {
    expect(service.getById('nonexistent')).toBeUndefined();
  });

  it('getCapabilities should return capabilities array', () => {
    service.register(mockManifest);
    const caps = service.getCapabilities('test-connector');
    expect(caps).toEqual(['provision', 'healthCheck']);
  });

  it('getCapabilities should return empty array for unknown id', () => {
    expect(service.getCapabilities('nonexistent')).toEqual([]);
  });

  it('getByCapability should filter correctly', () => {
    service.register(mockManifest);
    service.register({
      ...mockManifest,
      id: 'no-provision',
      capabilities: ['healthCheck'],
    });
    const withProvision = service.getByCapability('provision');
    expect(withProvision).toHaveLength(1);
    expect(withProvision[0].id).toBe('test-connector');
  });

  it('getConfigSchema should return config fields', () => {
    service.register(mockManifest);
    const schema = service.getConfigSchema('test-connector');
    expect(schema).toHaveLength(1);
    expect(schema[0].key).toBe('apiKey');
    expect(schema[0].type).toBe('text');
  });

  it('getConfigSchema should return empty array for unknown id', () => {
    expect(service.getConfigSchema('nonexistent')).toEqual([]);
  });

  it('should reject manifest with missing required fields', () => {
    expect(() =>
      service.register({
        ...mockManifest,
        id: undefined as any,
      }),
    ).toThrow();
  });

  it('should reject invalid config field type', () => {
    expect(() =>
      service.register({
        ...mockManifest,
        configSchema: [{ key: 'x', label: 'X', type: 'invalid' as any, required: false }],
      }),
    ).toThrow();
  });

  /**
   * Hunt 2026-11-25 (r2-01 N11): the capability cache was keyed by the connector id and safeLog of
   * the config, which redacts password, clientSecret and token, and it had no tenant. Configs
   * differing only in a secret, or two tenants' configs, shared one validated result.
   */
  describe('getValidatedCapabilities cache', () => {
    class ServiceClass {}
    const validateCapabilities = jest.fn(async (config: { password?: string }) =>
      config.password === 'right' ? ['provision', 'healthCheck'] : ['healthCheck'],
    );

    beforeEach(async () => {
      validateCapabilities.mockClear();
      const moduleRef = { get: () => ({ validateCapabilities }) };
      service = new PluginRegistryService(moduleRef as never);
      service.register({ ...mockManifest, serviceClass: ServiceClass } as ConnectorManifest);
    });

    it('validates a config that differs only in its secret on its own', async () => {
      const base = { host: 'dc.acme.test', serviceAccount: 'svc' };

      await expect(
        service.getValidatedCapabilities('test-connector', { ...base, password: 'right' }),
      ).resolves.toEqual(['provision', 'healthCheck']);
      await expect(
        service.getValidatedCapabilities('test-connector', { ...base, password: 'wrong' }),
      ).resolves.toEqual(['healthCheck']);
      expect(validateCapabilities).toHaveBeenCalledTimes(2);
    });

    it("never answers one tenant with another tenant's cached result", async () => {
      const config = { host: 'dc.acme.test', password: 'right' };

      await withTenantContext('tenant-a', () =>
        service.getValidatedCapabilities('test-connector', config),
      );
      await withTenantContext('tenant-b', () =>
        service.getValidatedCapabilities('test-connector', config),
      );
      await withTenantContext('tenant-a', () =>
        service.getValidatedCapabilities('test-connector', config),
      );

      expect(validateCapabilities).toHaveBeenCalledTimes(2);
    });
  });
});
