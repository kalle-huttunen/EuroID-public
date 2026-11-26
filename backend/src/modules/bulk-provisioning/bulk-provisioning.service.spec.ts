/**
 * Unit tests for BulkProvisioningService
 * Covers SoD: initiatedBy spoofing, approve-deletes initiator ≠ approver, cancel audit logging
 */

import { Test } from '@nestjs/testing';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { BulkProvisioningService } from './bulk-provisioning.service';
import { AuditService } from '../audit/audit.service';
import { TemporalClientProvider } from '@infrastructure/temporal/temporal-client.provider';
import {
  BulkOperationRequest,
  BulkOperationType,
  OperationPriority,
} from '@shared/dtos/bulk-operation.dto';
import { UserStatus } from '@shared/dtos/standard-user.dto';
import { createHmac } from 'crypto';
import { CorrelationHashService } from '@infrastructure/services/correlation-hash.service';
import { CorrelationConfigService } from '../correlation-config/correlation-config.service';
import { CorrelationConfigUnavailableError } from '../correlation-config/correlation-config.errors';

// Workflow reads by id check the caller's tenant (getTenantWorkflow) against TenantId.
jest.mock('@infrastructure/multi-tenancy/tenant-context.helper', () => ({
  ...jest.requireActual('@infrastructure/multi-tenancy/tenant-context.helper'),
  getCurrentTenantId: () => 'tenant-1',
}));

/** A running workflow description of the caller's tenant (tenant-1). */
const ownWorkflow = (memo: Record<string, unknown>, status = 'RUNNING') => ({
  memo,
  status: { name: status },
  searchAttributes: { TenantId: ['tenant-1'] },
});

