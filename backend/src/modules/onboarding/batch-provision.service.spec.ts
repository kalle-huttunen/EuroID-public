import { Test } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { BatchProvisionService } from './batch-provision.service';
import { IdentityService } from '../identity/identity.service';
import { EntraService } from '../connectors/entra-connector/entra.service';
import { TemporalClientProvider } from '@infrastructure/temporal/temporal-client.provider';

jest.mock('@infrastructure/middleware/get-request-context', () => ({
  getRequestContext: jest.fn().mockReturnValue({ tenantId: 'test-tenant' }),
}));

// The real URL builder with the UI address and namespace pinned (the environment may set them)
jest.mock('@infrastructure/config/temporal.config', () => {
  const actual = jest.requireActual<typeof import('@infrastructure/config/temporal.config')>(
    '@infrastructure/config/temporal.config',
  );
  return {
    temporalWorkflowUrl: (workflowId: string) =>
      actual.temporalWorkflowUrl(workflowId, 'http://localhost:8233', 'default'),
  };
});

jest.mock('../../scripts/generate-test-users', () => ({
  generateTestUsers: jest.fn((count: number) =>
    Array.from({ length: count }, (_, i) => ({
      sourceUserId: `test-${i}`,
      displayName: `Test User ${i}`,
      email: `test${i}@example.com`,
      departmentName: 'Engineering',
      city: 'Helsinki',
      status: 'PENDING',
    })),
  ),
}));

