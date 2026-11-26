import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { OktaService } from './okta.service';
import { OktaDiscoveryService } from './okta-discovery.service';
import { OktaProvisioningService } from './okta-provisioning.service';
import { ConnectorConfigService } from '../connector-config.service';
import { ConnectorConfigDecryptError } from '../connector-config.errors';
import { ConnectorException } from '@shared/exceptions/domain-exceptions';
import { createMockUser } from '@testing';

describe('OktaService', () => {
  let service: OktaService;
  let discovery: jest.Mocked<OktaDiscoveryService>;
  let provisioning: jest.Mocked<OktaProvisioningService>;
  let connectorConfig: jest.Mocked<ConnectorConfigService>;
  let configService: jest.Mocked<ConfigService>;

  const mockOktaConfig = {
    orgUrl: 'https://dev-123456.okta.com',
    apiToken: 'test-api-token',
    defaultGroupId: 'grp-default',
  };

  beforeEach(async () => {
    discovery = {
      healthCheck: jest.fn(),
      discoverEntitlements: jest.fn(),
      validateCapabilities: jest.fn(),
    } as unknown as jest.Mocked<OktaDiscoveryService>;

    provisioning = {
      provision: jest.fn(),
      updateUser: jest.fn(),
      deprovision: jest.fn(),
      deactivateUser: jest.fn(),
    } as unknown as jest.Mocked<OktaProvisioningService>;

    connectorConfig = {
      getConfig: jest.fn(),
    } as unknown as jest.Mocked<ConnectorConfigService>;

    configService = {
      get: jest.fn(),
    } as unknown as jest.Mocked<ConfigService>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OktaService,
        { provide: OktaDiscoveryService, useValue: discovery },
        { provide: OktaProvisioningService, useValue: provisioning },
        { provide: ConnectorConfigService, useValue: connectorConfig },
        { provide: ConfigService, useValue: configService },
      ],
    }).compile();

    service = module.get<OktaService>(OktaService);
  });

  // ── Config Resolution ──────────────────────────────────────────────

  describe('config resolution', () => {
    it('should resolve config from ConnectorConfigService (MongoDB) first', async () => {
      connectorConfig.getConfig.mockResolvedValue({
        config: {
          orgUrl: 'https://from-db.okta.com',
          apiToken: 'db-token',
          defaultGroupId: 'db-group',
        },
      } as any);

      provisioning.provision.mockResolvedValue({ targetUserId: 'okta-user-1' });

      const user = createMockUser();
      await service.create(user);

      expect(connectorConfig.getConfig).toHaveBeenCalledWith('okta');
      expect(provisioning.provision).toHaveBeenCalledWith(
        expect.objectContaining({ orgUrl: 'https://from-db.okta.com', apiToken: 'db-token' }),
        user,
        undefined,
      );
    });

    it('should fall back to env vars when ConnectorConfigService has no config', async () => {
      connectorConfig.getConfig.mockResolvedValue(null);
      configService.get.mockImplementation((key: string) => {
        if (key === 'OKTA_ORG_URL') return 'https://env.okta.com';
        if (key === 'OKTA_API_TOKEN') return 'env-token';
        if (key === 'OKTA_DEFAULT_GROUP_ID') return 'env-group';
        return undefined;
      });

      provisioning.provision.mockResolvedValue({ targetUserId: 'okta-user-2' });

      const user = createMockUser();
      await service.create(user);

      expect(provisioning.provision).toHaveBeenCalledWith(
        expect.objectContaining({ orgUrl: 'https://env.okta.com', apiToken: 'env-token' }),
        user,
        undefined,
      );
    });

    it('should throw ConnectorException when no config is available', async () => {
      connectorConfig.getConfig.mockResolvedValue(null);
      configService.get.mockReturnValue(undefined);

      const user = createMockUser();
      await expect(service.create(user)).rejects.toThrow(/not configured/);
    });

    it.each([
      [{ orgUrl: 'https://tenant.okta.com' }, 'apiToken'],
      [{ apiToken: 'tenant-token', orgUrl: ' ' }, 'orgUrl'],
      [{}, 'orgUrl, apiToken'],
    ])(
      "fails naming the empty setting of an installed config %j, never using the deployment's env vars",
      async (config, empty) => {
        connectorConfig.getConfig.mockResolvedValue({ config } as never);
        configService.get.mockImplementation((key: string) =>
          key === 'OKTA_ORG_URL'
            ? 'https://env.okta.com'
            : key === 'OKTA_API_TOKEN'
              ? 'env-token'
              : undefined,
        );

        const error = await service.create(createMockUser()).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(ConnectorException);
        expect((error as ConnectorException).getStatus()).toBe(400);
        expect((error as Error).message).toBe(
          `Okta config is incomplete (empty: ${empty}): set the org URL and API token in the ` +
            'Okta connector config.',
        );
        expect(provisioning.provision).not.toHaveBeenCalled();
      },
    );

    it('reports an installed config without a token as unhealthy, not as the env org', async () => {
      connectorConfig.getConfig.mockResolvedValue({
        config: { orgUrl: 'https://tenant.okta.com' },
      } as never);
      configService.get.mockReturnValue('from-env');

      await expect(service.healthCheck()).resolves.toBe(false);
      expect(discovery.healthCheck).not.toHaveBeenCalled();
    });

    it("fails, never using the deployment's env vars, when the stored config cannot be decrypted", async () => {
      connectorConfig.getConfig.mockRejectedValue(new ConnectorConfigDecryptError('okta'));
      configService.get.mockImplementation((key: string) =>
        key === 'OKTA_ORG_URL'
          ? 'https://env.okta.com'
          : key === 'OKTA_API_TOKEN'
            ? 'env-token'
            : undefined,
      );

      await expect(service.create(createMockUser())).rejects.toBeInstanceOf(
        ConnectorConfigDecryptError,
      );
      expect(provisioning.provision).not.toHaveBeenCalled();
    });

    // FOLLOWUPS 2026-11-24 (okta.service.ts): a failed read fell back to the deployment's org
    it("fails with the read error, never using the deployment's env vars, when MongoDB cannot be read", async () => {
      const readError = new Error('connect ECONNREFUSED 127.0.0.1:27017');
      connectorConfig.getConfig.mockRejectedValue(readError);
      configService.get.mockImplementation((key: string) =>
        key === 'OKTA_ORG_URL'
          ? 'https://env.okta.com'
          : key === 'OKTA_API_TOKEN'
            ? 'env-token'
            : undefined,
      );

      await expect(service.create(createMockUser())).rejects.toBe(readError);
      expect(provisioning.provision).not.toHaveBeenCalled();
      expect(configService.get).not.toHaveBeenCalled();
    });

    it('fails the health check (retried) on a failed read instead of checking another org', async () => {
      const readError = new Error('connect ECONNREFUSED 127.0.0.1:27017');
      connectorConfig.getConfig.mockRejectedValue(readError);
      configService.get.mockReturnValue('from-env');

      await expect(service.healthCheck()).rejects.toBe(readError);
      expect(discovery.healthCheck).not.toHaveBeenCalled();
    });
  });

  // ── create ─────────────────────────────────────────────────────────

  describe('create', () => {
    it('should delegate to provisioning service and return targetUserId', async () => {
      connectorConfig.getConfig.mockResolvedValue({
        config: mockOktaConfig,
      } as any);
      provisioning.provision.mockResolvedValue({ targetUserId: 'okta-new-user' });

      const user = createMockUser();
      const result = await service.create(user);

      expect(provisioning.provision).toHaveBeenCalled();
      expect(result).toEqual({ targetUserId: 'okta-new-user' });
    });

    it('should pass intent through to provisioning service', async () => {
      connectorConfig.getConfig.mockResolvedValue({
        config: mockOktaConfig,
      } as any);
      provisioning.provision.mockResolvedValue({ targetUserId: 'okta-user-3' });

      const user = createMockUser();
      const intent = {
        operations: [{ type: 'group' as const, action: 'add' as const, targetId: 'grp-1' }],
      };
      await service.create(user, intent);

      expect(provisioning.provision).toHaveBeenCalledWith(expect.any(Object), user, intent);
    });
  });

  // ── healthCheck ────────────────────────────────────────────────────

  describe('healthCheck', () => {
    it('should return false when discovery health check fails', async () => {
      connectorConfig.getConfig.mockResolvedValue({
        config: mockOktaConfig,
      } as any);
      discovery.healthCheck.mockResolvedValue(false);

      const result = await service.healthCheck();
      expect(result).toBe(false);
    });

    it('should return false when config resolution fails', async () => {
      connectorConfig.getConfig.mockResolvedValue(null);
      configService.get.mockReturnValue(undefined);

      const result = await service.healthCheck();
      expect(result).toBe(false);
    });

    it('fails (retried), never unhealthy, when the stored config cannot be decrypted', async () => {
      connectorConfig.getConfig.mockRejectedValue(new ConnectorConfigDecryptError('okta'));

      await expect(service.healthCheck()).rejects.toBeInstanceOf(ConnectorConfigDecryptError);
      expect(discovery.healthCheck).not.toHaveBeenCalled();
    });
  });

  // ── provision (extended) ───────────────────────────────────────────

  describe('provision', () => {
    it('should use provided config over resolved config', async () => {
      const customConfig = { orgUrl: 'https://custom.okta.com', apiToken: 'custom-token' };
      provisioning.provision.mockResolvedValue({ targetUserId: 'custom-user' });

      const user = createMockUser();
      await service.provision(user, undefined, customConfig);

      expect(provisioning.provision).toHaveBeenCalledWith(customConfig, user, undefined);
      // Should NOT call connectorConfig since config was provided
      expect(connectorConfig.getConfig).not.toHaveBeenCalled();
    });
  });

  // ── deactivateUser ─────────────────────────────────────────────────

  describe('deactivateUser', () => {
    it('should delegate to provisioning service', async () => {
      connectorConfig.getConfig.mockResolvedValue({
        config: mockOktaConfig,
      } as any);
      provisioning.deactivateUser.mockResolvedValue(undefined);

      await service.deactivateUser('okta-user-id');

      expect(provisioning.deactivateUser).toHaveBeenCalledWith(
        expect.objectContaining({ orgUrl: mockOktaConfig.orgUrl }),
        'okta-user-id',
      );
    });
  });
});
