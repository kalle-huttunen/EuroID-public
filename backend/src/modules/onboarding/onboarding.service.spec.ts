import { Test } from '@nestjs/testing';
import { WorkflowExecutionAlreadyStartedError, WorkflowNotFoundError } from '@temporalio/common';
import { createMockLoggerFactory } from '@testing/test-helpers';
import { OnboardingService } from './onboarding.service';
import { AuditService } from '../audit/audit.service';
import { LoggerFactoryService } from '@infrastructure/observability/contextual-logger.service';
import { TemporalClientProvider } from '@infrastructure/temporal/temporal-client.provider';

jest.mock('@infrastructure/middleware/get-request-context', () => ({
  getRequestContext: jest.fn().mockReturnValue({ tenantId: 'test-tenant' }),
}));

const ID = '64b7f0c2a1b2c3d4e5f60718';
const EMAIL = 'john@example.com';
const TARGET = { identityId: ID, email: EMAIL };
const WORKFLOW_ID = `t-test-tenant-onboard-${ID}`;
/** The id runs started before plan 2.0dn have: the email with @ and . replaced. */
const LEGACY_ID = 't-test-tenant-onboard-john-at-example-com';

describe('OnboardingService', () => {
  let service: OnboardingService;
  let mockAuditService: { logFireAndForget: jest.Mock };
  let mockWorkflowStart: jest.Mock;
  let mockDescribe: jest.Mock;
  let mockGetHandle: jest.Mock;
  let mockTemporalClientProvider: {
    getClient: jest.Mock;
  };
  let logger: ReturnType<typeof createMockLoggerFactory>['logger'];

  /** A run under the legacy id, of the caller's tenant, in this state. */
  function legacyRun(status: string) {
    mockDescribe.mockResolvedValue({
      status: { name: status },
      searchAttributes: { TenantId: ['test-tenant'] },
    });
  }

  beforeEach(async () => {
    mockWorkflowStart = jest.fn().mockResolvedValue({ workflowId: 'mock-workflow-id' });
    mockDescribe = jest
      .fn()
      .mockRejectedValue(new WorkflowNotFoundError('not found', LEGACY_ID, undefined));
    mockGetHandle = jest.fn(() => ({ describe: mockDescribe }));
    mockTemporalClientProvider = {
      getClient: jest
        .fn()
        .mockReturnValue({ workflow: { start: mockWorkflowStart, getHandle: mockGetHandle } }),
    };
    mockAuditService = { logFireAndForget: jest.fn() };
    const mockLogger = createMockLoggerFactory();
    const loggerFactory = mockLogger.factory;
    logger = mockLogger.logger;

    const module = await Test.createTestingModule({
      providers: [
        OnboardingService,
        { provide: AuditService, useValue: mockAuditService },
        { provide: LoggerFactoryService, useValue: loggerFactory },
        { provide: TemporalClientProvider, useValue: mockTemporalClientProvider },
      ],
    }).compile();

    service = module.get<OnboardingService>(OnboardingService);
  });

  describe('triggerOnboarding', () => {
    it('should call client.workflow.start with correct args', async () => {
      const workflowId = await service.triggerOnboarding(TARGET);

      // The id is built from the identity id
      expect(workflowId).toBe(WORKFLOW_ID);
      expect(mockWorkflowStart).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({
          taskQueue: expect.any(String),
          workflowId: WORKFLOW_ID,
          args: [{ targetEmail: EMAIL, tenantId: 'test-tenant' }],
          searchAttributes: { TenantId: ['test-tenant'] },
          memo: expect.objectContaining({
            triggeredBy: 'OnboardingService',
            targetDescription: `Onboarding: identity ${ID}`,
          }),
        }),
      );
    });

    // The id, memo and audit entry are shown in Temporal's UI, logs, API answers and the audit
    // log, where an email cannot be masked afterwards. Only the workflow input keeps it.
    it('names the person by identity id in the id, memo, log and audit entry, never by email', async () => {
      await service.triggerOnboarding(TARGET, { reason: 'joiner:hr-sync:csv-hr' });

      const [, { args, ...startOptions }] = mockWorkflowStart.mock.calls[0];
      expect(args).toEqual([{ targetEmail: EMAIL, tenantId: 'test-tenant' }]);
      const audit = mockAuditService.logFireAndForget.mock.calls[0][0];
      const logged = JSON.stringify(
        Object.values(logger).map((fn) => (fn as jest.Mock).mock.calls),
      );
      expect(logged).toContain(ID);
      for (const shown of [JSON.stringify(startOptions), JSON.stringify(audit), logged]) {
        expect(shown).not.toMatch(/john/);
      }
    });

    it('passes syncToEntra to the workflow so it provisions a SYNCED Entra ID again', async () => {
      await service.triggerOnboarding(TARGET, { syncToEntra: true });

      expect(mockWorkflowStart).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({
          args: [{ targetEmail: EMAIL, tenantId: 'test-tenant', syncToEntra: true }],
        }),
      );
    });

    it('keeps the reason in the memo and leaves the workflow input unchanged', async () => {
      await service.triggerOnboarding(TARGET, { reason: 'joiner:hr-sync:csv-hr' });

      const [, options] = mockWorkflowStart.mock.calls[0];
      expect(options.args).toEqual([{ targetEmail: EMAIL, tenantId: 'test-tenant' }]);
      expect(options.memo).toEqual({
        triggeredBy: 'OnboardingService',
        targetDescription: `Onboarding: identity ${ID}`,
        reason: 'joiner:hr-sync:csv-hr',
      });
    });

    it('should call auditService.logFireAndForget', async () => {
      await service.triggerOnboarding(TARGET);

      expect(mockAuditService.logFireAndForget).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'PROVISIONING_EXECUTED',
          severity: 'info',
          actor: 'OnboardingService',
          resourceType: 'workflow',
          resourceId: WORKFLOW_ID,
          resourceName: `Onboarding: identity ${ID}`,
          tenantId: 'test-tenant',
        }),
      );
    });

    // A run started before the id changed is still the person's run in progress: starting a
    // second one under the new id would onboard them twice.
    it('fails as already started while a run under the email-based id is open', async () => {
      legacyRun('RUNNING');

      const started = service.triggerOnboarding(TARGET);

      await expect(started).rejects.toBeInstanceOf(WorkflowExecutionAlreadyStartedError);
      await expect(started).rejects.toMatchObject({
        workflowId: LEGACY_ID,
        workflowType: 'onboardingWorkflow',
      });
      expect(mockGetHandle).toHaveBeenCalledWith(LEGACY_ID);
      expect(mockWorkflowStart).not.toHaveBeenCalled();
      expect(mockAuditService.logFireAndForget).not.toHaveBeenCalled();
    });

    it('starts under the new id when the run under the email-based id has closed', async () => {
      legacyRun('COMPLETED');

      await expect(service.triggerOnboarding(TARGET)).resolves.toBe(WORKFLOW_ID);
      expect(mockWorkflowStart).toHaveBeenCalledTimes(1);
    });
  });

  describe('getTemporalClient', () => {
    it('should throw when temporal not connected', () => {
      mockTemporalClientProvider.getClient.mockImplementation(() => {
        throw new Error('Temporal client not connected');
      });

      expect(() => service.getTemporalClient()).toThrow('Temporal client not connected');
    });
  });
});
