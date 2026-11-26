/**
 * The bulk batch runs in the caller's tenant: the workflow input (and every user in it) takes
 * the request-context tenant, whatever tenantId the body carries.
 */

import { ConflictException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { BulkOperationType, OperationPriority } from '@shared/dtos/bulk-operation.dto';
import { UserStatus } from '@shared/dtos/standard-user.dto';
import { BulkProvisioningController } from './bulk-provisioning.controller';
import { BulkProvisioningService } from './bulk-provisioning.service';
import { AuditService } from '../audit/audit.service';
import { CorrelationConfigUnavailableError } from '../correlation-config/correlation-config.errors';

describe('BulkProvisioningController tenant scoping', () => {
  let controller: BulkProvisioningController;
  const service = {
    startBulkProvisioning: jest.fn().mockResolvedValue('wf-1'),
    cancelWorkflow: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      controllers: [BulkProvisioningController],
      providers: [
        { provide: BulkProvisioningService, useValue: service },
        { provide: AuditService, useValue: { logFireAndForget: jest.fn() } },
      ],
    }).compile();
    controller = moduleRef.get(BulkProvisioningController);
  });

  it('ignores the tenantId of the body and of each user', async () => {
    const body = {
      batchId: 'batch-1',
      tenantId: 'tenant-b',
      initiatedBy: 'spoofed@corp.example',
      operations: [
        {
          id: 'op-1',
          type: BulkOperationType.CREATE,
          user: {
            sourceSystem: 'csv',
            sourceUserId: 'u1',
            tenantId: 'tenant-b',
            firstName: 'Ada',
            lastName: 'Lovelace',
            email: 'ada@corp.example',
            status: UserStatus.ACTIVE,
          },
          targetSystems: ['entra-id'],
          priority: OperationPriority.NORMAL,
        },
      ],
    };

    await withTenantContext('tenant-a', () =>
      controller.startBulkProvisioning(body, {
        sub: 'op',
        email: 'op@corp.example',
        name: 'Op',
        roles: ['operator'],
        tenantId: 'tenant-a',
      }),
    );

    const [request] = service.startBulkProvisioning.mock.calls[0];
    expect(request.tenantId).toBe('tenant-a');
    expect(request.operations[0].user.tenantId).toBe('tenant-a');
    expect(request.initiatedBy).toBe('op@corp.example');
  });

  // Hunt 2026-11-25 02 F10: an API caller who left requireApprovalForDeletes out deleted with no
  // approval (the UI sends true), and a principal without an email was recorded as 'admin', so
  // the segregation of duties check could not tell it from its approver
  it('requires delete approval unless the body turns it off, and records a principal without email by its id', async () => {
    const body = {
      batchId: 'batch-3',
      initiatedBy: 'x',
      operations: [
        {
          id: 'op-1',
          type: BulkOperationType.DELETE,
          user: {
            sourceSystem: 'csv',
            sourceUserId: 'u1',
            firstName: 'Ada',
            lastName: 'Lovelace',
            email: 'ada@corp.example',
            status: UserStatus.ACTIVE,
          },
          targetSystems: ['entra-id'],
          priority: OperationPriority.NORMAL,
        },
      ],
    };

    await withTenantContext('tenant-a', () =>
      controller.startBulkProvisioning(body, {
        sub: 'svc-hr-sync',
        name: 'HR sync client',
        roles: ['operator'],
        tenantId: 'tenant-a',
      } as never),
    );
    await withTenantContext('tenant-a', () =>
      controller.startBulkProvisioning({ ...body, requireApprovalForDeletes: false }),
    );

    const [[first], [second]] = service.startBulkProvisioning.mock.calls;
    expect(first.requireApprovalForDeletes).toBe(true);
    expect(first.initiatedBy).toBe('svc-hr-sync');
    expect(second.requireApprovalForDeletes).toBe(false);
  });

  // The national IDs could not be removed from the users (BulkProvisioningService): 503, try again
  it('answers 503 when the correlation settings cannot be read, not 500', async () => {
    service.startBulkProvisioning.mockRejectedValueOnce(new CorrelationConfigUnavailableError());
    const body = {
      batchId: 'batch-2',
      initiatedBy: 'op@corp.example',
      operations: [
        {
          id: 'op-1',
          type: BulkOperationType.CREATE,
          user: {
            sourceSystem: 'csv',
            sourceUserId: 'u1',
            firstName: 'Ada',
            lastName: 'Lovelace',
            email: 'ada@corp.example',
            status: UserStatus.ACTIVE,
          },
          targetSystems: ['entra-id'],
          priority: OperationPriority.NORMAL,
        },
      ],
    };

    await expect(
      withTenantContext('tenant-a', () => controller.startBulkProvisioning(body)),
    ).rejects.toMatchObject({ status: 503 });
  });

  it('answers 409 when the batch to cancel is not running, not 500', async () => {
    service.cancelWorkflow.mockRejectedValueOnce(
      new ConflictException('The batch is not running (COMPLETED): there is nothing to cancel.'),
    );

    await expect(controller.cancelWorkflow('wf-1')).rejects.toMatchObject({ status: 409 });
  });
});
