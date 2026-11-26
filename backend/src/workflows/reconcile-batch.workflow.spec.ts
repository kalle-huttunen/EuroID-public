/**
 * Reconcile Batch Workflow Tests (Child of reconciliation)
 *
 * Uses pure Jest mocks instead of TestWorkflowEnvironment.
 */

const mockActivities: Record<string, jest.Mock> = {};
const stableRefs: Record<string, (...args: unknown[]) => unknown> = {};

jest.mock('@temporalio/workflow', () => ({
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
  setHandler: jest.fn(),
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
  workflowInfo: jest.fn(() => ({ workflowId: 'test-workflow-id' })),
  patched: jest.fn(() => true),
  executeChild: jest.fn().mockResolvedValue(undefined),
  ParentClosePolicy: {
    PARENT_CLOSE_POLICY_TERMINATE: 1,
    PARENT_CLOSE_POLICY_ABANDON: 2,
  },
}));

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

import { reconcileBatchWorkflow } from './reconcile-batch.workflow';
import { DriftType, type ReconciliationConfig } from './workflow-types';

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

describe('Reconcile Batch Workflow', () => {
  it('completes batch with no users', async () => {
    mockActivities.fetchHubUsersPage = jest.fn().mockResolvedValue({
      users: [],
      nextPageToken: null,
      total: 0,
    });

    const result = await reconcileBatchWorkflow({
      config: mockConfig,
      skip: 0,
      limit: 50,
      batchIndex: 0,
    });

    expect(result.usersScanned).toBe(0);
    expect(result.drifts).toEqual([]);
    expect(result.corrections).toEqual([]);
    expect(mockActivities.fetchHubUsersPage).toHaveBeenCalledWith('test-tenant', '0', 50);
  });

  it('scans users and detects drift', async () => {
    const mockUser = {
      _id: 'u1',
      email: 'user@test.com',
      departmentName: 'Engineering',
    };
    mockActivities.fetchHubUsersPage = jest.fn().mockResolvedValue({
      users: [mockUser],
      nextPageToken: null,
      total: 1,
    });
    mockActivities.detectUserDrift = jest.fn().mockResolvedValue({
      userId: 'u1',
      email: 'user@test.com',
      hasDrift: true,
      hubState: mockUser,
      systemStates: new Map(),
      drifts: [
        {
          system: 'entra-id',
          driftType: 'FIELD_MISMATCH',
          field: 'department',
          expectedValue: 'Engineering',
          actualValue: 'Sales',
          description: 'Department mismatch',
          severity: 'LOW' as const,
          autoCorrect: false,
        },
      ],
      severity: 'LOW' as const,
      detectedAt: new Date(),
    });

    const result = await reconcileBatchWorkflow({
      config: mockConfig,
      skip: 0,
      limit: 50,
      batchIndex: 0,
    });

    expect(result.usersScanned).toBe(1);
    expect(result.drifts).toHaveLength(1);
    expect(result.drifts[0].hasDrift).toBe(true);
    expect(mockActivities.detectUserDrift).toHaveBeenCalledWith(
      mockUser,
      ['entra-id'],
      'test-tenant',
    );
  });

  it('continues batch and records errors when detectUserDrift throws for one user', async () => {
    const mockUser1 = { _id: 'u1', email: 'user1@test.com', departmentName: 'Eng' };
    const mockUser2 = { _id: 'u2', email: 'user2@test.com', departmentName: 'Sales' };
    mockActivities.fetchHubUsersPage = jest.fn().mockResolvedValue({
      users: [mockUser1, mockUser2],
      nextPageToken: null,
      total: 2,
    });
    mockActivities.detectUserDrift = jest
      .fn()
      .mockResolvedValueOnce({
        userId: 'u1',
        email: 'user1@test.com',
        hasDrift: false,
        hubState: mockUser1,
        systemStates: new Map(),
        drifts: [],
        severity: 'LOW' as const,
        detectedAt: new Date(),
      })
      .mockRejectedValueOnce(new Error('Drift detection failed'));

    const result = await reconcileBatchWorkflow({
      config: mockConfig,
      skip: 0,
      limit: 50,
      batchIndex: 0,
    });

    expect(result.usersScanned).toBe(1);
    // The result is workflow history and the log line worker output: ids only, no address
    expect(result.errors).toEqual(['identity u2: Drift detection failed']);
    const { log } = jest.requireMock('@temporalio/workflow');
    expect(log.error).toHaveBeenCalledWith('[ReconcileBatch] Failed to detect drift', {
      identityId: 'u2',
      error: 'Drift detection failed',
    });
    expect(JSON.stringify([result.errors, log.error.mock.calls])).not.toContain('@test.com');
  });

  it('names the identity, never the address, when an auto-correction throws', async () => {
    const mockUser = { _id: 'u1', email: 'user@test.com' };
    mockActivities.fetchHubUsersPage = jest.fn().mockResolvedValue({
      users: [mockUser],
      nextPageToken: null,
    });
    mockActivities.detectUserDrift = jest.fn().mockResolvedValue({
      userId: 'u1',
      email: 'user@test.com',
      hasDrift: true,
      hubState: mockUser,
      systemStates: new Map(),
      drifts: [
        {
          system: 'entra-id',
          driftType: 'MISSING_USER',
          description: 'Identity u1 exists in Hub but not in entra-id',
          severity: 'HIGH' as const,
          autoCorrect: true,
        },
      ],
      severity: 'HIGH' as const,
      detectedAt: new Date(),
    });
    mockActivities.correctDrift = jest.fn().mockRejectedValue(new Error('Activity timed out'));

    const result = await reconcileBatchWorkflow({
      config: { ...mockConfig, autoCorrect: true, autoCorrectTypes: [DriftType.MISSING_USER] },
      skip: 0,
      limit: 50,
      batchIndex: 0,
    });

    expect(result.errors).toEqual(['identity u1: Activity timed out']);
    const { log } = jest.requireMock('@temporalio/workflow');
    expect(log.error).toHaveBeenCalledWith('[ReconcileBatch] Auto-correction failed', {
      identityId: 'u1',
      error: 'Activity timed out',
    });
    expect(JSON.stringify([result.errors, log.error.mock.calls])).not.toContain('user@test.com');
  });

  it('reports each target system it could not read once per batch', async () => {
    const users = [
      { _id: 'u1', email: 'user1@test.com' },
      { _id: 'u2', email: 'user2@test.com' },
    ];
    mockActivities.fetchHubUsersPage = jest.fn().mockResolvedValue({
      users,
      nextPageToken: null,
    });
    const adError = 'AD connector config is incomplete (empty: host): set the host ...';
    mockActivities.detectUserDrift = jest.fn().mockImplementation(async (user) => ({
      userId: user._id,
      email: user.email,
      hasDrift: false,
      hubState: user,
      systemStates: new Map(),
      drifts: [],
      systemErrors: [{ system: 'ad', error: adError }],
      severity: 'LOW' as const,
      detectedAt: new Date(),
    }));

    const result = await reconcileBatchWorkflow({
      config: { ...mockConfig, targetSystems: ['entra-id', 'ad'] },
      skip: 0,
      limit: 50,
      batchIndex: 0,
    });

    expect(result.usersScanned).toBe(2);
    expect(result.errors).toEqual([`ad: ${adError}`]);
  });

  it('auto-corrects non-critical drift when autoCorrect is enabled', async () => {
    const autoCorrectConfig: ReconciliationConfig = {
      ...mockConfig,
      autoCorrect: true,
      autoCorrectTypes: [DriftType.FIELD_MISMATCH],
    };
    const mockUser = {
      _id: 'u1',
      email: 'user@test.com',
      departmentName: 'Engineering',
    };
    mockActivities.fetchHubUsersPage = jest.fn().mockResolvedValue({
      users: [mockUser],
      nextPageToken: null,
      total: 1,
    });
    mockActivities.detectUserDrift = jest.fn().mockResolvedValue({
      userId: 'u1',
      email: 'user@test.com',
      hasDrift: true,
      hubState: mockUser,
      systemStates: new Map(),
      drifts: [
        {
          system: 'entra-id',
          driftType: 'FIELD_MISMATCH',
          field: 'department',
          expectedValue: 'Engineering',
          actualValue: 'Sales',
          description: 'Department mismatch',
          severity: 'LOW' as const,
          autoCorrect: true,
        },
      ],
      severity: 'LOW' as const,
      detectedAt: new Date(),
    });
    mockActivities.correctDrift = jest.fn().mockResolvedValue({
      driftId: 'd1',
      corrected: true,
      system: 'entra-id',
    });

    const result = await reconcileBatchWorkflow({
      config: autoCorrectConfig,
      skip: 0,
      limit: 50,
      batchIndex: 0,
    });

    expect(result.usersScanned).toBe(1);
    expect(result.drifts).toHaveLength(1);
    expect(mockActivities.correctDrift).toHaveBeenCalled();
    expect(result.corrections).toHaveLength(1);
  });
});