describe('BulkProvisioningService', () => {
  let service: BulkProvisioningService;
  let auditService: jest.Mocked<Partial<AuditService>>;

  const mockHandle = {
    describe: jest.fn(),
    signal: jest.fn(),
    terminate: jest.fn(),
    query: jest.fn(),
  };

  const mockClient = {
    workflow: {
      getHandle: jest.fn().mockReturnValue(mockHandle),
      start: jest.fn().mockResolvedValue(undefined),
    },
  };

  const createRequest = (overrides?: Partial<BulkOperationRequest>): BulkOperationRequest => ({
    batchId: 'batch-001',
    tenantId: 'tenant-1',
    initiatedBy: 'system',
    operations: [
      {
        id: 'op-1',
        type: BulkOperationType.CREATE,
        user: {
          sourceSystem: 'Test',
          sourceUserId: 'u1',
          tenantId: 'tenant-1',
          firstName: 'John',
          lastName: 'Doe',
          email: 'john@test.com',
          status: UserStatus.ACTIVE,
          schemaVersion: '2.0.0',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        targetSystems: ['entra-id'],
        priority: OperationPriority.NORMAL,
      },
    ],
    dryRun: true,
    continueOnError: true,
    batchSize: 10,
    requireApprovalForDeletes: false,
    ...overrides,
  });

  /** The tenant's correlation settings: the email rule only, unless a test says otherwise. */
  const correlationConfig = { getCorrelationConfig: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    correlationConfig.getCorrelationConfig.mockResolvedValue({ rules: [{ strategy: 'email' }] });
    mockHandle.describe.mockResolvedValue(ownWorkflow({}));
    mockHandle.query.mockResolvedValue('AWAITING_DELETE_APPROVAL');
    auditService = {
      log: jest.fn().mockResolvedValue(undefined),
      logFireAndForget: jest.fn(),
    };

    const module = await Test.createTestingModule({
      providers: [
        BulkProvisioningService,
        { provide: AuditService, useValue: auditService },
        {
          provide: TemporalClientProvider,
          useValue: { getClient: () => mockClient, isConnected: () => true },
        },
        { provide: CorrelationConfigService, useValue: correlationConfig },
        CorrelationHashService,
      ],
    }).compile();

    service = module.get(BulkProvisioningService);
  });

  describe('initiatedBy (controller responsibility)', () => {
    it('startBulkProvisioning uses initiatedBy from request (controller passes JWT user)', () => {
      // Controller always passes request with initiatedBy set from JWT.
      // Service receives request.initiatedBy - if controller sets it from user?.email,
      // spoofed body values are ignored. This test verifies the service uses request.initiatedBy
      // for the workflow memo (controller must not pass body.initiatedBy).
      const request = createRequest({ initiatedBy: 'auth-user@acme.com' });
      return expect(service.startBulkProvisioning(request))
        .resolves.toMatch(/t-tenant-1-bulk-batch-001-\d+/)
        .then(() => {
          expect(mockClient.workflow.start).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
              memo: expect.objectContaining({
                triggeredBy: 'auth-user@acme.com',
              }),
            }),
          );
        });
    });
  });

  // FOLLOWUPS 2026-11-25 (bulk-provisioning.controller.ts:51-58): the user schema passes unknown
  // keys through, so a national ID went into the workflow input and stayed in the Temporal history
  describe('national IDs in the workflow input', () => {
    const SECRET = 'national-id-secret-for-tests-0123456789';
    const originalSecret = process.env.CORRELATION_HMAC_SECRET;
    /** HMAC(HMAC(secret, tenantId), normalized value), computed here apart from the service. */
    const expectedHash = (value: string) =>
      createHmac('sha256', createHmac('sha256', SECRET).update('tenant-1').digest())
        .update(value.toUpperCase().replace(/[- ]/g, ''))
        .digest('hex');
    const withNationalIds = () => {
      const request = createRequest();
      Object.assign(request.operations[0].user, {
        hetu: '010190-123A',
        correlationId: 'forged-hash',
        customAttributes: { henkilotunnus: '131085-999X', site: 'HQ' },
      });
      return request;
    };
    const startedUser = () =>
      (mockClient.workflow.start.mock.calls[0][1].args[0] as BulkOperationRequest).operations[0]
        .user as unknown as Record<string, unknown>;

    beforeEach(() => {
      process.env.CORRELATION_HMAC_SECRET = SECRET;
    });

    afterAll(() => {
      if (originalSecret === undefined) delete process.env.CORRELATION_HMAC_SECRET;
      else process.env.CORRELATION_HMAC_SECRET = originalSecret;
    });

    it('starts the workflow with the hash of the tenant field only, never a raw value or a body correlationId', async () => {
      correlationConfig.getCorrelationConfig.mockResolvedValue({
        rules: [{ strategy: 'hashedNationalId', nationalIdSourceField: 'henkilotunnus' }],
      });
      const request = withNationalIds();

      await service.startBulkProvisioning(request);

      const user = startedUser();
      expect(user).not.toHaveProperty('hetu');
      expect(user.customAttributes).toEqual({ site: 'HQ' });
      // Final review ID4: the hash travels in a field of its own, never as correlationId
      expect(user.nationalIdHash).toBe(expectedHash('131085-999X'));
      expect(user).not.toHaveProperty('correlationId');
      const input = JSON.stringify(mockClient.workflow.start.mock.calls[0][1].args);
      expect(input).not.toContain('131085');
      expect(input).not.toContain('010190');
      expect(correlationConfig.getCorrelationConfig).toHaveBeenCalledWith('tenant-1', {
        strict: true,
      });
      // The caller's request is left as it was
      expect(request.operations[0].user).toHaveProperty('hetu', '010190-123A');
    });

    // Final review ID4: a correlationId the body brought went on as the national ID hash when the
    // rule was added after the batch start, so the client's value was matched on. It is now always
    // removed (before, without the rule it was kept).
    it('without the rule removes hetu and the body correlationId, hashes nothing and keeps the rest', async () => {
      await service.startBulkProvisioning(withNationalIds());

      const user = startedUser();
      expect(user).not.toHaveProperty('hetu');
      expect(user.customAttributes).toEqual({ henkilotunnus: '131085-999X', site: 'HQ' });
      expect(user).not.toHaveProperty('correlationId');
      expect(user.nationalIdHash).toBeNull();
    });

    it('never takes a nationalIdHash the body brings', async () => {
      const request = withNationalIds();
      Object.assign(request.operations[0].user, { nationalIdHash: 'forged-hash' });

      await service.startBulkProvisioning(request);

      expect(startedUser().nationalIdHash).toBeNull();
    });

    it('starts nothing when the correlation settings cannot be read', async () => {
      correlationConfig.getCorrelationConfig.mockRejectedValue(
        new CorrelationConfigUnavailableError(),
      );

      await expect(service.startBulkProvisioning(withNationalIds())).rejects.toBeInstanceOf(
        CorrelationConfigUnavailableError,
      );
      expect(mockClient.workflow.start).not.toHaveBeenCalled();
    });
  });

  describe('approveDeletes SoD', () => {
    it('throws ForbiddenException when approvedBy === triggeredBy (email)', async () => {
      mockHandle.describe.mockResolvedValue(ownWorkflow({ triggeredBy: 'alice@acme.com' }));

      await expect(service.approveDeletes('wf-123', 'alice@acme.com')).rejects.toThrow(
        ForbiddenException,
      );

      await expect(service.approveDeletes('wf-123', 'alice@acme.com')).rejects.toThrow(
        'Segregation of Duties',
      );

      expect(mockHandle.signal).not.toHaveBeenCalled();
    });

    it('succeeds when approvedBy !== triggeredBy', async () => {
      mockHandle.describe.mockResolvedValue(ownWorkflow({ triggeredBy: 'alice@acme.com' }));

      await service.approveDeletes('wf-123', 'bob@acme.com');

      expect(mockHandle.signal).toHaveBeenCalledWith('approveDeletes');
      expect(auditService.logFireAndForget).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'BULK_DELETES_APPROVED',
          actor: 'bob@acme.com',
          payload: expect.objectContaining({
            metadata: expect.objectContaining({
              approvedBy: 'bob@acme.com',
              initiatedBy: 'alice@acme.com',
            }),
          }),
        }),
      );
    });

    // Hunt 2026-11-25 02 F10: the initiator was compared only when it held an '@', and exactly
    it('refuses the initiator in another case, and a principal without email', async () => {
      mockHandle.describe.mockResolvedValue(ownWorkflow({ triggeredBy: 'Alice@Acme.com' }));
      await expect(service.approveDeletes('wf-123', 'alice@acme.com')).rejects.toThrow(
        ForbiddenException,
      );
      mockHandle.describe.mockResolvedValue(ownWorkflow({ triggeredBy: 'svc-hr-sync' }));
      await expect(service.approveDeletes('wf-123', 'svc-hr-sync')).rejects.toThrow(
        ForbiddenException,
      );
      expect(mockHandle.signal).not.toHaveBeenCalled();
    });

    it('refuses (409) while the batch is not waiting for delete approval', async () => {
      mockHandle.describe.mockResolvedValue(ownWorkflow({ triggeredBy: 'alice@acme.com' }));
      mockHandle.query.mockResolvedValue('EXECUTING_CREATES');

      await expect(service.approveDeletes('wf-123', 'bob@acme.com')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(mockHandle.query).toHaveBeenCalledWith('getCurrentPhase');
      expect(mockHandle.signal).not.toHaveBeenCalled();
    });

    it('refuses (409) a batch that has finished, without asking it', async () => {
      mockHandle.describe.mockResolvedValue(
        ownWorkflow({ triggeredBy: 'alice@acme.com' }, 'COMPLETED'),
      );

      await expect(service.approveDeletes('wf-123', 'bob@acme.com')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(mockHandle.query).not.toHaveBeenCalled();
      expect(mockHandle.signal).not.toHaveBeenCalled();
    });

    it('allows approval when triggeredBy is missing (legacy workflow)', async () => {
      mockHandle.describe.mockResolvedValue(ownWorkflow({}));

      await service.approveDeletes('wf-123', 'bob@acme.com');

      expect(mockHandle.signal).toHaveBeenCalledWith('approveDeletes');
    });

    it('allows approval when triggeredBy is not email-like (BulkProvisioningService)', async () => {
      mockHandle.describe.mockResolvedValue(
        ownWorkflow({ triggeredBy: 'BulkProvisioningService' }),
      );

      await service.approveDeletes('wf-123', 'bob@acme.com');

      expect(mockHandle.signal).toHaveBeenCalledWith('approveDeletes');
    });
  });

  describe('cancelWorkflow audit', () => {
    beforeEach(() => {
      mockHandle.describe.mockResolvedValue(ownWorkflow({ triggeredBy: 'ops@acme.com' }));
    });

    // The workflow compensates and ends CANCELLED itself (bulk-provisioning:cancel-compensates);
    // a terminate left an operation half done and lost the results
    it('signals the run and never terminates it; logs BULK_OPERATION_CANCELLED with cancelledBy', async () => {
      await service.cancelWorkflow('wf-123', 'admin@acme.com');

      expect(mockHandle.signal).toHaveBeenCalledWith('cancelWorkflow');
      expect(mockHandle.terminate).not.toHaveBeenCalled();
      expect(auditService.logFireAndForget).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'BULK_OPERATION_CANCELLED',
          actor: 'admin@acme.com',
          resourceId: 'wf-123',
          payload: expect.objectContaining({
            metadata: { cancelledBy: 'admin@acme.com' },
          }),
        }),
      );
    });

    it('answers 409 for a batch that is not running, and signals nothing', async () => {
      mockHandle.describe.mockResolvedValue(ownWorkflow({}, 'COMPLETED'));

      await expect(service.cancelWorkflow('wf-123', 'admin@acme.com')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(mockHandle.signal).not.toHaveBeenCalled();
      expect(auditService.logFireAndForget).not.toHaveBeenCalled();
    });

    it('uses unknown when cancelledBy is not provided', async () => {
      await service.cancelWorkflow('wf-123');

      expect(auditService.logFireAndForget).toHaveBeenCalledWith(
        expect.objectContaining({
          actor: 'unknown',
          payload: expect.objectContaining({
            metadata: { cancelledBy: undefined },
          }),
        }),
      );
    });
  });
});
