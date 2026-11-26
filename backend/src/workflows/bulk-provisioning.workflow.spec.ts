/**
 * Bulk Provisioning Workflow Tests
 *
 * Tests validation phase, progress queries, and cancellation.
 *
 * Uses pure Jest mocks (no TestWorkflowEnvironment) for Windows compatibility.
 */

const mockActivities: Record<string, jest.Mock> = {};
const stableRefs: Record<string, (...args: unknown[]) => unknown> = {};
const signalHandlers: Record<symbol, (...args: any[]) => void> = {};
const queryHandlers: Record<symbol, (...args: any[]) => any> = {};

const APPROVE_DELETES_SIGNAL = Symbol('approveDeletes');
const CANCEL_WORKFLOW_SIGNAL = Symbol('cancelWorkflow');
const GET_CURRENT_PHASE_QUERY = Symbol('getCurrentPhase');
const GET_PROGRESS_QUERY = Symbol('getProgress');
const GET_RESULTS_QUERY = Symbol('getResults');

const mockCondition = jest.fn<Promise<boolean>, [() => boolean, number?]>();
const mockPatched = jest.fn<boolean, [string]>();

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
  defineSignal: jest.fn((name: string) => {
    if (name === 'approveDeletes') return APPROVE_DELETES_SIGNAL;
    if (name === 'cancelWorkflow') return CANCEL_WORKFLOW_SIGNAL;
    return Symbol(name);
  }),
  defineQuery: jest.fn((name: string) => {
    if (name === 'getCurrentPhase') return GET_CURRENT_PHASE_QUERY;
    if (name === 'getProgress') return GET_PROGRESS_QUERY;
    if (name === 'getResults') return GET_RESULTS_QUERY;
    return Symbol(name);
  }),
  setHandler: jest.fn((signalOrQuery: symbol, handler: (...args: any[]) => any) => {
    if (signalOrQuery === APPROVE_DELETES_SIGNAL || signalOrQuery === CANCEL_WORKFLOW_SIGNAL) {
      signalHandlers[signalOrQuery] = handler;
    } else {
      queryHandlers[signalOrQuery] = handler;
    }
  }),
  sleep: jest.fn().mockResolvedValue(undefined),
  condition: mockCondition,
  patched: (id: string) => mockPatched(id),
  workflowInfo: () => ({ workflowId: 'bulk-workflow-id', runId: 'run-1' }),
  isCancellation: (err: unknown) => (err as { name?: string })?.name === 'CancelledFailure',
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  ApplicationFailure: class extends Error {
    constructor(
      message: string,
      public readonly type?: string,
    ) {
      super(message);
    }
    static nonRetryable(msg: string, type?: string) {
      return new this(msg, type);
    }
  },
  // Same constructor as @temporalio/common ActivityFailure.
  ActivityFailure: class extends Error {
    constructor(
      message: string,
      _activityType: string,
      _activityId: string | undefined,
      _retryState: unknown,
      _identity: string | undefined,
      public readonly cause?: Error,
    ) {
      super(message);
    }
  },
}));

jest.mock('../infrastructure/config/retry-policies', () => ({
  BATCH_OPERATION_RETRY: { maximumAttempts: 3 },
}));

import { ActivityFailure, ApplicationFailure } from '@temporalio/workflow';
import { RetryState } from '@temporalio/common';
import { bulkProvisioningWorkflow } from './bulk-provisioning.workflow';
import { BulkOperationType, OperationPriority } from './workflow-types';
import { createMockUser } from '../testing/mock-factories';

const mockRequest = {
  batchId: 'batch-1',
  tenantId: 'test-tenant',
  operations: [
    {
      id: 'op-1',
      type: BulkOperationType.CREATE,
      user: createMockUser({ email: 'new@test.com' }),
      targetSystems: ['entra-id'],
      priority: OperationPriority.NORMAL,
    },
  ],
  initiatedBy: 'test@test.com',
};

/**
 * Like BulkProvisioningActivities.compensateOperation for Entra: the systems that succeeded are
 * undone, except a DELETE; the Golden Record write is undone when no system change stays.
 */
