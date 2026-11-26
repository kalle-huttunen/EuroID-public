/**
 * End-to-end test for bulkProvisioningWorkflow on the time-skipping Temporal test server,
 * with the real BulkProvisioningActivities (target connectors mocked) behind the worker's
 * RateLimitActivityInterceptor. Opt-in via TEMPORAL_E2E=1.
 *
 * Proves:
 *   - Operation results survive Temporal's JSON payload converter: systemResults used to be a
 *     Map, which arrives in the workflow as {} and made the summary step throw.
 *   - A target 429 is retried by Temporal for that target system only: a system that already
 *     succeeded is not provisioned a second time.
 *   - When a system runs out of 429 retries, continueOnError decides whether the batch goes on.
 *   - Without continueOnError, a failed batch rolls back the earlier batches' successes and the
 *     FAILED result carries the failed batch's results.
 *   - The rollback undoes what it can (an Entra account it created is disabled) and reports the
 *     rest as not rolled back, per system, with the reason.
 *   - DISABLE operations run, and a disable is rolled back by enabling the account again.
 *   - A failed Golden Record save fails only its operation: continueOnError goes on, fail-fast
 *     rolls back the operations that succeeded before it.
 *   - The rollback also undoes the Golden Record writes (a failed operation's too), and keeps
 *     them while a target system still has the change.
 */
import * as path from 'path';
import { bulkProvisioningWorkflow } from '../../src/workflows/bulk-provisioning.workflow';
import {
  BulkOperationType,
  OperationPriority,
  type BulkOperationRequest,
} from '../../src/workflows/workflow-types';
import { BulkProvisioningActivities } from '../../src/activities/bulk-provisioning.activities';
import { RateLimitActivityInterceptor } from '../../src/infrastructure/temporal/rate-limit-activity.interceptor';
import { RateLimitedException } from '../../src/shared/errors/rate-limited.exception';
import { MemoryHub, MemorySnapshots } from '../helpers/bulk-rollback-fakes';
import {
  createWorkflowTestHarness,
  describeTemporalE2E,
  type WorkflowTestHarness,
} from '../helpers/workflow-test-env';

type Deps = ConstructorParameters<typeof BulkProvisioningActivities>;