/**
 * The run's scan scope (input.scope, from the parent behind reconciliation:scan-scope): every
 * page is fetched within the scope the parent counted with. A batch whose history predates
 * reconcile-batch:scan-scope fetched every identity; replay cannot tell (only an activity
 * argument differs), so patched() is stubbed here.
 */
describe('Reconcile Batch Workflow scan scope', () => {
  const { patched } = jest.requireMock('@temporalio/workflow') as { patched: jest.Mock };
  const scope = { includedDepartments: ['Sales'], excludedUsers: ['ceo@example.com'] };
  const page = { users: [], nextPageToken: null };

  afterEach(() => {
    patched.mockImplementation(() => true);
  });

  it('fetches every page within the scope', async () => {
    mockActivities.fetchHubUsersPage = jest.fn().mockResolvedValue(page);

    await reconcileBatchWorkflow({ config: mockConfig, skip: 40, limit: 20, batchIndex: 2, scope });

    expect(patched).toHaveBeenCalledWith('reconcile-batch:scan-scope');
    expect(mockActivities.fetchHubUsersPage).toHaveBeenCalledWith('test-tenant', '40', 20, scope);
  });

  it('fetches without the scope in a batch started before the patch', async () => {
    patched.mockImplementation((id: string) => id !== 'reconcile-batch:scan-scope');
    mockActivities.fetchHubUsersPage = jest.fn().mockResolvedValue(page);

    await reconcileBatchWorkflow({ config: mockConfig, skip: 40, limit: 20, batchIndex: 2, scope });

    expect(mockActivities.fetchHubUsersPage.mock.calls).toEqual([['test-tenant', '40', 20]]);
  });

  it('records no patch for a batch without a scope', async () => {
    mockActivities.fetchHubUsersPage = jest.fn().mockResolvedValue(page);

    await reconcileBatchWorkflow({ config: mockConfig, skip: 0, limit: 20, batchIndex: 0 });

    expect(patched).not.toHaveBeenCalled();
    expect(mockActivities.fetchHubUsersPage.mock.calls).toEqual([['test-tenant', '0', 20]]);
  });
});

