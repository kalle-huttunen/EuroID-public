/**
 * Unit tests for ReconciliationService
 */

import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ReconciliationService } from './reconciliation.service';
import { CorrelationConfigService } from '../correlation-config/correlation-config.service';
import { CorrelationHashService } from '@infrastructure/services/correlation-hash.service';
import { DevToolsService } from '../dev-tools/dev-tools.service';
import { AuditService } from '../audit/audit.service';
import { TemporalClientProvider } from '@infrastructure/temporal/temporal-client.provider';
import { DEFAULT_PROVISIONING_QUEUE } from '@infrastructure/temporal/task-queue.config';
import {
  ReconciliationConfig,
  DistributedTransactionRequest,
  DriftType,
} from '@shared/dtos/distributed-transaction.dto';
import {
  dailyReconciliationWorkflow,
  userReconciliationWorkflow,
} from '../../workflows/reconciliation.workflow';
import { distributedTransactionWorkflow } from '../../workflows/distributed-transaction.workflow';
import * as getRequestContextModule from '@infrastructure/middleware/get-request-context';

jest.mock('@infrastructure/middleware/get-request-context', () => ({
  getRequestContext: jest.fn(),
}));

// Workflow reads by id check the caller's tenant (getTenantWorkflow) against TenantId.
jest.mock('@infrastructure/multi-tenancy/tenant-context.helper', () => ({
  ...jest.requireActual('@infrastructure/multi-tenancy/tenant-context.helper'),
  getCurrentTenantId: () => 'tenant-1',
}));

const mockWorkflowStart = jest.fn().mockResolvedValue(undefined);
const mockGetHandle = jest.fn();
const mockHandleResult = jest.fn();
const mockHandleDescribe = jest.fn();

const mockTemporalClient = {
  workflow: {
    start: mockWorkflowStart,
    getHandle: mockGetHandle,
  },
};

const mockTemporalClientProvider = {
  getClient: jest.fn().mockReturnValue(mockTemporalClient),
};

const mockAuditService = {
  log: jest.fn().mockResolvedValue(undefined),
  logFireAndForget: jest.fn().mockResolvedValue(undefined),
};

const mockDevToolsService = {
  recordTransaction: jest.fn().mockResolvedValue(undefined),
};

function createMinimalReconciliationConfig(
  overrides?: Partial<ReconciliationConfig>,
): ReconciliationConfig {
  return {
    tenantId: 'tenant-1',
    enabled: true,
    cronSchedule: '0 2 * * *',
    targetSystems: ['entra-id', 'ad'],
    autoCorrect: false,
    autoCorrectTypes: [DriftType.GROUP_MISMATCH],
    requireApprovalForDeletes: true,
    notifyOnDrift: true,
    maxDriftsBeforeAlert: 10,
    criticalDriftAlertThreshold: 5,
    ...overrides,
  };
}

function createMinimalDistributedTransactionRequest(
  overrides?: Partial<DistributedTransactionRequest>,
): DistributedTransactionRequest {
  return {
    transactionId: 'tx-123',
    user: { email: 'user@test.com', firstName: 'Test', lastName: 'User' } as any,
    targetSystems: ['entra-id'],
    operation: 'CREATE',
    initiatedBy: 'operator@test.com',
    ...overrides,
  };
}