const compensateLikeEntra = async (r: {
  type: string;
  systemResults: Array<{ system: string; success: boolean }>;
  hubWrite?: unknown;
}) => {
  const undone = r.type !== 'DELETE';
  const reason = undone ? 'created account disabled' : 'a DELETE is not reversible';
  const systems = r.systemResults
    .filter((sr) => sr.success)
    .map(({ system }) => ({ system, rolledBack: undone, reason }));
  const left = systems.filter((x) => !x.rolledBack);
  const hub = !r.hubWrite
    ? undefined
    : left.length > 0
      ? { rolledBack: false, reason: 'kept, because a target system still has the change' }
      : { rolledBack: true, reason: 'created Golden Record removed' };
  const stays = [
    ...left.map((x) => `${x.system}: ${x.reason}`),
    ...(hub && !hub.rolledBack ? [`hub: ${hub.reason}`] : []),
  ];
  return {
    rolledBack: stays.length === 0,
    reason:
      stays.length === 0
        ? 'Batch failed, compensating transaction'
        : `Not rolled back: ${stays.join('; ')}`,
    systems,
    ...(hub ? { hub } : {}),
  };
};

const systemOk = (system: string, rateLimitHits = 0) => ({
  result: { system, success: true, objectId: `${system}-1`, apiCallsUsed: 1, durationMs: 5 },
  rateLimitHits,
});

/** What the workflow sees when an activity failed every attempt on a target 429. */
const activityFailure = (cause: Error) =>
  new ActivityFailure(
    'Activity task failed',
    'executeSystemOperation',
    '1',
    RetryState.MAXIMUM_ATTEMPTS_REACHED,
    'worker',
    cause,
  );
const rateLimitExhausted = (system: string) =>
  activityFailure(
    new ApplicationFailure(`Rate limited by ${system}; retry after 1000ms`, 'RateLimited'),
  );