/**
 * Leaver containment (patch reconcile-batch:status-containment): a STATUS_MISMATCH whose hub
 * status expects the account disabled is CRITICAL and auto-corrected when the run's
 * autoCorrectTypes include STATUS_MISMATCH; the batch's "never a CRITICAL drift" rule does not
 * hold it back. Enabling (the reverse direction) grants access and stays with a person. A batch
 * whose history predates the patch never corrected a CRITICAL drift; replay cannot show the
 * branch it took when the drift was not auto-correctable, so patched() is stubbed here too.
 */
describe('Reconcile Batch Workflow status containment', () => {
  const { patched } = jest.requireMock('@temporalio/workflow') as { patched: jest.Mock };
  const leaver = { _id: 'identity-2', email: 'grace@example.com', status: 'TERMINATED' };
  const statusDrift = (expectedValue: 'ENABLED' | 'DISABLED') => ({
    system: 'entra-id',
    driftType: DriftType.STATUS_MISMATCH,
    field: 'status',
    expectedValue,
    actualValue: expectedValue === 'DISABLED' ? 'ENABLED' : 'DISABLED',
    description: 'status',
    severity: 'CRITICAL' as const,
    autoCorrect: expectedValue === 'DISABLED',
  });
  const runWith = async (
    drift: ReturnType<typeof statusDrift>,
    types: DriftType[] = [DriftType.STATUS_MISMATCH],
  ) => {
    mockActivities.fetchHubUsersPage = jest
      .fn()
      .mockResolvedValue({ users: [leaver], nextPageToken: null });
    mockActivities.detectUserDrift = jest.fn().mockResolvedValue({
      userId: leaver._id,
      email: leaver.email,
      hasDrift: true,
      hubState: leaver,
      drifts: [drift],
      severity: 'CRITICAL',
      detectedAt: new Date(),
    });
    mockActivities.correctDrift = jest.fn().mockResolvedValue({ success: true });
    return reconcileBatchWorkflow({
      config: { ...mockConfig, autoCorrect: true, autoCorrectTypes: types },
      skip: 0,
      limit: 1,
      batchIndex: 0,
    });
  };

  afterEach(() => {
    patched.mockImplementation(() => true);
  });

  it("disables a leaver's still enabled account although the drift is CRITICAL", async () => {
    const result = await runWith(statusDrift('DISABLED'));

    expect(patched).toHaveBeenCalledWith('reconcile-batch:status-containment');
    expect(mockActivities.correctDrift).toHaveBeenCalledWith(
      expect.objectContaining({ expectedValue: 'DISABLED' }),
      leaver,
      'test-tenant',
    );
    expect(result.corrections).toHaveLength(1);
  });

  it('disables under requireApprovalForDeletes too: containment never waits', async () => {
    expect(mockConfig.requireApprovalForDeletes).toBe(true);
    await runWith(statusDrift('DISABLED'));

    expect(mockActivities.correctDrift).toHaveBeenCalledTimes(1);
  });

  it('leaves an account to enable for a person', async () => {
    await runWith({ ...statusDrift('ENABLED'), autoCorrect: true });

    expect(mockActivities.correctDrift).not.toHaveBeenCalled();
  });

  it('corrects nothing when the run does not auto-correct STATUS_MISMATCH', async () => {
    await runWith(statusDrift('DISABLED'), [DriftType.FIELD_MISMATCH]);

    expect(mockActivities.correctDrift).not.toHaveBeenCalled();
    expect(patched).not.toHaveBeenCalledWith('reconcile-batch:status-containment');
  });

  it('corrects no CRITICAL drift in a batch started before the patch', async () => {
    patched.mockImplementation((id: string) => id !== 'reconcile-batch:status-containment');

    await runWith(statusDrift('DISABLED'));

    expect(mockActivities.correctDrift).not.toHaveBeenCalled();
  });
});
