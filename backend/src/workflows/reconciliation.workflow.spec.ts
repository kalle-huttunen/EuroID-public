/**
 * Reconciliation Workflow Tests
 *
 * Tests scatter-gather pattern, batch failure handling, and progress query.
 * Uses pure Jest mocks instead of TestWorkflowEnvironment.
 */

const mockActivities: Record<string, jest.Mock> = {};
const stableRefs: Record<string, (...args: unknown[]) => unknown> = {};

let setHandlerCallbacks: Map<symbol, Function>;
let executeChildMock: jest.Mock;
let startChildMock: jest.Mock;

jest.mock('@temporalio/workflow', () => {
  setHandlerCallbacks = new Map();
  executeChildMock = jest.fn().mockResolvedValue(undefined);
  startChildMock = jest.fn();
  return {
    proxyActivities: jest.fn(
      () =>
        new Proxy(
          {},
          {
            get: (_target: unknown, prop: string) => {
              if (!stableRefs[prop]) {
                if (!mockActivities[prop]) mockActivities[prop] = jest.fn();
                stableRefs[prop] = (...args: unknown[]) => mockActivities[prop](...args);
              }
              return stableRefs[prop];
            },
          },
        ),
    ),
    defineQuery: jest.fn(() => Symbol('query')),
    defineSignal: jest.fn(() => Symbol('signal')),
    setHandler: jest.fn((queryOrSignal: symbol, handler: Function) => {
      setHandlerCallbacks.set(queryOrSignal, handler);
    }),
    sleep: jest.fn().mockResolvedValue(undefined),
    condition: jest.fn().mockResolvedValue(true),
    log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    ApplicationFailure: {
      nonRetryable: (msg: string, type?: string) => {
        const err = new Error(msg);
        (err as any).type = type;
        return err;
      },
    },
    workflowInfo: jest.fn(() => ({
      workflowId: 'test-workflow-id',
      searchAttributes: { TenantId: ['test-tenant'] },
      memo: { triggeredBy: 'ReconciliationService' },
    })),
    patched: jest.fn(() => true),
    executeChild: (...args: unknown[]) => executeChildMock(...args),
    startChild: (...args: unknown[]) => startChildMock(...args),
    ParentClosePolicy: {
      PARENT_CLOSE_POLICY_TERMINATE: 1,
      PARENT_CLOSE_POLICY_ABANDON: 2,
    },
  };
});

jest.mock('../infrastructure/config/retry-policies', () => ({
  RECONCILIATION_RETRY: { maximumAttempts: 2 },
  CONNECTOR_RETRY: { maximumAttempts: 5 },
  HEALTH_CHECK_RETRY: { maximumAttempts: 3 },
  QUERY_RETRY: { maximumAttempts: 2 },
  BATCH_OPERATION_RETRY: { maximumAttempts: 3 },
  ACCESS_REVIEW_RETRY: { maximumAttempts: 3 },
  ARCHIVAL_RETRY: { maximumAttempts: 3 },
  SCHEDULED_SYNC_RETRY: { maximumAttempts: 2 },
}));

import {
  dailyReconciliationWorkflow,
  getReconciliationProgressQuery,
  userReconciliationWorkflow,
} from './reconciliation.workflow';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/common';
import { orphanCleanupWorkflow } from './orphan-cleanup.workflow';
import type { ReconciliationConfig, ReconciliationReport } from './workflow-types';

const mockConfig: ReconciliationConfig = {
  tenantId: 'test-tenant',
  enabled: true,
  cronSchedule: '0 2 * * *',
  targetSystems: ['entra-id'],
  autoCorrect: false,
  autoCorrectTypes: [],
  requireApprovalForDeletes: true,
  notifyOnDrift: false,
  maxDriftsBeforeAlert: 10,
  criticalDriftAlertThreshold: 5,
};

beforeEach(() => {
  Object.keys(mockActivities).forEach((key) => delete mockActivities[key]);
  jest.clearAllMocks();
});

