import { Test } from '@nestjs/testing';
import { WorkflowExecutionAlreadyStartedError, WorkflowNotFoundError } from '@temporalio/common';
import { QueryNotRegisteredError } from '@temporalio/client';
import { createMockLoggerFactory } from '@testing/test-helpers';
import { MoverService, type MoverStartInput } from './mover.service';
import { AuditService } from '../audit/audit.service';
import { LoggerFactoryService } from '@infrastructure/observability/contextual-logger.service';
import { TemporalClientProvider } from '@infrastructure/temporal/temporal-client.provider';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';

jest.mock('@infrastructure/middleware/get-request-context', () => ({
  getRequestContext: jest.fn().mockReturnValue({ tenantId: 'test-tenant' }),
}));

import { getRequestContext } from '@infrastructure/middleware/get-request-context';
const mockGetRequestContext = getRequestContext as jest.Mock;

describe('MoverService', () => {
  let service: MoverService;
  let mockAuditService: { logFireAndForget: jest.Mock };
  let emit: jest.Mock;
  let mockWorkflowStart: jest.Mock;
  let mockTemporalClientProvider: {
    getClient: jest.Mock;
  };

  const baseMoverInput: MoverStartInput = {
    identityId: 'id-001',
    tenantId: 'test-tenant',
    changedFields: ['department', 'title'],
    previousAttributes: { department: 'Sales', title: 'Rep' },
  };

  beforeEach(async () => {
    mockWorkflowStart = jest.fn().mockResolvedValue({ workflowId: 'mock-workflow-id' });
    mockTemporalClientProvider = {
      getClient: jest.fn().mockReturnValue({ workflow: { start: mockWorkflowStart } }),
    };
    mockAuditService = { logFireAndForget: jest.fn() };
    emit = jest.fn();
    mockGetRequestContext.mockReturnValue({ tenantId: 'test-tenant' });
    const { factory: loggerFactory } = createMockLoggerFactory();

    const module = await Test.createTestingModule({
      providers: [
        MoverService,
        { provide: AuditService, useValue: mockAuditService },
        { provide: LoggerFactoryService, useValue: loggerFactory },
        { provide: TemporalClientProvider, useValue: mockTemporalClientProvider },
        { provide: DomainEventEmitterService, useValue: { emit } },
      ],
    }).compile();

    service = module.get<MoverService>(MoverService);
  });

  describe('triggerMover', () => {
    it('names the workflow by tenant and identity id, never by email', async () => {
      const workflowId = await service.triggerMover(baseMoverInput);

      expect(workflowId).toBe('t-test-tenant-mover-id-001');
    });

    it('starts the workflow with ids and policy attributes only: no email, names or contact data', async () => {
      // A PATCH that changed the department together with names and contact data
      const withPersonalData = {
        ...baseMoverInput,
        email: 'jane@example.com',
        previousAttributes: {
          department: 'Sales',
          title: 'Rep',
          displayName: 'Jane Doe',
          email: 'jane@example.com',
          mobilePhone: '+358 40 123 4567',
        },
      } as MoverStartInput;

      await service.triggerMover(withPersonalData);

      const options = mockWorkflowStart.mock.calls[0][1];
      expect(options.args).toEqual([
        {
          identityId: 'id-001',
          tenantId: 'test-tenant',
          changedFields: ['department', 'title'],
          previousAttributes: { department: 'Sales', title: 'Rep' },
          trigger: 'attribute-change',
        },
      ]);
      expect(options.memo).toEqual(
        expect.objectContaining({ changedFields: ['department', 'title'] }),
      );
      const started = JSON.stringify(options);
      for (const personal of ['jane', 'Jane', '4567']) expect(started).not.toContain(personal);
    });

    it('should call auditService.logFireAndForget with correct data', async () => {
      await service.triggerMover(baseMoverInput);

      expect(mockAuditService.logFireAndForget).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'MOVER_WORKFLOW_STARTED',
          severity: 'info',
          actor: 'MoverService',
          resourceType: 'workflow',
          resourceId: 't-test-tenant-mover-id-001',
          resourceName: 'Mover: identity id-001',
          description:
            'Mover workflow started for identity id-001 (attribute-change): department, title',
          tenantId: 'test-tenant',
        }),
      );
    });

    it('publishes mover.started for the timeline, without the email', async () => {
      await service.triggerMover(baseMoverInput);

      expect(emit).toHaveBeenCalledWith(
        DomainEventType.MOVER_STARTED,
        'id-001',
        {
          identityId: 'id-001',
          workflowId: 't-test-tenant-mover-id-001',
          trigger: 'attribute-change',
          changedFields: ['department', 'title'],
        },
        { tenantId: 'test-tenant', actor: 'MoverService' },
      );
    });

    it('a re-evaluation carries its trigger and the operator as actor', async () => {
      await service.triggerMover(
        { ...baseMoverInput, trigger: 're-evaluate' },
        { requestedBy: 'ops@acme.test' },
      );

      expect(mockWorkflowStart).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({
          args: [expect.objectContaining({ trigger: 're-evaluate' })],
          memo: expect.objectContaining({ triggeredBy: 'ops@acme.test', trigger: 're-evaluate' }),
        }),
      );
      expect(emit.mock.calls[0][3]).toEqual({ tenantId: 'test-tenant', actor: 'ops@acme.test' });
      expect(mockAuditService.logFireAndForget).toHaveBeenCalledWith(
        expect.objectContaining({ actor: 'ops@acme.test' }),
      );
    });

    it('passes a sync to Entra ID the edit asked for (PATCH ?syncToEntra=true) to the run', async () => {
      await service.triggerMover({ ...baseMoverInput, syncToEntra: true });

      expect(mockWorkflowStart.mock.calls[0][1].args).toEqual([
        {
          identityId: 'id-001',
          tenantId: 'test-tenant',
          changedFields: ['department', 'title'],
          previousAttributes: { department: 'Sales', title: 'Rep' },
          trigger: 'attribute-change',
          syncToEntra: true,
        },
      ]);
    });

    it('should use input.tenantId when provided', async () => {
      const inputWithTenant: MoverStartInput = {
        ...baseMoverInput,
        tenantId: 'explicit-tenant',
      };

      await service.triggerMover(inputWithTenant);

      expect(mockWorkflowStart).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({
          workflowId: 't-explicit-tenant-mover-id-001',
          args: [expect.objectContaining({ tenantId: 'explicit-tenant' })],
          searchAttributes: { TenantId: ['explicit-tenant'] },
        }),
      );
    });

    it('should fall back to request context tenantId', async () => {
      const inputNoTenant: MoverStartInput = {
        ...baseMoverInput,
        tenantId: '',
      };

      await service.triggerMover(inputNoTenant);

      expect(mockWorkflowStart).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({
          workflowId: 't-test-tenant-mover-id-001',
          args: [expect.objectContaining({ tenantId: 'test-tenant' })],
          searchAttributes: { TenantId: ['test-tenant'] },
        }),
      );
    });
  });

  // Hunt 2026-11-25 03 F5: an edit that met an open run was dropped
  describe('startOrQueueMover', () => {
    const signal = jest.fn();
    const query = jest.fn();
    let result: jest.Mock;
    const alreadyStarted = () =>
      new WorkflowExecutionAlreadyStartedError(
        'Workflow execution already started',
        't-test-tenant-mover-id-001',
        'moverWorkflow',
      );

    beforeEach(() => {
      signal.mockReset().mockResolvedValue(undefined);
      query.mockReset().mockResolvedValue(true);
      result = jest.fn().mockResolvedValue('done');
      mockTemporalClientProvider.getClient.mockReturnValue({
        workflow: {
          start: mockWorkflowStart,
          getHandle: jest.fn(() => ({
            signal,
            query,
            result,
            describe: async () => ({
              status: { name: 'RUNNING' },
              searchAttributes: { TenantId: ['test-tenant'] },
            }),
          })),
        },
      });
    });

    it('starts a run when none is open', async () => {
      await expect(service.startOrQueueMover(baseMoverInput)).resolves.toEqual({
        workflowId: 't-test-tenant-mover-id-001',
        queued: false,
      });
      expect(signal).not.toHaveBeenCalled();
    });

    it('queues the edit on the open run with only what the baseline keeps', async () => {
      mockWorkflowStart.mockRejectedValueOnce(alreadyStarted());

      const start = await service.startOrQueueMover(
        {
          ...baseMoverInput,
          previousAttributes: { department: 'Sales', mobilePhone: '+358 40 123 4567' },
          syncToEntra: true,
        },
        { requestedBy: 'op@corp.example' },
      );

      expect(start).toEqual({ workflowId: 't-test-tenant-mover-id-001', queued: true });
      expect(signal).toHaveBeenCalledWith(expect.objectContaining({ name: 'reevaluate' }), {
        changedFields: ['department', 'title'],
        previousAttributes: { department: 'Sales' },
        syncToEntra: true,
      });
      expect(mockAuditService.logFireAndForget).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'MOVER_CHANGE_QUEUED', actor: 'op@corp.example' }),
      );
    });

    it('starts a run of its own when the open one ended before the signal', async () => {
      mockWorkflowStart.mockRejectedValueOnce(alreadyStarted());
      signal.mockRejectedValueOnce(
        new WorkflowNotFoundError('closed', 't-test-tenant-mover-id-001', undefined),
      );

      await expect(service.startOrQueueMover(baseMoverInput)).resolves.toEqual({
        workflowId: 't-test-tenant-mover-id-001',
        queued: false,
      });
      expect(mockWorkflowStart).toHaveBeenCalledTimes(2);
    });

    // Final review ID3: a run from before the patch mover:queued-edit-query, or one a worker of
    // the old build runs, accepts the signal and then drops the edit when it ends
    describe('an open run that does not answer acceptsQueuedEdits', () => {
      const notRegistered = () =>
        new QueryNotRegisteredError(
          'Workflow did not register a handler for acceptsQueuedEdits',
          3,
        );

      it('is not signalled; a run of its own starts once it has ended', async () => {
        mockWorkflowStart.mockRejectedValueOnce(alreadyStarted());
        query.mockRejectedValueOnce(notRegistered());
        let endOpenRun!: () => void;
        result.mockReturnValueOnce(new Promise<void>((resolve) => (endOpenRun = resolve)));

        const start = await service.startOrQueueMover(baseMoverInput);

        expect(query).toHaveBeenCalledWith(expect.objectContaining({ name: 'acceptsQueuedEdits' }));
        expect(signal).not.toHaveBeenCalled();
        expect(start).toEqual({ workflowId: 't-test-tenant-mover-id-001', queued: true });
        expect(mockWorkflowStart).toHaveBeenCalledTimes(1);

        endOpenRun();
        await new Promise((resolve) => setImmediate(resolve));

        expect(mockWorkflowStart).toHaveBeenCalledTimes(2);
        expect(mockWorkflowStart.mock.calls[1][1]).toMatchObject({
          workflowId: 't-test-tenant-mover-id-001',
        });
      });

      it('also when the open run failed', async () => {
        mockWorkflowStart.mockRejectedValueOnce(alreadyStarted());
        query.mockRejectedValueOnce(notRegistered());
        result.mockRejectedValueOnce(new Error('workflow failed'));

        await service.startOrQueueMover(baseMoverInput);
        await new Promise((resolve) => setImmediate(resolve));

        expect(signal).not.toHaveBeenCalled();
        expect(mockWorkflowStart).toHaveBeenCalledTimes(2);
      });
    });

    it('lets any other start failure through', async () => {
      mockWorkflowStart.mockRejectedValueOnce(new Error('Temporal unavailable'));

      await expect(service.startOrQueueMover(baseMoverInput)).rejects.toThrow(
        'Temporal unavailable',
      );
      expect(signal).not.toHaveBeenCalled();
    });
  });
});