describeTemporalE2E('bulkProvisioningWorkflow (e2e)', () => {
  let harness: WorkflowTestHarness;
  const saveToHub = jest.fn();
  const fileCreate = jest.fn();
  const githubCreate = jest.fn();
  const provisionUserToEntra = jest.fn();
  const disableEntraUser = jest.fn();
  const enableEntraUser = jest.fn();
  const captureUserState = jest.fn();
  const disableUser = jest.fn();
  /** The operation results the workflow hands to compensateOperation (the real activity runs). */
  const compensated = jest.fn();

  // Golden Records in memory; the write itself is the saveToHub mock (Hub outages).
  const hub = new MemoryHub((user) => saveToHub(user));

  beforeAll(async () => {
    const bulk = new BulkProvisioningActivities(
      { provisionUserToEntra, disableEntraUser, enableEntraUser } as unknown as Deps[0],
      { saveToHub } as unknown as Deps[1],
      {
        checkAndWait: jest.fn().mockResolvedValue(0),
        recordApiCalls: jest.fn().mockResolvedValue(undefined),
      } as unknown as Deps[2],
      {} as Deps[3],
      { create: fileCreate } as unknown as Deps[4],
      {} as Deps[5],
      { create: githubCreate } as unknown as Deps[6],
      {} as Deps[7],
      {
        captureUserState,
        disableUser,
        // A DISABLE reads the account's state before it (enabled here)
        checkUserExists: async (email: string) => `entra-${email}`,
        getCredentialState: async () => ({ accountEnabled: true }),
      } as unknown as Deps[8],
      new MemorySnapshots() as unknown as Deps[9],
      hub as unknown as Deps[10],
    );

    harness = await createWorkflowTestHarness({
      workflowsPath: path.resolve(__dirname, '../../src/workflows/bulk-provisioning.workflow.ts'),
      activityInterceptors: [() => ({ inbound: new RateLimitActivityInterceptor() })],
      activities: {
        validateBatch: async () => ({
          safe: true,
          errors: [],
          warnings: [],
          risk: { level: 'LOW', reasons: [], destructiveOps: 0, vipUsersAffected: 0 },
        }),
        initializeRateLimit: async () => undefined,
        saveToHubWithSnapshot: (...args: unknown[]) =>
          bulk.saveToHubWithSnapshot(...(args as Parameters<typeof bulk.saveToHubWithSnapshot>)),
        partitionOperations: (...args: unknown[]) =>
          bulk.partitionOperations(...(args as Parameters<typeof bulk.partitionOperations>)),
        executeSystemOperation: (...args: unknown[]) =>
          bulk.executeSystemOperation(...(args as Parameters<typeof bulk.executeSystemOperation>)),
        compensateOperation: (...args: unknown[]) => {
          compensated(...args);
          return bulk.compensateOperation(...(args as Parameters<typeof bulk.compensateOperation>));
        },
      },
    });
  }, 120_000);

  afterAll(async () => {
    await harness?.shutdown();
  }, 30_000);

  beforeEach(() => {
    hub.records.clear();
    saveToHub.mockReset().mockResolvedValue('hub-1');
    fileCreate.mockReset().mockResolvedValue({ targetUserId: 'file-1' });
    githubCreate.mockReset().mockResolvedValue({ targetUserId: 'gh-1' });
    provisionUserToEntra.mockReset();
    disableEntraUser.mockReset().mockResolvedValue(true);
    enableEntraUser.mockReset().mockResolvedValue(true);
    captureUserState.mockReset().mockResolvedValue({ existed: false });
    disableUser.mockReset().mockResolvedValue(true);
    compensated.mockReset();
  });

  const request = (
    names: string[],
    overrides: Partial<BulkOperationRequest> = {},
    targetSystems = ['file-outbound', 'github'],
  ): BulkOperationRequest => ({
    batchId: 'batch-e2e',
    tenantId: 'tenant-a',
    initiatedBy: 'e2e',
    operations: names.map((name, i) => ({
      id: `op-${i}`,
      type: BulkOperationType.CREATE,
      priority: OperationPriority.NORMAL,
      targetSystems,
      user: { email: `${name}@example.com`, firstName: name, lastName: 'Test' },
    })) as BulkOperationRequest['operations'],
    ...overrides,
  });

  const run = (req: BulkOperationRequest, id: string) =>
    harness.env.client.workflow.execute(bulkProvisioningWorkflow, {
      args: [req],
      taskQueue: harness.taskQueue,
      workflowId: `bulk-e2e-${id}-${Date.now()}`,
    });

  const emails = (mock: jest.Mock) =>
    mock.mock.calls.map(([user]) => (user as { email: string }).email);

  it('summarises the per-system results of real operations', async () => {
    const result = await run(request(['ada', 'grace']), 'summary');

    expect(result.errors).toBeUndefined();
    expect(result.status).toBe('COMPLETED');
    expect(result.summary).toMatchObject({ total: 2, successful: 2, failed: 0, skipped: 0 });
    expect(result.metrics.apiCallsTotal).toBe(4);
    expect(result.results[0].systemResults).toEqual([
      expect.objectContaining({ system: 'file-outbound', success: true, objectId: 'file-1' }),
      expect.objectContaining({ system: 'github', success: true, objectId: 'gh-1' }),
    ]);
    expect(saveToHub).toHaveBeenCalledTimes(2);
  }, 60_000);

  it('retries only the rate-limited system, not the one that already succeeded', async () => {
    githubCreate
      .mockRejectedValueOnce(new RateLimitedException(1000, 'github'))
      .mockRejectedValueOnce(new RateLimitedException(1000, 'github'));

    const result = await run(request(['ada']), 'retry-one-system');

    expect(result.errors).toBeUndefined();
    expect(result.status).toBe('COMPLETED');
    expect(result.results[0].systemResults).toEqual([
      expect.objectContaining({ system: 'file-outbound', success: true, objectId: 'file-1' }),
      expect.objectContaining({ system: 'github', success: true, objectId: 'gh-1' }),
    ]);
    expect(githubCreate).toHaveBeenCalledTimes(3);
    expect(fileCreate).toHaveBeenCalledTimes(1);
    expect(saveToHub).toHaveBeenCalledTimes(1);
  }, 60_000);

  describe('when a system runs out of 429 retries', () => {
    beforeEach(() => {
      githubCreate.mockImplementation(async (user: { email: string }) => {
        if (user.email === 'ada@example.com') throw new RateLimitedException(1000, 'github');
        return { targetUserId: 'gh-1' };
      });
    });

    it('records the operation as failed and finishes the batch with continueOnError', async () => {
      const result = await run(
        request(['ada', 'grace'], { batchSize: 1, continueOnError: true }),
        'exhausted-continue',
      );

      expect(result.errors).toBeUndefined();
      expect(result.status).toBe('PARTIAL_SUCCESS');
      expect(result.summary).toMatchObject({ total: 2, successful: 1, failed: 1 });
      expect(result.results.map((r) => [r.operationId, r.success])).toEqual([
        ['op-0', false],
        ['op-1', true],
      ]);
      expect(result.results[0].systemResults).toEqual([
        expect.objectContaining({ system: 'file-outbound', success: true }),
        expect.objectContaining({
          system: 'github',
          success: false,
          error: 'Rate limit retries exhausted: Rate limited by github; retry after 1000ms',
        }),
      ]);
      // BATCH_OPERATION_RETRY allows 3 attempts for ada; grace's batch still ran.
      expect(emails(githubCreate)).toEqual([
        'ada@example.com',
        'ada@example.com',
        'ada@example.com',
        'grace@example.com',
      ]);
      expect(emails(fileCreate)).toEqual(['ada@example.com', 'grace@example.com']);
    }, 60_000);

    it('stops the batch without continueOnError', async () => {
      const result = await run(request(['ada', 'grace'], { batchSize: 1 }), 'exhausted-stop');

      expect(result.status).toBe('FAILED');
      expect(result.errors).toEqual([
        'Batch execution failed: 1 operations failed. Stopping execution.',
      ]);
      expect(emails(githubCreate)).toEqual([
        'ada@example.com',
        'ada@example.com',
        'ada@example.com',
      ]);
      expect(emails(fileCreate)).toEqual(['ada@example.com']);
    }, 60_000);
  });

  it('rolls back batch 1 and reports batch 2 when batch 2 fails fast', async () => {
    provisionUserToEntra.mockImplementation(async (user: { email: string }) => {
      if (user.email === 'grace@example.com') throw new Error('Entra refused grace');
      return { success: true, objectId: 'entra-ada' };
    });
    // grace's create failed before Entra had an account for her: the lookup finds none
    disableEntraUser.mockResolvedValue(false);

    const result = await run(
      request(['ada', 'grace'], { batchSize: 1 }, ['entra-id']),
      'fail-fast-rollback',
    );

    expect(result.status).toBe('FAILED');
    expect(result.errors).toEqual([
      'Batch execution failed: 1 operations failed. Stopping execution.',
    ]);
    // Batch 1 (ada) succeeded and was compensated; batch 2 (grace) is in the result.
    expect(result.results).toEqual([
      expect.objectContaining({ operationId: 'op-0', success: true, rolledBack: true }),
      expect.objectContaining({
        operationId: 'op-1',
        success: false,
        systemResults: [
          expect.objectContaining({
            system: 'entra-id',
            success: false,
            error: 'Entra refused grace',
          }),
        ],
      }),
    ]);
    // grace changed no system, but her Golden Record write is undone with the batch.
    expect(result.summary).toMatchObject({ total: 2, successful: 0, failed: 1, rolledBack: 2 });
    expect(result.breakdown.creates).toEqual({ total: 2, successful: 1, failed: 1 });
    expect(result.results[1]).toMatchObject({
      rolledBack: true,
      hubWrite: { rolledBack: true, rollbackReason: 'created Golden Record removed' },
    });
    // Both operations are compensated, grace's by the reference to her Golden Record snapshot
    expect(compensated).toHaveBeenCalledTimes(2);
    expect(compensated).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: 'op-0' }),
      'tenant-a',
    );
    expect(compensated).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: 'op-1',
        hubWrite: expect.objectContaining({
          identityId: 'identity-grace@example.com',
          snapshotRef: expect.stringMatching(/^snap-\d+$/),
        }),
      }),
      'tenant-a',
    );
    // ada's account did not exist before the CREATE, so the rollback disables the new account.
    expect(result.results[0].systemResults[0]).toMatchObject({
      previousState: { existed: false },
      rolledBack: true,
      rollbackReason: 'created account disabled',
    });
    expect(disableUser).toHaveBeenCalledTimes(1);
    expect(disableUser).toHaveBeenCalledWith('entra-ada');
    // grace's create failed after its snapshot: an account it may have made is looked up by
    // email (hunt 2026-11-25 02 F9), and none was
    expect(disableEntraUser.mock.calls).toEqual([['grace@example.com', 'tenant-a', undefined]]);
    expect(result.results[1].systemResults[0]).toMatchObject({
      rolledBack: true,
      rollbackReason: 'no account was created',
    });
  }, 60_000);

  it('reports creates on connectors that cannot deprovision as not rolled back', async () => {
    githubCreate.mockImplementation(async (user: { email: string }) => {
      if (user.email === 'grace@example.com') throw new Error('GitHub refused grace');
      return { targetUserId: 'gh-1' };
    });

    const result = await run(request(['ada', 'grace'], { batchSize: 1 }), 'not-reversible');

    expect(result.status).toBe('FAILED');
    const reason = (system: string) =>
      `the ${system} connector cannot deprovision, so a CREATE stays`;
    // The accounts stay, so the Golden Records that describe them are kept too.
    const hubKept = 'hub: kept, because a target system still has the change';
    // ada: both systems succeeded; grace: file-outbound succeeded, github failed.
    expect(result.results.map((r) => [r.operationId, r.rolledBack, r.rollbackReason])).toEqual([
      [
        'op-0',
        undefined,
        `Not rolled back: file-outbound: ${reason('file-outbound')}; github: ${reason('github')}; ${hubKept}`,
      ],
      ['op-1', undefined, `Not rolled back: file-outbound: ${reason('file-outbound')}; ${hubKept}`],
    ]);
    expect(result.results[1].systemResults).toEqual([
      expect.objectContaining({ system: 'file-outbound', success: true, rolledBack: false }),
      expect.objectContaining({ system: 'github', success: false, error: 'GitHub refused grace' }),
    ]);
    expect(result.summary).toMatchObject({ rolledBack: 0 });
  }, 60_000);

  it('runs DISABLE operations and enables the account again when a later disable fails', async () => {
    disableEntraUser.mockImplementation(async (email: string) => email === 'ada@example.com');
    const req = request(['ada', 'grace'], { batchSize: 1 }, ['entra-id']);
    req.operations.forEach((op) => (op.type = BulkOperationType.DISABLE));

    const result = await run(req, 'disables');

    expect(disableEntraUser.mock.calls).toEqual([
      ['ada@example.com', 'tenant-a', undefined],
      ['grace@example.com', 'tenant-a', undefined],
    ]);
    expect(result.status).toBe('FAILED');
    expect(result.breakdown.disables).toEqual({ total: 2, successful: 1, failed: 1 });
    expect(result.results[0]).toMatchObject({ operationId: 'op-0', rolledBack: true });
    expect(enableEntraUser).toHaveBeenCalledTimes(1);
    expect(enableEntraUser).toHaveBeenCalledWith('ada@example.com', 'tenant-a', undefined);
  }, 60_000);

  describe('when the Golden Record save fails for one operation', () => {
    beforeEach(() => {
      saveToHub.mockImplementation(async (user: { email: string }) => {
        if (user.email === 'grace@example.com') throw new Error('Hub down');
        return 'hub-1';
      });
      provisionUserToEntra.mockImplementation(async (user: { email: string }) => ({
        success: true,
        objectId: `entra-${user.email.split('@')[0]}`,
      }));
    });

    it('rolls back the earlier operation without continueOnError', async () => {
      const result = await run(
        request(['ada', 'grace'], { batchSize: 1 }, ['entra-id']),
        'hub-fail-fast',
      );

      expect(result.status).toBe('FAILED');
      expect(result.errors).toEqual([
        'Batch execution failed: 1 operations failed. Stopping execution.',
      ]);
      expect(result.results).toEqual([
        expect.objectContaining({ operationId: 'op-0', success: true, rolledBack: true }),
        expect.objectContaining({
          operationId: 'op-1',
          success: false,
          error: 'Golden Record save failed: Hub down',
          systemResults: [],
        }),
      ]);
      expect(emails(provisionUserToEntra)).toEqual(['ada@example.com']);
      expect(disableUser).toHaveBeenCalledWith('entra-ada');
    }, 60_000);

    it('records the failed operation and goes on with continueOnError', async () => {
      const result = await run(
        request(['grace', 'ada'], { batchSize: 1, continueOnError: true }, ['entra-id']),
        'hub-continue',
      );

      expect(result.errors).toBeUndefined();
      expect(result.status).toBe('PARTIAL_SUCCESS');
      expect(result.results.map((r) => [r.email, r.success])).toEqual([
        ['grace@example.com', false],
        ['ada@example.com', true],
      ]);
      expect(disableUser).not.toHaveBeenCalled();
    }, 60_000);
  });
});