describe('ReconciliationService', () => {
  let service: ReconciliationService;
  let auditService: jest.Mocked<AuditService>;
  let devToolsService: jest.Mocked<DevToolsService>;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockGetHandle.mockReturnValue({
      result: mockHandleResult.mockResolvedValue({ success: true }),
      describe: mockHandleDescribe.mockResolvedValue({
        status: { name: 'RUNNING' },
        startTime: new Date(),
        closeTime: undefined,
        searchAttributes: { TenantId: ['tenant-1'] },
      }),
    });
    (getRequestContextModule.getRequestContext as jest.Mock).mockReturnValue({
      tenantId: 'tenant-1',
    });

    const module = await Test.createTestingModule({
      providers: [
        ReconciliationService,
        { provide: TemporalClientProvider, useValue: mockTemporalClientProvider },
        { provide: DevToolsService, useValue: mockDevToolsService },
        { provide: AuditService, useValue: mockAuditService },
        {
          provide: CorrelationConfigService,
          useValue: { getCorrelationConfig: jest.fn().mockResolvedValue({ rules: [] }) },
        },
        { provide: CorrelationHashService, useValue: { hash: jest.fn() } },
      ],
    }).compile();

    service = module.get(ReconciliationService);
    auditService = module.get(AuditService) as jest.Mocked<AuditService>;
    devToolsService = module.get(DevToolsService) as jest.Mocked<DevToolsService>;
  });

  describe('startDailyReconciliation', () => {
    it('should start dailyReconciliationWorkflow with deterministic workflow ID (RC-6)', async () => {
      const config = createMinimalReconciliationConfig();

      const workflowId = await service.startDailyReconciliation(config);

      expect(workflowId).toBe('t-tenant-1-daily-recon');
      expect(mockWorkflowStart).toHaveBeenCalledWith(
        dailyReconciliationWorkflow,
        expect.objectContaining({
          workflowId: 't-tenant-1-daily-recon',
          workflowIdConflictPolicy: expect.anything(),
        }),
      );
    });

    it('runs in the request tenant, ignoring a tenant ID in the config', async () => {
      const config = createMinimalReconciliationConfig({ tenantId: 'tenant-abc' });

      const workflowId = await service.startDailyReconciliation(config);

      expect(workflowId).toBe('t-tenant-1-daily-recon');
      expect(mockWorkflowStart).toHaveBeenCalledWith(
        dailyReconciliationWorkflow,
        expect.objectContaining({
          args: [{ ...config, tenantId: 'tenant-1' }],
          searchAttributes: { TenantId: ['tenant-1'] },
        }),
      );
    });

    it('should use DEFAULT_PROVISIONING_QUEUE', async () => {
      const config = createMinimalReconciliationConfig();

      await service.startDailyReconciliation(config);

      expect(mockWorkflowStart).toHaveBeenCalledWith(
        dailyReconciliationWorkflow,
        expect.objectContaining({
          taskQueue: DEFAULT_PROVISIONING_QUEUE,
        }),
      );
      expect(DEFAULT_PROVISIONING_QUEUE).toBe('provisioning-default');
    });

    it('should emit audit event on success', async () => {
      const config = createMinimalReconciliationConfig();

      const workflowId = await service.startDailyReconciliation(config);

      expect(auditService.logFireAndForget).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'RECONCILIATION_RUN',
          severity: 'info',
          actor: 'ReconciliationService',
          resourceType: 'workflow',
          resourceId: workflowId,
          resourceName: 'Daily Reconciliation',
          tenantId: 'tenant-1',
          description: expect.stringContaining('entra-id'),
        }),
      );
    });

    it('should handle Temporal client errors gracefully', async () => {
      const config = createMinimalReconciliationConfig();
      const error = new Error('Temporal connection failed');
      mockWorkflowStart.mockRejectedValueOnce(error);

      await expect(service.startDailyReconciliation(config)).rejects.toThrow(
        'Temporal connection failed',
      );
    });

    it('should propagate error when Temporal client is not connected', async () => {
      mockTemporalClientProvider.getClient.mockImplementationOnce(() => {
        throw new Error('Temporal is not connected');
      });
      const config = createMinimalReconciliationConfig();

      await expect(service.startDailyReconciliation(config)).rejects.toThrow(
        'Temporal is not connected',
      );
    });
  });

  describe('startUserReconciliation', () => {
    it('should start userReconciliationWorkflow for a specific user ID', async () => {
      (getRequestContextModule.getRequestContext as jest.Mock).mockReturnValue({
        tenantId: 'tenant-1',
      });

      const workflowId = await service.startUserReconciliation('user-123', ['entra-id']);

      expect(workflowId).toMatch(/^t-tenant-1-user-recon-user-123-\d+$/);
      expect(mockWorkflowStart).toHaveBeenCalledWith(
        userReconciliationWorkflow,
        expect.objectContaining({
          args: ['user-123', ['entra-id'], 'tenant-1'],
        }),
      );
    });

    it('should reject if user ID is missing/empty', async () => {
      await expect(service.startUserReconciliation('', ['entra-id'])).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.startUserReconciliation('   ', ['entra-id'])).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('startDistributedTransaction', () => {
    it('should start distributedTransactionWorkflow with the transaction request', async () => {
      const request = createMinimalDistributedTransactionRequest();

      const workflowId = await service.startDistributedTransaction(request);

      expect(workflowId).toBe('t-tenant-1-dist-tx-tx-123');
      expect(mockWorkflowStart).toHaveBeenCalledWith(
        distributedTransactionWorkflow,
        expect.objectContaining({
          args: [
            { ...request, tenantId: 'tenant-1', user: { ...request.user, tenantId: 'tenant-1' } },
          ],
        }),
      );
    });

    it('runs in the request tenant, ignoring tenant IDs in the request and its user', async () => {
      const request = createMinimalDistributedTransactionRequest({
        tenantId: 'tenant-other',
        user: {
          email: 'user@test.com',
          tenantId: 'tenant-other',
        } as DistributedTransactionRequest['user'],
      });

      const workflowId = await service.startDistributedTransaction(request);

      expect(workflowId).toBe('t-tenant-1-dist-tx-tx-123');
      const [, options] = mockWorkflowStart.mock.calls[0];
      expect(options.args[0].tenantId).toBe('tenant-1');
      expect(options.args[0].user.tenantId).toBe('tenant-1');
      expect(options.searchAttributes).toEqual({ TenantId: ['tenant-1'] });
      expect(mockDevToolsService.recordTransaction).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'tenant-1' }),
      );
    });

    it('should validate transaction request shape', async () => {
      const request = createMinimalDistributedTransactionRequest();
      (request as any).transactionId = '';

      await expect(service.startDistributedTransaction(request)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should handle workflow start failure', async () => {
      const request = createMinimalDistributedTransactionRequest();
      mockWorkflowStart.mockRejectedValueOnce(new Error('Workflow start failed'));

      await expect(service.startDistributedTransaction(request)).rejects.toThrow(
        'Workflow start failed',
      );
    });
  });

  describe('tenant isolation', () => {
    it('should include tenant ID in all workflow IDs', async () => {
      const config = createMinimalReconciliationConfig({ tenantId: 'tenant-isolated' });
      (getRequestContextModule.getRequestContext as jest.Mock).mockReturnValue({
        tenantId: 'tenant-isolated',
      });
      const request = createMinimalDistributedTransactionRequest({ tenantId: 'tenant-isolated' });

      const dailyId = await service.startDailyReconciliation(config);
      const userId = await service.startUserReconciliation('u1', ['entra-id']);
      const distTxId = await service.startDistributedTransaction(request);

      expect(dailyId).toBe('t-tenant-isolated-daily-recon');
      expect(userId).toMatch(/^t-tenant-isolated-user-recon-/);
      expect(distTxId).toBe('t-tenant-isolated-dist-tx-tx-123');
    });

    it('should use t-default- when tenant is empty', async () => {
      (getRequestContextModule.getRequestContext as jest.Mock).mockReturnValue(undefined);
      const config = createMinimalReconciliationConfig({
        tenantId: undefined as unknown as string,
      });

      const userId = await service.startUserReconciliation('u2', []);
      const dailyId = await service.startDailyReconciliation(config);

      expect(userId).toMatch(/^t-default-user-recon-/);
      expect(dailyId).toBe('t-default-daily-recon');

      // Verify 'default' is passed as workflow arg (not empty string)
      expect(mockWorkflowStart).toHaveBeenCalledWith(
        userReconciliationWorkflow,
        expect.objectContaining({
          args: ['u2', [], 'default'],
        }),
      );
    });
  });

  describe('getWorkflowHandle', () => {
    it('should return handle from client.workflow.getHandle', async () => {
      const mockHandle = {
        result: jest.fn(),
        describe: jest.fn().mockResolvedValue({ searchAttributes: { TenantId: ['tenant-1'] } }),
      };
      mockGetHandle.mockReturnValue(mockHandle);

      const result = await service.getWorkflowHandle('wf-123');

      expect(mockGetHandle).toHaveBeenCalledWith('wf-123');
      expect(result).toBe(mockHandle);
    });

    it("answers 404 for another tenant's workflow and reads nothing from it", async () => {
      const mockHandle = {
        result: jest.fn(),
        describe: jest.fn().mockResolvedValue({ searchAttributes: { TenantId: ['tenant-2'] } }),
      };
      mockGetHandle.mockReturnValue(mockHandle);

      await expect(service.getWorkflowResult('t-tenant-2-dist-tx-1')).rejects.toThrow(
        NotFoundException,
      );
      expect(mockHandle.result).not.toHaveBeenCalled();
    });
  });

  describe('getWorkflowResult', () => {
    it('should return result from handle.result()', async () => {
      const expectedResult = { success: true };
      mockHandleResult.mockResolvedValue(expectedResult);

      const result = await service.getWorkflowResult('wf-456');

      expect(mockGetHandle).toHaveBeenCalledWith('wf-456');
      expect(mockHandleResult).toHaveBeenCalled();
      expect(result).toEqual(expectedResult);
    });
  });

  describe('getWorkflowStatus', () => {
    it('should return status from handle.describe()', async () => {
      const mockDescription = {
        status: { name: 'COMPLETED' },
        startTime: new Date('2026-01-01'),
        closeTime: new Date('2026-01-02'),
        searchAttributes: { TenantId: ['tenant-1'] },
      };
      mockHandleDescribe.mockResolvedValue(mockDescription);

      const result = await service.getWorkflowStatus('wf-789');

      expect(mockGetHandle).toHaveBeenCalledWith('wf-789');
      expect(mockHandleDescribe).toHaveBeenCalled();
      expect(result).toEqual({
        workflowId: 'wf-789',
        status: 'COMPLETED',
        startTime: mockDescription.startTime,
        closeTime: mockDescription.closeTime,
      });
    });
  });
});