describe('Reconciliation Workflow', () => {
  it('completes happy path with mocked activities', async () => {
    const startTime = new Date();
    mockActivities.getWorkflowStartTime = jest.fn().mockResolvedValue(startTime);
    mockActivities.getReconciliationUserCount = jest.fn().mockResolvedValue(100);
    mockActivities.getReconciliationBatchPlan = jest.fn().mockResolvedValue([
      { skip: 0, limit: 50, index: 0 },
      { skip: 50, limit: 50, index: 1 },
    ]);
    mockActivities.runOrphanDetection = jest.fn().mockResolvedValue([]);
    mockActivities.updateDriftWorkflowId = jest.fn().mockResolvedValue(undefined);
    mockActivities.generateReport = jest
      .fn()
      .mockImplementation((tenantId, drifts, corrections, startedAt) => {
        const report: ReconciliationReport = {
          reportId: 'report-test',
          tenantId: tenantId ?? '',
          totalUsers: 0,
          scannedUsers: 0,
          usersWithDrift: 0,
          totalDrifts: 0,
          criticalDrifts: 0,
          highDrifts: 0,
          mediumDrifts: 0,
          lowDrifts: 0,
          driftsByType: new Map(),
          driftsBySystem: new Map(),
          autoCorrected: 0,
          requiresManualReview: 0,
          startedAt,
          completedAt: new Date(),
          durationMs: 0,
          drifts: drifts ?? [],
        };
        return report;
      });

    // executeChild returns batch results
    executeChildMock.mockResolvedValue({
      drifts: [],
      corrections: [],
      usersScanned: 50,
      errors: undefined,
    });

    const report = await dailyReconciliationWorkflow(mockConfig);

    expect(report).toBeDefined();
    expect(report.tenantId).toBe('test-tenant');
    expect(mockActivities.getReconciliationUserCount).toHaveBeenCalledWith('test-tenant');
    expect(mockActivities.getReconciliationBatchPlan).toHaveBeenCalledWith('test-tenant', 100);
    expect(mockActivities.generateReport).toHaveBeenCalled();
  });

  it('returns early when totalUsers is 0', async () => {
    mockActivities.getWorkflowStartTime = jest.fn().mockResolvedValue(new Date());
    mockActivities.getReconciliationUserCount = jest.fn().mockResolvedValue(0);
    mockActivities.getReconciliationBatchPlan = jest.fn();
    mockActivities.generateReport = jest
      .fn()
      .mockImplementation((tenantId, drifts, corrections, startedAt) => ({
        reportId: 'report-test',
        tenantId: tenantId ?? '',
        totalUsers: 0,
        scannedUsers: 0,
        usersWithDrift: 0,
        totalDrifts: 0,
        criticalDrifts: 0,
        highDrifts: 0,
        mediumDrifts: 0,
        lowDrifts: 0,
        driftsByType: new Map(),
        driftsBySystem: new Map(),
        autoCorrected: 0,
        requiresManualReview: 0,
        startedAt,
        completedAt: new Date(),
        durationMs: 0,
        drifts: drifts ?? [],
      }));

    const report = await dailyReconciliationWorkflow(mockConfig);

    expect(report.totalUsers).toBe(0);
    expect(mockActivities.getReconciliationBatchPlan).not.toHaveBeenCalled();
    expect(mockActivities.generateReport).toHaveBeenCalled();
  });

  it('continues when one batch fails (partial failure)', async () => {
    mockActivities.getWorkflowStartTime = jest.fn().mockResolvedValue(new Date());
    mockActivities.getReconciliationUserCount = jest.fn().mockResolvedValue(100);
    mockActivities.getReconciliationBatchPlan = jest.fn().mockResolvedValue([
      { skip: 0, limit: 50, index: 0 },
      { skip: 50, limit: 50, index: 1 },
    ]);
    mockActivities.runOrphanDetection = jest.fn().mockResolvedValue([]);
    mockActivities.updateDriftWorkflowId = jest.fn().mockResolvedValue(undefined);
    mockActivities.generateReport = jest
      .fn()
      .mockImplementation((tenantId, drifts, corrections, startedAt) => ({
        reportId: 'report-test',
        tenantId: tenantId ?? '',
        totalUsers: 100,
        scannedUsers: 0,
        usersWithDrift: 0,
        totalDrifts: 0,
        criticalDrifts: 0,
        highDrifts: 0,
        mediumDrifts: 0,
        lowDrifts: 0,
        driftsByType: new Map(),
        driftsBySystem: new Map(),
        autoCorrected: 0,
        requiresManualReview: 0,
        startedAt,
        completedAt: new Date(),
        durationMs: 0,
        drifts: drifts ?? [],
      }));

    // First batch succeeds, second fails
    executeChildMock
      .mockResolvedValueOnce({
        drifts: [],
        corrections: [],
        usersScanned: 50,
        errors: undefined,
      })
      .mockRejectedValueOnce(new Error('Batch 1 failed'));

    const report = await dailyReconciliationWorkflow(mockConfig);

    // The run goes on with the first batch's users: orphan detection, then the report
    expect(report).toMatchObject({ totalUsers: 100, scannedUsers: 50 });
    expect(mockActivities.runOrphanDetection).toHaveBeenCalledWith('entra-id', 'test-tenant');
    // The failed batch is reported, by index and reason
    const { log } = jest.requireMock('@temporalio/workflow');
    expect(log.error).toHaveBeenCalledWith('[Reconciliation] Batch failed', {
      batchIndex: 1,
      error: 'Batch 1 failed',
    });
    expect(log.error).not.toHaveBeenCalledWith(
      '[Reconciliation] Workflow failed',
      expect.anything(),
    );
  });

  describe('child workflows', () => {
    const report = (tenantId: string, drifts: unknown[], _c: unknown, startedAt: Date) => ({
      reportId: 'report-test',
      tenantId,
      drifts,
      startedAt,
    });
    const orphan = {
      driftId: 'drift-1',
      targetSystem: 'entra-id',
      externalId: 'ext-1',
      accountIdentifier: 'orphan@example.com',
      tenantId: 'test-tenant',
    };

    // The cleanup waits out its grace periods (weeks): its result never comes during the run
    const cleanupResult = jest.fn(() => new Promise<void>(() => undefined));

    beforeEach(() => {
      mockActivities.getWorkflowStartTime = jest.fn().mockResolvedValue(new Date());
      mockActivities.getReconciliationUserCount = jest.fn().mockResolvedValue(10);
      mockActivities.getReconciliationBatchPlan = jest
        .fn()
        .mockResolvedValue([{ skip: 0, limit: 10, index: 0 }]);
      mockActivities.runOrphanDetection = jest.fn().mockResolvedValue([orphan]);
      mockActivities.updateDriftWorkflowId = jest.fn().mockResolvedValue(undefined);
      mockActivities.generateReport = jest.fn().mockImplementation(report);
      executeChildMock.mockResolvedValue({ drifts: [], corrections: [], usersScanned: 10 });
      startChildMock.mockImplementation(async (_type: unknown, opts: { workflowId: string }) => ({
        workflowId: opts.workflowId,
        result: cleanupResult,
      }));
    });

    // The cleanup waits weeks; awaiting it kept the run open and the drift without the id the
    // signal route needs (POST /reconciliation/orphans/:driftId/signal).
    it('starts each orphan cleanup, records its workflow id at once and does not wait for it', async () => {
      const result = await dailyReconciliationWorkflow(mockConfig);

      expect(result).toMatchObject({ reportId: 'report-test' });
      // One id per drift (orphan-cleanup-id.ts), whichever run starts it
      const cleanupId = 't-test-tenant-orphan-cleanup-drift-1';
      expect(startChildMock).toHaveBeenCalledWith(
        orphanCleanupWorkflow,
        expect.objectContaining({
          args: [
            {
              driftId: 'drift-1',
              targetSystem: 'entra-id',
              externalId: 'ext-1',
              accountIdentifier: 'orphan@example.com',
              tenantId: 'test-tenant',
              // The run's setting: the cleanup deletes nothing on its own (approval-for-deletes)
              requireApprovalForDeletes: true,
            },
          ],
          workflowId: cleanupId,
          parentClosePolicy: 2, // PARENT_CLOSE_POLICY_ABANDON: the cleanup outlives the run
        }),
      );
      expect(cleanupResult).not.toHaveBeenCalled();
      expect(executeChildMock).not.toHaveBeenCalledWith(orphanCleanupWorkflow, expect.anything());
      expect(mockActivities.updateDriftWorkflowId).toHaveBeenCalledWith(
        'drift-1',
        cleanupId,
        'test-tenant',
      );
      const { patched } = jest.requireMock('@temporalio/workflow');
      expect(patched).toHaveBeenCalledWith('reconciliation:start-orphan-cleanup');
    });

    // A cleanup started before whose id never reached the drift: no second cleanup for it
    it("records the running cleanup's id when the drift's cleanup already runs", async () => {
      const cleanupId = 't-test-tenant-orphan-cleanup-drift-1';
      startChildMock.mockRejectedValueOnce(
        new WorkflowExecutionAlreadyStartedError(
          'Workflow execution already started',
          cleanupId,
          'orphanCleanupWorkflow',
        ),
      );

      await dailyReconciliationWorkflow(mockConfig);

      expect(mockActivities.updateDriftWorkflowId).toHaveBeenCalledWith(
        'drift-1',
        cleanupId,
        'test-tenant',
      );
      expect(mockActivities.generateReport).toHaveBeenCalled();
    });

    it('records no cleanup id when the start fails for another reason', async () => {
      startChildMock.mockRejectedValueOnce(new Error('namespace unavailable'));

      await dailyReconciliationWorkflow(mockConfig);

      expect(mockActivities.updateDriftWorkflowId).not.toHaveBeenCalled();
      expect(mockActivities.generateReport).toHaveBeenCalled();
    });

    it('starts them without, as before, when replaying a history from before the patch', async () => {
      const { patched } = jest.requireMock('@temporalio/workflow');
      patched.mockReturnValue(false);
      try {
        await dailyReconciliationWorkflow(mockConfig);
      } finally {
        patched.mockReturnValue(true);
      }

      // Both patches off: the cleanup is awaited like a batch (executeChild), as before
      expect(executeChildMock).toHaveBeenCalledTimes(2);
      expect(startChildMock).not.toHaveBeenCalled();
      expect(executeChildMock).toHaveBeenCalledWith(
        orphanCleanupWorkflow,
        expect.objectContaining({ workflowId: 'test-workflow-id-orphan-drift-1-0' }),
      );
      for (const [, options] of executeChildMock.mock.calls) {
        expect(options).not.toHaveProperty('searchAttributes');
        expect(options).not.toHaveProperty('memo');
      }
    });
  });

  it('getReconciliationProgressQuery reports the gathered batches, then the completed run', async () => {
    const { setHandler } = jest.requireMock('@temporalio/workflow');
    const progress = () =>
      setHandler.mock.calls.find(
        (call: unknown[]) => call[0] === getReconciliationProgressQuery,
      )[1]();
    let whileReporting: unknown;
    mockActivities.getWorkflowStartTime = jest.fn().mockResolvedValue(new Date());
    mockActivities.getReconciliationUserCount = jest.fn().mockResolvedValue(10);
    mockActivities.getReconciliationBatchPlan = jest.fn().mockResolvedValue([
      { skip: 0, limit: 5, index: 0 },
      { skip: 5, limit: 5, index: 1 },
    ]);
    mockActivities.runOrphanDetection = jest.fn().mockResolvedValue([]);
    mockActivities.generateReport = jest.fn(async (tenantId: string, drifts: unknown[]) => {
      // What the dashboard reads while the report is written (a copy: progress is mutated)
      whileReporting = { ...progress() };
      return { reportId: 'report-test', tenantId, drifts };
    });
    // Batch 0: one user with two drifts, one of two corrections done; batch 1: no drift
    executeChildMock
      .mockResolvedValueOnce({
        drifts: [{ drifts: [{}, {}] }],
        corrections: [{ success: true }, { success: false }],
        usersScanned: 5,
      })
      .mockResolvedValueOnce({ drifts: [], corrections: [], usersScanned: 5 });

    await dailyReconciliationWorkflow(mockConfig);

    expect(whileReporting).toEqual({
      phase: 'GENERATING_REPORT',
      usersScanned: 10,
      totalUsers: 10,
      driftsDetected: 2,
      driftsCorrected: 1,
      percentComplete: 100,
      batchesCompleted: 2,
      totalBatches: 2,
    });
    expect(progress()).toMatchObject({
      phase: 'COMPLETED',
      percentComplete: 100,
      usersScanned: 10,
    });
  });
});