describe('Bulk Provisioning Workflow', () => {
  beforeEach(() => {
    Object.keys(mockActivities).forEach((key) => delete mockActivities[key]);
    Object.getOwnPropertySymbols(signalHandlers).forEach((s) => delete signalHandlers[s]);
    Object.getOwnPropertySymbols(queryHandlers).forEach((s) => delete queryHandlers[s]);
    mockCondition.mockReset();
    mockPatched.mockReset().mockReturnValue(true);
    // The Hub write keeps its snapshot by reference; the Golden Record save itself is the
    // saveToHub mock each test sets up (Hub compensation is covered in its own spec).
    mockActivities.saveToHubWithSnapshot = jest.fn(async (user: unknown, tenantId: string) => {
      await mockActivities.saveToHub(user, tenantId);
      return { identityId: 'identity-1', snapshotRef: 'hub-snap-1' };
    });
  });

  it('fails validation when batch is unsafe', async () => {
    mockActivities.validateBatch = jest.fn().mockResolvedValue({
      safe: false,
      errors: [
        {
          operationId: 'op-1',
          field: 'sod',
          message: 'SoD violation',
          severity: 'CRITICAL' as const,
        },
      ],
      warnings: [],
      risk: {
        level: 'CRITICAL' as const,
        reasons: ['SoD'],
        destructiveOps: 0,
        vipUsersAffected: 0,
      },
    });

    const result = await bulkProvisioningWorkflow(mockRequest);

    expect(result.status).toBe('FAILED');
    expect(result.errors).toContain('Validation failed: SoD violation');
    expect(mockActivities.validateBatch).toHaveBeenCalled();
  });

  it('query handlers return correct state after initialization', async () => {
    mockActivities.validateBatch = jest.fn().mockResolvedValue({
      safe: true,
      errors: [],
      warnings: [],
      risk: { level: 'LOW' as const, reasons: [], destructiveOps: 0, vipUsersAffected: 0 },
    });
    mockActivities.partitionOperations = jest.fn().mockResolvedValue({
      creates: mockRequest.operations,
      updates: [],
      deletes: [],
    });
    mockActivities.initializeRateLimit = jest.fn().mockResolvedValue(undefined);
    mockActivities.executeOperation = jest.fn().mockResolvedValue({
      operationId: 'op-1',
      success: true,
      type: BulkOperationType.CREATE,
      userId: 'test-user-id-001',
      email: 'new@test.com',
      systemResults: [],
      startedAt: new Date(),
      completedAt: new Date(),
      durationMs: 100,
    });

    const result = await bulkProvisioningWorkflow({
      ...mockRequest,
      dryRun: true,
      batchDelayMs: 0,
    });

    // After workflow completes, query handlers should be available
    expect(result).toBeDefined();
    const phase = queryHandlers[GET_CURRENT_PHASE_QUERY]?.();
    expect(phase).toBeDefined();
    expect(typeof phase).toBe('string');

    const progress = queryHandlers[GET_PROGRESS_QUERY]?.();
    expect(progress).toBeDefined();
    expect(progress.phase).toBeDefined();
    expect(typeof progress.percentComplete).toBe('number');
  });

  it('completes create batch happy path and provisions users in order', async () => {
    mockActivities.validateBatch = jest.fn().mockResolvedValue({
      safe: true,
      errors: [],
      warnings: [],
      risk: { level: 'LOW' as const, reasons: [], destructiveOps: 0, vipUsersAffected: 0 },
    });
    mockActivities.partitionOperations = jest.fn().mockResolvedValue({
      creates: mockRequest.operations,
      updates: [],
      deletes: [],
    });
    mockActivities.initializeRateLimit = jest.fn().mockResolvedValue(undefined);
    mockActivities.saveToHub = jest.fn().mockResolvedValue('hub-1');
    mockActivities.executeSystemOperation = jest.fn().mockResolvedValue(systemOk('entra-id'));

    const result = await bulkProvisioningWorkflow(mockRequest);

    expect(result.status).toBe('COMPLETED');
    expect(result.summary.successful).toBe(1);
    expect(result.results[0].systemResults).toEqual([systemOk('entra-id').result]);
    expect(mockActivities.saveToHub).toHaveBeenCalledWith(
      mockRequest.operations[0].user,
      'test-tenant',
    );
    expect(mockActivities.executeSystemOperation).toHaveBeenCalledTimes(1);
    expect(mockActivities.executeSystemOperation).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'op-1', type: BulkOperationType.CREATE }),
      'entra-id',
      'test-tenant',
      undefined,
      'run-1/op-1/entra-id',
      // The identity the operation's Hub write saved
      'identity-1',
    );
    expect(mockActivities.executeOperation).toBeUndefined();
  });

  it('reports rate-limit hits summed from the operation results', async () => {
    const secondOp = { ...mockRequest.operations[0], id: 'op-2' };
    mockActivities.validateBatch = jest.fn().mockResolvedValue({
      safe: true,
      errors: [],
      warnings: [],
      risk: { level: 'LOW' as const, reasons: [], destructiveOps: 0, vipUsersAffected: 0 },
    });
    mockActivities.partitionOperations = jest.fn().mockResolvedValue({
      creates: [mockRequest.operations[0], secondOp],
      updates: [],
      deletes: [],
    });
    mockActivities.initializeRateLimit = jest.fn().mockResolvedValue(undefined);
    mockActivities.saveToHub = jest.fn().mockResolvedValue('hub-1');
    mockActivities.executeSystemOperation = jest
      .fn()
      .mockResolvedValueOnce(systemOk('entra-id', 2))
      .mockResolvedValueOnce(systemOk('entra-id', 1));

    const result = await bulkProvisioningWorkflow({
      ...mockRequest,
      operations: [mockRequest.operations[0], secondOp],
      batchDelayMs: 0,
    });

    expect(result.status).toBe('COMPLETED');
    expect(result.metrics.rateLimitHits).toBe(3);
  });

  it('executes deletes after approveDeletes signal received', async () => {
    const deleteOp = {
      id: 'del-1',
      type: BulkOperationType.DELETE,
      user: createMockUser({ email: 'delete@test.com' }),
      targetSystems: ['entra-id'],
      priority: OperationPriority.NORMAL,
    };
    const requestWithDeletes = {
      ...mockRequest,
      operations: [deleteOp],
      requireApprovalForDeletes: true,
      deleteApprovalTimeoutMs: 60000,
    };

    mockActivities.validateBatch = jest.fn().mockResolvedValue({
      safe: true,
      errors: [],
      warnings: [],
      risk: { level: 'LOW' as const, reasons: [], destructiveOps: 0, vipUsersAffected: 0 },
    });
    mockActivities.partitionOperations = jest.fn().mockResolvedValue({
      creates: [],
      updates: [],
      deletes: [deleteOp],
    });
    mockActivities.initializeRateLimit = jest.fn().mockResolvedValue(undefined);
    mockActivities.saveToHub = jest.fn().mockResolvedValue('hub-1');
    mockActivities.executeSystemOperation = jest.fn().mockResolvedValue(systemOk('entra-id'));

    // Simulate approveDeletes signal being sent before condition evaluates
    mockCondition.mockImplementationOnce(async (fn: () => boolean) => {
      signalHandlers[APPROVE_DELETES_SIGNAL]?.();
      return fn();
    });

    const result = await bulkProvisioningWorkflow(requestWithDeletes);

    expect(result.status).toBe('COMPLETED');
    expect(mockActivities.executeSystemOperation).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'del-1', type: BulkOperationType.DELETE }),
      'entra-id',
      'test-tenant',
      undefined,
      'run-1/del-1/entra-id',
      // A DELETE writes no Golden Record (bulk-provisioning:no-hub-write-for-removals)
      undefined,
    );
    expect(mockActivities.saveToHubWithSnapshot).not.toHaveBeenCalled();
  });

  it.each([
    ['CANCELLED', 'a run started now (bulk-provisioning:cancel-compensates)', true],
    ['FAILED', 'a history from before that patch', false],
  ])('ends %s when cancelled at the delete approval gate: %s', async (status, _what, patched) => {
    mockPatched.mockImplementation(
      (id) => patched || id !== 'bulk-provisioning:cancel-compensates',
    );
    const deleteOp = {
      id: 'del-1',
      type: BulkOperationType.DELETE,
      user: createMockUser({ email: 'delete@test.com' }),
      targetSystems: ['entra-id'],
      priority: OperationPriority.NORMAL,
    };
    const requestWithDeletes = {
      ...mockRequest,
      operations: [deleteOp],
      requireApprovalForDeletes: true,
      deleteApprovalTimeoutMs: 60000,
    };

    mockActivities.validateBatch = jest.fn().mockResolvedValue({
      safe: true,
      errors: [],
      warnings: [],
      risk: { level: 'LOW' as const, reasons: [], destructiveOps: 0, vipUsersAffected: 0 },
    });
    mockActivities.partitionOperations = jest.fn().mockResolvedValue({
      creates: [],
      updates: [],
      deletes: [deleteOp],
    });
    mockActivities.initializeRateLimit = jest.fn().mockResolvedValue(undefined);
    mockActivities.saveToHub = jest.fn();
    mockActivities.executeSystemOperation = jest.fn();

    // Simulate cancel signal during condition wait
    mockCondition.mockImplementationOnce(async (fn: () => boolean) => {
      signalHandlers[CANCEL_WORKFLOW_SIGNAL]?.();
      return fn();
    });

    const result = await bulkProvisioningWorkflow(requestWithDeletes);

    // The workflow catches the cancel and returns its results with the status
    expect(result.status).toBe(status);
    expect(result.errors).toBeDefined();
    expect(result.errors?.some((e) => /Workflow cancelled/.test(e))).toBe(true);
    expect(mockActivities.saveToHub).not.toHaveBeenCalled();
    expect(mockActivities.executeSystemOperation).not.toHaveBeenCalled();
  });

  it('handles dry-run mode for creates', async () => {
    mockActivities.validateBatch = jest.fn().mockResolvedValue({
      safe: true,
      errors: [],
      warnings: [],
      risk: { level: 'LOW' as const, reasons: [], destructiveOps: 0, vipUsersAffected: 0 },
    });
    mockActivities.partitionOperations = jest.fn().mockResolvedValue({
      creates: mockRequest.operations,
      updates: [],
      deletes: [],
    });
    mockActivities.initializeRateLimit = jest.fn().mockResolvedValue(undefined);

    const result = await bulkProvisioningWorkflow({ ...mockRequest, dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.status).toBe('COMPLETED');
    // No target system is called in dry-run mode
    expect(mockActivities.executeSystemOperation).toBeUndefined();
    expect(mockActivities.executeOperation).toBeUndefined();
  });

  it('marks a DELETE that the rollback cannot undo as not rolled back', async () => {
    const ops = [
      { ...mockRequest.operations[0], id: 'create-1' },
      { ...mockRequest.operations[0], id: 'delete-1', type: BulkOperationType.DELETE },
      { ...mockRequest.operations[0], id: 'delete-2', type: BulkOperationType.DELETE },
    ];
    mockActivities.validateBatch = jest.fn().mockResolvedValue({
      safe: true,
      errors: [],
      warnings: [],
      risk: { level: 'LOW' as const, reasons: [], destructiveOps: 2, vipUsersAffected: 0 },
    });
    mockActivities.partitionOperations = jest
      .fn()
      .mockResolvedValue({ creates: [ops[0]], updates: [], deletes: [ops[1], ops[2]] });
    mockActivities.initializeRateLimit = jest.fn().mockResolvedValue(undefined);
    mockActivities.saveToHub = jest.fn().mockResolvedValue('hub-1');
    mockActivities.executeSystemOperation = jest.fn(async (op: { id: string }, system: string) =>
      op.id === 'delete-2'
        ? {
            result: { system, success: false, error: 'boom', apiCallsUsed: 1, durationMs: 1 },
            rateLimitHits: 0,
          }
        : systemOk(system),
    );
    mockActivities.compensateOperation = jest.fn(compensateLikeEntra);

    const result = await bulkProvisioningWorkflow({
      ...mockRequest,
      operations: ops,
      batchDelayMs: 0,
      deleteSequentialDelayMs: 0,
    });

    const byId = (id: string) => result.results.find((r) => r.operationId === id);
    expect(byId('create-1')).toMatchObject({ rolledBack: true });
    expect(byId('delete-1')?.rolledBack).toBeUndefined();
    // The deleted account stays deleted; a DELETE wrote no Golden Record to keep or undo.
    expect(byId('delete-1')?.rollbackReason).toBe(
      'Not rolled back: entra-id: a DELETE is not reversible',
    );
    expect(byId('delete-1')?.systemResults[0]).toMatchObject({
      rolledBack: false,
      rollbackReason: 'a DELETE is not reversible',
    });
    expect(byId('delete-1')?.hubWrite).toBeUndefined();
    // delete-2 changed no system and, as a DELETE, wrote no Golden Record: nothing to undo.
    expect(byId('delete-2')?.hubWrite).toBeUndefined();
    expect(byId('delete-2')?.rolledBack).toBeUndefined();
    expect(result.summary.rolledBack).toBe(1);
  });

  describe('fail-fast rollback (continueOnError=false)', () => {
    const op = (id: string, type = BulkOperationType.CREATE) => ({
      ...mockRequest.operations[0],
      id,
      type,
      user: createMockUser({ email: `${id}@test.com` }),
    });
    const failedSystem = (system: string) => ({
      result: { system, success: false, error: 'refused', apiCallsUsed: 1, durationMs: 1 },
      rateLimitHits: 0,
    });
    const setUp = (partitions: Record<string, unknown[]>, failingIds: string[]) => {
      mockActivities.validateBatch = jest.fn().mockResolvedValue({
        safe: true,
        errors: [],
        warnings: [],
        risk: { level: 'LOW' as const, reasons: [], destructiveOps: 0, vipUsersAffected: 0 },
      });
      mockActivities.partitionOperations = jest
        .fn()
        .mockResolvedValue({ creates: [], updates: [], deletes: [], ...partitions });
      mockActivities.initializeRateLimit = jest.fn().mockResolvedValue(undefined);
      mockActivities.saveToHub = jest.fn().mockResolvedValue('hub-1');
      mockActivities.executeSystemOperation = jest.fn(async (o: { id: string }, system: string) =>
        failingIds.includes(o.id) ? failedSystem(system) : systemOk(system),
      );
      mockActivities.compensateOperation = jest.fn(compensateLikeEntra);
    };
    const run = (ops: ReturnType<typeof op>[]) =>
      bulkProvisioningWorkflow({
        ...mockRequest,
        operations: ops,
        batchSize: 1,
        batchDelayMs: 0,
        deleteSequentialDelayMs: 0,
      });

    it('rolls back the creates of an earlier phase when an update batch fails', async () => {
      const create = op('create-1');
      const update = op('update-1', BulkOperationType.UPDATE);
      setUp({ creates: [create], updates: [update] }, ['update-1']);

      const result = await run([create, update]);

      expect(result.status).toBe('FAILED');
      expect(result.results.map((r) => [r.operationId, r.rolledBack])).toEqual([
        ['create-1', true],
        ['update-1', true], // its Golden Record write
      ]);
    });

    it('stops the deletes at the first failed delete and keeps the done delete marked', async () => {
      const deletes = ['del-1', 'del-2', 'del-3'].map((id) => op(id, BulkOperationType.DELETE));
      setUp({ deletes }, ['del-2']);

      const result = await run(deletes);

      expect(result.status).toBe('FAILED');
      expect(result.errors).toEqual([
        'DELETE del-2 failed. Stopping execution before the remaining DELETEs.',
      ]);
      expect(mockActivities.executeSystemOperation).not.toHaveBeenCalledWith(
        expect.objectContaining({ id: 'del-3' }),
        expect.anything(),
        expect.anything(),
      );
      expect(result.results.map((r) => r.operationId)).toEqual(['del-1', 'del-2']);
      expect(result.results[0].rolledBack).toBeUndefined();
      expect(result.results[0].rollbackReason).toBe(
        'Not rolled back: entra-id: a DELETE is not reversible',
      );
      // del-2 deleted nothing and, as a DELETE, wrote no Golden Record: nothing to undo.
      expect(result.summary).toMatchObject({ successful: 1, failed: 1, rolledBack: 0 });
    });

    it('reports a rollback that fails instead of failing the workflow', async () => {
      const ops = [op('op-1'), op('op-2')];
      setUp({ creates: ops }, ['op-2']);
      mockActivities.compensateOperation = jest.fn().mockRejectedValue(new Error('Entra down'));

      const result = await run(ops);

      expect(result.status).toBe('FAILED');
      expect(result.errors).toEqual([
        'Batch execution failed: 1 operations failed. Stopping execution.',
        'Rollback failed: Entra down',
      ]);
      expect(result.results[0].rolledBack).toBeUndefined();
    });

    it('keeps the old exit for histories from before the patch', async () => {
      // As old as that: before the removals stopped writing the Golden Record too
      mockPatched.mockImplementation(
        (id) =>
          id !== 'bulk-provisioning:fail-fast-rollback' &&
          id !== 'bulk-provisioning:no-hub-write-for-removals',
      );
      const ops = [op('op-1'), op('op-2')];
      const deletes = ['del-1', 'del-2'].map((id) => op(id, BulkOperationType.DELETE));

      setUp({ creates: ops }, ['op-2']);
      const createRun = await run(ops);
      setUp({ deletes }, ['del-1']);
      const deleteRun = await run(deletes);

      expect(createRun.status).toBe('FAILED');
      expect(createRun.results).toEqual([]);
      // Old histories ran every delete, then the rollback phase.
      expect(mockActivities.executeSystemOperation).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'del-2' }),
        'entra-id',
        'test-tenant',
        undefined,
        'run-1/del-2/entra-id',
        'identity-1',
      );
      expect(deleteRun.results.map((r) => r.operationId)).toEqual(['del-1', 'del-2']);
    });
  });

  describe('compensation (bulk-provisioning:compensate-operation)', () => {
    const op = (id: string, targetSystems: string[]) => ({
      ...mockRequest.operations[0],
      id,
      targetSystems,
      user: createMockUser({ email: `${id}@test.com` }),
    });
    const setUp = (ops: ReturnType<typeof op>[], failing: Array<[string, string]>) => {
      mockActivities.validateBatch = jest.fn().mockResolvedValue({
        safe: true,
        errors: [],
        warnings: [],
        risk: { level: 'LOW' as const, reasons: [], destructiveOps: 0, vipUsersAffected: 0 },
      });
      mockActivities.partitionOperations = jest
        .fn()
        .mockResolvedValue({ creates: ops, updates: [], deletes: [] });
      mockActivities.initializeRateLimit = jest.fn().mockResolvedValue(undefined);
      mockActivities.saveToHub = jest.fn().mockResolvedValue('hub-1');
      mockActivities.executeSystemOperation = jest.fn(async (o: { id: string }, system: string) =>
        failing.some(([id, sys]) => id === o.id && sys === system)
          ? {
              result: { system, success: false, error: 'refused', apiCallsUsed: 1, durationMs: 1 },
              rateLimitHits: 0,
            }
          : systemOk(system),
      );
    };
    const run = (ops: ReturnType<typeof op>[]) =>
      bulkProvisioningWorkflow({ ...mockRequest, operations: ops, batchSize: 1, batchDelayMs: 0 });

    it('reports per system what the rollback could not undo', async () => {
      const ops = [op('op-1', ['entra-id', 'github']), op('op-2', ['entra-id'])];
      setUp(ops, [['op-2', 'entra-id']]);
      mockActivities.compensateOperation = jest.fn().mockResolvedValue({
        rolledBack: false,
        reason:
          'Not rolled back: github: the github connector cannot deprovision, so a CREATE stays',
        systems: [
          { system: 'entra-id', rolledBack: true, reason: 'created account disabled' },
          {
            system: 'github',
            rolledBack: false,
            reason: 'the github connector cannot deprovision, so a CREATE stays',
          },
        ],
      });

      const result = await run(ops);

      expect(mockPatched).toHaveBeenCalledWith('bulk-provisioning:compensate-operation');
      expect(result.results[0].rolledBack).toBeUndefined();
      expect(result.results[0].rollbackReason).toBe(
        'Not rolled back: github: the github connector cannot deprovision, so a CREATE stays',
      );
      expect(result.results[0].systemResults).toEqual([
        expect.objectContaining({ system: 'entra-id', rolledBack: true }),
        expect.objectContaining({ system: 'github', rolledBack: false }),
      ]);
      expect(result.summary).toMatchObject({ successful: 1, failed: 1, rolledBack: 0 });
    });

    it('compensates the systems that succeeded in a partly failed operation', async () => {
      const ops = [op('op-1', ['entra-id', 'github'])];
      setUp(ops, [['op-1', 'github']]);
      mockActivities.compensateOperation = jest.fn(compensateLikeEntra);

      const result = await run(ops);

      expect(result.status).toBe('FAILED');
      expect(mockActivities.compensateOperation).toHaveBeenCalledWith(
        expect.objectContaining({ operationId: 'op-1', success: false }),
        'test-tenant',
      );
    });

    it('calls rollbackOperation for fully successful operations in older histories', async () => {
      mockPatched.mockImplementation((id) => id !== 'bulk-provisioning:compensate-operation');
      const ops = [op('op-1', ['entra-id']), op('op-2', ['entra-id', 'github'])];
      setUp(ops, [['op-2', 'github']]);
      mockActivities.rollbackOperation = jest.fn().mockResolvedValue(true);

      const result = await run(ops);

      expect(mockActivities.rollbackOperation).toHaveBeenCalledTimes(1);
      expect(mockActivities.rollbackOperation).toHaveBeenCalledWith(
        expect.objectContaining({ operationId: 'op-1' }),
        'test-tenant',
      );
      expect(mockActivities.compensateOperation).toBeUndefined();
      expect(result.results[0]).toMatchObject({
        rolledBack: true,
        rollbackReason: 'Batch failed, compensating transaction',
      });
    });
  });

  describe('DISABLE operations (bulk-provisioning:run-disables)', () => {
    const op = (id: string, type: BulkOperationType) => ({
      ...mockRequest.operations[0],
      id,
      type,
      user: createMockUser({ email: `${id}@test.com` }),
    });
    const ops = [
      op('create-1', BulkOperationType.CREATE),
      op('update-1', BulkOperationType.UPDATE),
      op('disable-1', BulkOperationType.DISABLE),
      op('delete-1', BulkOperationType.DELETE),
    ];

    beforeEach(() => {
      mockActivities.validateBatch = jest.fn().mockResolvedValue({
        safe: true,
        errors: [],
        warnings: [],
        risk: { level: 'LOW' as const, reasons: [], destructiveOps: 2, vipUsersAffected: 0 },
      });
      mockActivities.partitionOperations = jest.fn().mockResolvedValue({
        creates: [ops[0]],
        updates: [ops[1]],
        disables: [ops[2]],
        deletes: [ops[3]],
      });
      mockActivities.initializeRateLimit = jest.fn().mockResolvedValue(undefined);
      mockActivities.saveToHub = jest.fn().mockResolvedValue('hub-1');
      mockActivities.executeSystemOperation = jest.fn(async (_op: unknown, system: string) =>
        systemOk(system),
      );
    });

    const run = () =>
      bulkProvisioningWorkflow({
        ...mockRequest,
        operations: ops,
        batchDelayMs: 0,
        deleteSequentialDelayMs: 0,
      });

    it('runs disables after the updates and before the deletes', async () => {
      const result = await run();

      expect(mockPatched).toHaveBeenCalledWith('bulk-provisioning:run-disables');
      expect(
        mockActivities.executeSystemOperation.mock.calls.map(([o]) => (o as { id: string }).id),
      ).toEqual(['create-1', 'update-1', 'disable-1', 'delete-1']);
      expect(result.status).toBe('COMPLETED');
      expect(result.summary).toMatchObject({ total: 4, successful: 4 });
      expect(result.breakdown.disables).toEqual({ total: 1, successful: 1, failed: 0 });
    });

    it('skips disables in histories from before the patch', async () => {
      mockPatched.mockImplementation((id) => id !== 'bulk-provisioning:run-disables');

      const result = await run();

      expect(
        mockActivities.executeSystemOperation.mock.calls.map(([o]) => (o as { id: string }).id),
      ).toEqual(['create-1', 'update-1', 'delete-1']);
      expect(result.breakdown.disables).toEqual({ total: 1, successful: 0, failed: 0 });
    });
  });

  describe('per-system activities', () => {
    const ops = ['op-1', 'op-2'].map((id) => ({
      ...mockRequest.operations[0],
      id,
      user: createMockUser({ email: `${id}@test.com` }),
      targetSystems: ['file-outbound', 'github'],
    }));

    beforeEach(() => {
      mockActivities.validateBatch = jest.fn().mockResolvedValue({
        safe: true,
        errors: [],
        warnings: [],
        risk: { level: 'LOW' as const, reasons: [], destructiveOps: 0, vipUsersAffected: 0 },
      });
      mockActivities.partitionOperations = jest
        .fn()
        .mockResolvedValue({ creates: ops, updates: [], deletes: [] });
      mockActivities.initializeRateLimit = jest.fn().mockResolvedValue(undefined);
      mockActivities.saveToHub = jest.fn().mockResolvedValue('hub-1');
      // op-1 runs out of 429 retries on github; everything else succeeds.
      mockActivities.executeSystemOperation = jest.fn(
        async (op: { id: string }, system: string) => {
          if (op.id === 'op-1' && system === 'github') throw rateLimitExhausted(system);
          return systemOk(system);
        },
      );
    });

    it('records any failed system activity as a failed system and goes on with continueOnError', async () => {
      mockActivities.executeSystemOperation = jest.fn(
        async (op: { id: string }, system: string) => {
          if (op.id === 'op-1' && system === 'github') {
            throw activityFailure(new ApplicationFailure('boom', 'Error'));
          }
          return systemOk(system);
        },
      );

      const result = await bulkProvisioningWorkflow({
        ...mockRequest,
        operations: ops,
        batchDelayMs: 0,
        continueOnError: true,
      });

      expect(mockPatched).toHaveBeenCalledWith('bulk-provisioning:failures-as-results');
      expect(result.errors).toBeUndefined();
      expect(result.status).toBe('PARTIAL_SUCCESS');
      expect(result.results.find((r) => r.operationId === 'op-1')?.systemResults).toEqual([
        expect.objectContaining({ system: 'file-outbound', success: true }),
        expect.objectContaining({ system: 'github', success: false, error: 'boom' }),
      ]);
    });

    it('still ends the run on a cancelled activity', async () => {
      const cancelled = Object.assign(new Error('cancelled'), { name: 'CancelledFailure' });
      mockActivities.saveToHub = jest.fn().mockRejectedValue(cancelled);

      const result = await bulkProvisioningWorkflow({
        ...mockRequest,
        operations: ops,
        batchDelayMs: 0,
        continueOnError: true,
      });

      expect(result.status).toBe('FAILED');
      expect(result.errors).toEqual(['cancelled']);
    });

    it('fails the run on other activity failures in histories from before the patch', async () => {
      mockPatched.mockImplementation((id) => id !== 'bulk-provisioning:failures-as-results');
      mockActivities.executeSystemOperation = jest
        .fn()
        .mockRejectedValue(activityFailure(new ApplicationFailure('boom', 'Error')));

      const result = await bulkProvisioningWorkflow({
        ...mockRequest,
        operations: ops,
        batchDelayMs: 0,
        continueOnError: true,
      });

      expect(result.status).toBe('FAILED');
      expect(result.errors).toEqual(['Activity task failed']);
    });

    it('replays the single executeOperation activity for histories from before the patch', async () => {
      mockPatched.mockReturnValue(false);
      mockActivities.executeOperation = jest.fn(async (op: { id: string }) => ({
        operationId: op.id,
        success: true,
        type: BulkOperationType.CREATE,
        userId: op.id,
        email: `${op.id}@test.com`,
        systemResults: [],
        startedAt: new Date(),
        completedAt: new Date(),
        durationMs: 1,
      }));

      const result = await bulkProvisioningWorkflow({
        ...mockRequest,
        operations: ops,
        batchDelayMs: 0,
      });

      expect(result.status).toBe('COMPLETED');
      expect(mockPatched).toHaveBeenCalledWith('bulk-provisioning:per-system-activities');
      expect(mockActivities.executeOperation).toHaveBeenCalledTimes(2);
      expect(mockActivities.saveToHub).not.toHaveBeenCalled();
      expect(mockActivities.executeSystemOperation).not.toHaveBeenCalled();
    });
  });
});