describe('BatchProvisionService', () => {
  let service: BatchProvisionService;
  let mockIdentityService: any;
  let mockEntraService: any;
  let mockWorkflowStart: jest.Mock;

  beforeEach(async () => {
    mockIdentityService = {
      saveOrUpdateReportingCreated: jest
        .fn()
        .mockResolvedValue({ createdAt: new Date(), updatedAt: new Date() }),
      findUsersByTagAndStatus: jest.fn().mockResolvedValue([]),
      findUsersByTag: jest.fn().mockResolvedValue([]),
      deleteUsersByTag: jest.fn().mockResolvedValue({ deletedCount: 0 }),
    };

    mockEntraService = {
      checkConnection: jest.fn().mockResolvedValue(true),
      isConfigured: jest.fn().mockReturnValue(true),
      isConfiguredForTenant: jest.fn().mockResolvedValue(true),
      deleteUser: jest.fn().mockResolvedValue(true),
      getConfigKeysCheck: jest.fn(),
      getAvailableLicenses: jest.fn(),
      isDefaultDomainVerified: jest.fn(),
    };

    mockWorkflowStart = jest.fn().mockResolvedValue({ workflowId: 'mock-wf' });
    const mockGetHandle = jest.fn();
    const mockTemporalClientProvider = {
      getClient: jest.fn().mockReturnValue({
        workflow: { start: mockWorkflowStart, getHandle: mockGetHandle },
      }),
    };

    const module = await Test.createTestingModule({
      providers: [
        BatchProvisionService,
        { provide: IdentityService, useValue: mockIdentityService },
        { provide: EntraService, useValue: mockEntraService },
        { provide: TemporalClientProvider, useValue: mockTemporalClientProvider },
      ],
    }).compile();

    service = module.get(BatchProvisionService);
  });

  describe('seedTestUsers', () => {
    it('should call identityService.saveOrUpdateReportingCreated for each user', async () => {
      const result = await service.seedTestUsers(3);

      expect(mockIdentityService.saveOrUpdateReportingCreated).toHaveBeenCalledTimes(3);
      expect(result.summary.total).toBe(3);
      expect(result.users).toHaveLength(3);
    });
  });

  describe('findPendingTestBatchUsers', () => {
    it('should delegate to identityService', async () => {
      const mockUsers = [{ email: 'test@example.com' }];
      mockIdentityService.findUsersByTagAndStatus.mockResolvedValue(mockUsers);

      const result = await service.findPendingTestBatchUsers();

      expect(mockIdentityService.findUsersByTagAndStatus).toHaveBeenCalledWith(
        'test-batch',
        'PENDING',
      );
      expect(result).toEqual(mockUsers);
    });
  });

  describe('triggerEntraProvisioning', () => {
    it('should check Entra connectivity for non-dry-run', async () => {
      mockIdentityService.findUsersByTagAndStatus.mockResolvedValue([
        { email: 'test@example.com' },
      ]);

      await service.triggerEntraProvisioning({ dryRun: false });

      expect(mockEntraService.checkConnection).toHaveBeenCalled();
    });

    it('should return error when Entra is not connected', async () => {
      mockEntraService.checkConnection.mockResolvedValue(false);

      const result = await service.triggerEntraProvisioning({ dryRun: false });

      expect(result).toEqual(
        expect.objectContaining({ error: expect.stringContaining('Entra ID not connected') }),
      );
    });

    it('should return error when no pending users found', async () => {
      mockIdentityService.findUsersByTagAndStatus.mockResolvedValue([]);

      const result = await service.triggerEntraProvisioning({ dryRun: true });

      expect(result).toEqual(
        expect.objectContaining({ error: expect.stringContaining('No pending test-batch users') }),
      );
    });

    it('should start Temporal workflow with correct batch config', async () => {
      const testUsers = [{ email: 'test1@example.com' }, { email: 'test2@example.com' }];
      mockIdentityService.findUsersByTagAndStatus.mockResolvedValue(testUsers);

      const result = await service.triggerEntraProvisioning({ dryRun: true, batchSize: 10 });

      expect(mockWorkflowStart).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({
          workflowId: expect.stringContaining('t-test-tenant-batch-provision-'),
        }),
      );
      expect(result).toEqual(
        expect.objectContaining({
          workflowId: expect.any(String),
          dryRun: true,
          userCount: 2,
        }),
      );
    });

    it('should throw ForbiddenException when tenant context missing', async () => {
      const { getRequestContext } = require('@infrastructure/middleware/get-request-context');
      getRequestContext.mockReturnValueOnce(null);
      mockIdentityService.findUsersByTagAndStatus.mockResolvedValue([
        { email: 'test@example.com' },
      ]);

      await expect(service.triggerEntraProvisioning({ dryRun: true })).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe('cleanupTestUsers', () => {
    it('should delete from MongoDB', async () => {
      mockIdentityService.findUsersByTag.mockResolvedValue([{ email: 'test@example.com' }]);
      mockIdentityService.deleteUsersByTag.mockResolvedValue({ deletedCount: 1 });

      const result = await service.cleanupTestUsers(false);

      expect(mockIdentityService.deleteUsersByTag).toHaveBeenCalledWith('test-batch');
      expect((result as any).mongodb.deleted).toBe(1);
    });

    it('should optionally delete from Entra', async () => {
      mockIdentityService.findUsersByTag.mockResolvedValue([
        { email: 'test@example.com', userPrincipalName: 'test@example.com' },
      ]);
      mockIdentityService.deleteUsersByTag.mockResolvedValue({ deletedCount: 1 });

      const result = await service.cleanupTestUsers(true);

      expect(mockEntraService.deleteUser).toHaveBeenCalledWith('test@example.com');
      expect((result as any).entra).toEqual(
        expect.objectContaining({ attempted: 1, succeeded: 1 }),
      );
    });

    it('should return message when no test users found', async () => {
      mockIdentityService.findUsersByTag.mockResolvedValue([]);

      const result = await service.cleanupTestUsers(false);

      expect(result).toEqual({ message: 'No test-batch users found to clean up.' });
    });
  });

  describe('getHealthDiagnostics (the config Entra ID calls of this tenant run on)', () => {
    const envLoad = {
      processCwd: '/app',
      dirname: '/app/dist',
      attemptedPaths: [],
      firstExisting: null,
    };
    const keys = (status: 'ok' | 'missing') =>
      Object.fromEntries(
        ['ENTRA_TENANT_ID', 'ENTRA_CLIENT_ID', 'ENTRA_CLIENT_SECRET', 'ENTRA_DEFAULT_DOMAIN'].map(
          (key) => [key, { status }],
        ),
      );

    beforeEach(() => {
      mockEntraService.getAvailableLicenses.mockResolvedValue(new Map([['ENTERPRISEPACK', 3]]));
      mockEntraService.isDefaultDomainVerified.mockResolvedValue({
        ok: true,
        domain: 'corp.test',
        verifiedDomains: ['corp.test'],
      });
    });

    it("checks the tenant's installed connector config when ENTRA_* is not set", async () => {
      mockEntraService.tenantConfigSource = jest.fn().mockResolvedValue('tenant-connector');
      mockEntraService.getConfigKeysCheck.mockReturnValue(keys('missing'));

      const result = await service.getHealthDiagnostics(envLoad);

      expect(mockEntraService.checkConnection).toHaveBeenCalledWith();
      expect(result.entra).toEqual({
        configSource: 'tenant-connector',
        configured: true,
        connected: true,
        licenses: { ENTERPRISEPACK: 3 },
        domainCheck: { ok: true, domain: 'corp.test', verifiedDomains: ['corp.test'] },
      });
      expect(result.status).toBe('READY');
      expect(result.message).toContain("tenant's Entra ID connector config");
    });

    it("says the tenant's connector config failed to connect, not the ENTRA_* keys", async () => {
      mockEntraService.tenantConfigSource = jest.fn().mockResolvedValue('tenant-connector');
      mockEntraService.getConfigKeysCheck.mockReturnValue(keys('missing'));
      mockEntraService.checkConnection.mockResolvedValue(false);

      const result = await service.getHealthDiagnostics(envLoad);

      expect(result.status).toBe('AUTH_FAILED');
      expect(result.message).toContain("tenant's Entra ID connector config");
      expect(mockEntraService.getAvailableLicenses).not.toHaveBeenCalled();
    });

    it('names the config whose default domain is not verified', async () => {
      mockEntraService.tenantConfigSource = jest.fn().mockResolvedValue('tenant-connector');
      mockEntraService.getConfigKeysCheck.mockReturnValue(keys('missing'));
      mockEntraService.isDefaultDomainVerified.mockResolvedValue({
        ok: false,
        domain: 'other.test',
        verifiedDomains: ['corp.test'],
      });

      const result = await service.getHealthDiagnostics(envLoad);

      expect(result.status).toBe('DOMAIN_NOT_VERIFIED');
      expect(result.message).toContain("tenant's Entra ID connector config");
      expect(result.message).toContain('"other.test"');
    });

    it('reports no config without a connection attempt when there is none anywhere', async () => {
      mockEntraService.tenantConfigSource = jest.fn().mockResolvedValue('none');
      mockEntraService.getConfigKeysCheck.mockReturnValue(keys('missing'));

      const result = await service.getHealthDiagnostics(envLoad);

      expect(mockEntraService.checkConnection).not.toHaveBeenCalled();
      expect(result.entra).toMatchObject({ configSource: 'none', configured: false });
      expect(result.status).toBe('NOT_CONFIGURED');
    });

    it('checks ENTRA_* for a tenant without an installed config, as before', async () => {
      mockEntraService.tenantConfigSource = jest.fn().mockResolvedValue('environment');
      mockEntraService.getConfigKeysCheck.mockReturnValue(keys('ok'));

      const result = await service.getHealthDiagnostics(envLoad);

      expect(result.entra).toMatchObject({ configSource: 'environment', connected: true });
      expect(result.status).toBe('READY');
      expect(result.message).toBe('Entra ID connected and ready.');
    });
  });

  describe('getHealthCheck', () => {
    it('should return temporal connection status', async () => {
      const result = await service.getHealthCheck();

      expect(result).toEqual(
        expect.objectContaining({
          status: 'ok',
          temporalConnected: true,
        }),
      );
    });
  });
});