/**
 * The scan scope (includedDepartments, excludedUsers) behind reconciliation:scan-scope. A run
 * started before the patch counted every identity: replayed on the new code it must go on
 * without the scope, or its batches would page a scoped set over an unscoped count. Replay
 * cannot catch that (only activity arguments differ), so patched() is stubbed here.
 */
describe('Reconciliation Workflow scan scope', () => {
  const { patched } = jest.requireMock('@temporalio/workflow') as { patched: jest.Mock };
  const scoped: ReconciliationConfig = {
    ...mockConfig,
    includedDepartments: ['Sales'],
    excludedUsers: ['ceo@example.com'],
  };
  const scope = { includedDepartments: ['Sales'], excludedUsers: ['ceo@example.com'] };

  beforeEach(() => {
    mockActivities.getWorkflowStartTime = jest.fn().mockResolvedValue(new Date());
    mockActivities.getReconciliationUserCount = jest.fn().mockResolvedValue(10);
    mockActivities.getReconciliationBatchPlan = jest
      .fn()
      .mockResolvedValue([{ skip: 0, limit: 10, index: 0 }]);
    mockActivities.runOrphanDetection = jest.fn().mockResolvedValue([]);
    mockActivities.generateReport = jest.fn().mockResolvedValue({ reportId: 'r', drifts: [] });
    executeChildMock.mockResolvedValue({ drifts: [], corrections: [], usersScanned: 10 });
  });

  afterEach(() => {
    patched.mockImplementation(() => true);
  });

  it('hands the scope to the count, every batch and orphan detection', async () => {
    await dailyReconciliationWorkflow(scoped);

    expect(patched).toHaveBeenCalledWith('reconciliation:scan-scope');
    expect(mockActivities.getReconciliationUserCount).toHaveBeenCalledWith('test-tenant', scope);
    expect(executeChildMock.mock.calls[0][1].args[0].scope).toEqual(scope);
    expect(mockActivities.runOrphanDetection).toHaveBeenCalledWith(
      'entra-id',
      'test-tenant',
      scope,
    );
  });

  it('scans every identity in a run started before the patch, its config scoped or not', async () => {
    patched.mockImplementation((id: string) => id !== 'reconciliation:scan-scope');

    await dailyReconciliationWorkflow(scoped);

    expect(mockActivities.getReconciliationUserCount.mock.calls).toEqual([['test-tenant']]);
    expect(executeChildMock.mock.calls[0][1].args[0]).not.toHaveProperty('scope');
    expect(mockActivities.runOrphanDetection.mock.calls).toEqual([['entra-id', 'test-tenant']]);
  });

  it('records no patch for a run without a scope', async () => {
    await dailyReconciliationWorkflow({
      ...mockConfig,
      includedDepartments: [],
      excludedUsers: [],
    });

    expect(patched).not.toHaveBeenCalledWith('reconciliation:scan-scope');
    expect(mockActivities.getReconciliationUserCount.mock.calls).toEqual([['test-tenant']]);
  });
});

describe('User Reconciliation Workflow (on-demand)', () => {
  it('returns drift result for a found user', async () => {
    const mockUser = {
      id: 'user-1',
      email: 'test@test.com',
      firstName: 'Test',
      lastName: 'User',
    };
    const mockDriftResult = {
      userId: 'user-1',
      email: 'test@test.com',
      hasDrift: true,
      hubState: mockUser,
      systemStates: new Map(),
      drifts: [
        {
          system: 'entra-id',
          driftType: 'FIELD_MISMATCH',
          field: 'displayName',
          expected: 'Test User',
          actual: 'Old Name',
          severity: 'LOW' as const,
        },
      ],
      severity: 'LOW' as const,
      detectedAt: new Date(),
    };

    mockActivities.fetchHubUserForReconciliation = jest.fn().mockResolvedValue(mockUser);
    mockActivities.detectUserDrift = jest.fn().mockResolvedValue(mockDriftResult);

    const result = await userReconciliationWorkflow('user-1', ['entra-id'], 'test-tenant');

    expect(result).toBeDefined();
    expect(result.userId).toBe('user-1');
    expect(result.hasDrift).toBe(true);
    expect(mockActivities.fetchHubUserForReconciliation).toHaveBeenCalledWith(
      'test-tenant',
      'user-1',
    );
    expect(mockActivities.detectUserDrift).toHaveBeenCalledWith(
      mockUser,
      ['entra-id'],
      'test-tenant',
    );
  });

  it('throws ApplicationFailure.nonRetryable when user not found', async () => {
    mockActivities.fetchHubUserForReconciliation = jest.fn().mockResolvedValue(null);
    mockActivities.detectUserDrift = jest.fn();

    await expect(
      userReconciliationWorkflow('nonexistent-user', ['entra-id'], 'test-tenant'),
    ).rejects.toThrow(/User not found in Hub/);

    expect(mockActivities.fetchHubUserForReconciliation).toHaveBeenCalledWith(
      'test-tenant',
      'nonexistent-user',
    );
    expect(mockActivities.detectUserDrift).not.toHaveBeenCalled();
  });
});
