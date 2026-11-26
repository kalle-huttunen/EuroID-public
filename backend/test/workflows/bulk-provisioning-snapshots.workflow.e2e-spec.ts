/**
 * End-to-end test for the rollback snapshots of bulkProvisioningWorkflow on the time-skipping
 * Temporal test server, with the real BulkProvisioningActivities (Entra mocked, snapshot store
 * in memory). Opt-in via TEMPORAL_E2E=1.
 *
 * Proves:
 *   - The attribute values an Entra UPDATE overwrites and the Golden Record a Hub write
 *     overwrites (personal data) never appear in the workflow history or the result: they go to
 *     the snapshot store and only the reference travels through Temporal.
 *   - The rollback restores both, and removes a Golden Record the batch created, also for an
 *     operation that failed on its target system.
 *   - A retried Entra activity keeps the snapshot of its first attempt (keyed per run, operation
 *     and system), so the rollback restores the values from before the batch, not the ones the
 *     first attempt wrote.
 *   - Histories recorded before the Hub compensation patch (saveToHub) and before the Entra
 *     snapshot key patch still replay.
 *   - A DISABLE or DELETE writes no Golden Record from the request body (hunt 2026-11-25 02 F7,
 *     patch `bulk-provisioning:no-hub-write-for-removals`); a history recorded before still
 *     replays.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Worker } from '@temporalio/worker';
import { bulkProvisioningWorkflow } from '../../src/workflows/bulk-provisioning.workflow';
import {
  BulkOperationType,
  OperationPriority,
  type BulkOperationRequest,
} from '../../src/workflows/workflow-types';
import { BulkProvisioningActivities } from '../../src/activities/bulk-provisioning.activities';
import { RateLimitedException } from '../../src/shared/errors/rate-limited.exception';
import { MemoryHub, MemorySnapshots } from '../helpers/bulk-rollback-fakes';
import { historyText } from '../helpers/history-text';
import { historyJSON } from '../helpers/history-json';
import {
  createWorkflowTestHarness,
  describeTemporalE2E,
  type WorkflowTestHarness,
} from '../helpers/workflow-test-env';

type Deps = ConstructorParameters<typeof BulkProvisioningActivities>;

const WORKFLOWS_PATH = path.resolve(__dirname, '../../src/workflows/bulk-provisioning.workflow.ts');
const PRE_HUB_COMPENSATION_HISTORY = path.resolve(
  __dirname,
  '../fixtures/bulk-provisioning-pre-hub-compensation.history.json',
);
/** Recorded before `bulk-provisioning:no-hub-write-for-removals`: a DISABLE saved to the Hub. */
const PRE_NO_HUB_WRITE_FOR_REMOVALS_HISTORY = path.resolve(
  __dirname,
  '../fixtures/bulk-provisioning-pre-no-hub-write-for-removals.history.json',
);
/** Recorded before `bulk-provisioning:entra-snapshot-key`: executeSystemOperation without a key. */
const PRE_ENTRA_SNAPSHOT_KEY_HISTORY = path.resolve(
  __dirname,
  '../fixtures/bulk-provisioning-pre-entra-snapshot-key.history.json',
);

describeTemporalE2E('bulkProvisioningWorkflow rollback snapshots (e2e)', () => {
  let harness: WorkflowTestHarness;
  let snapshots: MemorySnapshots;
  let hub: MemoryHub;
  const saveToHub = jest.fn();
  const provisionUserToEntra = jest.fn();
  const captureUserState = jest.fn();
  const restoreUserState = jest.fn();
  const disableEntraUser = jest.fn();
  const deleteUser = jest.fn();
  let activities: ReturnType<typeof activitiesOf>;

  /** Values in Entra before the UPDATE: they must reach the rollback, not the history. */
  const before = { mobilePhone: '+358 40 765 4321', jobTitle: 'Night Porter' };

  /** ada's Golden Record before the batch: it must reach the rollback, not the history. */
  const hubBefore = { jobTitle: 'Night Auditor', mobilePhone: '+358 40 111 2222' };

  beforeAll(async () => {
    snapshots = new MemorySnapshots();
    hub = new MemoryHub((user) => saveToHub(user));
    const bulk = new BulkProvisioningActivities(
      { provisionUserToEntra, disableEntraUser, deleteUser } as unknown as Deps[0],
      {} as Deps[1],
      {
        checkAndWait: jest.fn().mockResolvedValue(0),
        recordApiCalls: jest.fn().mockResolvedValue(undefined),
      } as unknown as Deps[2],
      {} as Deps[3],
      {} as Deps[4],
      {} as Deps[5],
      {} as Deps[6],
      {} as Deps[7],
      {
        captureUserState,
        restoreUserState,
        checkUserExists: async (email: string) => `entra-${email}`,
        getCredentialState: async () => ({ accountEnabled: true }),
      } as unknown as Deps[8],
      snapshots as unknown as Deps[9],
      hub as unknown as Deps[10],
    );
    const bind =
      <K extends keyof BulkProvisioningActivities>(name: K) =>
      (...args: unknown[]) =>
        (bulk[name] as (...a: unknown[]) => unknown)(...args);

    activities = activitiesOf(bind);
    harness = await createWorkflowTestHarness({ workflowsPath: WORKFLOWS_PATH, activities });
  }, 120_000);

  /** The worker's activities: the real bulk ones, the batch checks stubbed. */
  function activitiesOf(
    bind: <K extends keyof BulkProvisioningActivities>(name: K) => (...args: unknown[]) => unknown,
  ) {
    return {
      validateBatch: async () => ({
        safe: true,
        errors: [],
        warnings: [],
        risk: { level: 'LOW', reasons: [], destructiveOps: 0, vipUsersAffected: 0 },
      }),
      initializeRateLimit: async () => undefined,
      saveToHubWithSnapshot: bind('saveToHubWithSnapshot'),
      partitionOperations: bind('partitionOperations'),
      executeSystemOperation: bind('executeSystemOperation'),
      compensateOperation: bind('compensateOperation'),
    };
  }

  afterAll(async () => {
    await harness?.shutdown();
  }, 30_000);

  beforeEach(() => {
    disableEntraUser.mockReset().mockResolvedValue(true);
    deleteUser.mockReset().mockResolvedValue({ success: true });
    saveToHub.mockReset().mockResolvedValue('hub-1');
    provisionUserToEntra.mockReset();
    captureUserState.mockReset();
    restoreUserState.mockReset().mockResolvedValue(undefined);
    hub.records.clear();
    hub.restoreHubState.mockClear();
    hub.removeIdentity.mockClear();
  });

  const request = (names: string[]): BulkOperationRequest => ({
    batchId: 'batch-snapshots',
    tenantId: 'tenant-a',
    initiatedBy: 'e2e',
    batchSize: 1,
    operations: names.map((name, i) => ({
      id: `op-${i}`,
      type: BulkOperationType.UPDATE,
      priority: OperationPriority.NORMAL,
      targetSystems: ['entra-id'],
      user: { email: `${name}@example.com`, firstName: name, lastName: 'Test', jobTitle: 'Clerk' },
    })) as BulkOperationRequest['operations'],
  });

  it('keeps the overwritten Entra and Hub values out of the history and still restores them', async () => {
    const adaBefore = hub.seed('ada@example.com', hubBefore);
    captureUserState.mockImplementation(async (user: { email: string }) => ({
      existed: true,
      objectId: `entra-${user.email.split('@')[0]}`,
      attributes: before,
    }));
    provisionUserToEntra.mockImplementation(async (user: { email: string }) => {
      if (user.email === 'grace@example.com') throw new Error('Entra refused grace');
      return { success: true, objectId: 'entra-ada' };
    });

    const handle = await harness.env.client.workflow.start(bulkProvisioningWorkflow, {
      args: [request(['ada', 'grace'])],
      taskQueue: harness.taskQueue,
      workflowId: `bulk-e2e-snapshots-${Date.now()}`,
    });
    const result = await handle.result();
    const history = historyText(await handle.fetchHistory()).join('\n');

    // ada's UPDATE was rolled back from the snapshot store, under the batch tenant.
    expect(result.status).toBe('FAILED');
    expect(result.results[0]).toMatchObject({ operationId: 'op-0', rolledBack: true });
    expect(restoreUserState).toHaveBeenCalledWith('entra-ada', before);
    expect([...snapshots.saved.values()]).toContainEqual({
      tenantId: 'tenant-a',
      kind: 'entra-state',
      state: { existed: true, objectId: 'entra-ada', attributes: before },
    });
    expect(result.results[0].systemResults[0].previousState).toEqual({
      existed: true,
      objectId: 'entra-ada',
      snapshotRef: expect.stringMatching(/^snap-/),
      snapshotKind: 'entra-state',
    });
    // ada's Golden Record is back as it was; grace's, which the batch created, is gone.
    expect(hub.restoreHubState).toHaveBeenCalledWith('identity-ada@example.com', adaBefore);
    expect(hub.records.get('identity-ada@example.com')).toEqual(adaBefore);
    expect(hub.removeIdentity).toHaveBeenCalledWith('identity-grace@example.com', 'bulk-rollback');
    expect(hub.records.has('identity-grace@example.com')).toBe(false);
    expect(
      result.results.map((r) => [r.operationId, r.rolledBack, r.hubWrite?.rolledBack]),
    ).toEqual([
      ['op-0', true, true],
      ['op-1', true, true],
    ]);
    // The decoded history has the payloads (input, references) but not the overwritten values.
    expect(history).toContain('ada@example.com');
    expect(history).toContain(result.results[0].systemResults[0].previousState?.snapshotRef);
    expect(history).toContain(result.results[0].hubWrite?.snapshotRef);
    for (const overwritten of ['765 4321', 'Night Porter', '111 2222', 'Night Auditor']) {
      expect(history).not.toContain(overwritten);
      expect(JSON.stringify(result)).not.toContain(overwritten);
    }
  }, 60_000);

  it('keeps the first snapshot when the Entra activity is retried after changing the account', async () => {
    // What the first attempt wrote before its 429: a retry that snapshotted again would keep it.
    const written = { mobilePhone: '+358 40 000 1111', jobTitle: 'Day Clerk' };
    const graceBefore = { jobTitle: 'Clerk' };
    let linCaptures = 0;
    captureUserState.mockImplementation(async (user: { email: string }) => {
      if (user.email === 'grace@example.com') {
        return { existed: true, objectId: 'entra-grace', attributes: graceBefore };
      }
      linCaptures += 1;
      return {
        existed: true,
        objectId: 'entra-lin',
        attributes: linCaptures === 1 ? before : written,
      };
    });
    provisionUserToEntra
      .mockRejectedValueOnce(new RateLimitedException(1, 'entra-id'))
      .mockImplementation(async (user: { email: string }) => {
        if (user.email === 'grace@example.com') throw new Error('Entra refused grace');
        return { success: true, objectId: 'entra-lin' };
      });

    const handle = await harness.env.client.workflow.start(bulkProvisioningWorkflow, {
      args: [request(['lin', 'grace'])],
      taskQueue: harness.taskQueue,
      workflowId: `bulk-e2e-snapshot-retry-${Date.now()}`,
    });
    const result = await handle.result();
    const history = historyText(await handle.fetchHistory()).join('\n');

    expect(provisionUserToEntra).toHaveBeenCalledTimes(3); // lin twice (429, then ok), grace once
    expect(result.results[0]).toMatchObject({ operationId: 'op-0', rolledBack: true });
    expect(restoreUserState).toHaveBeenCalledWith('entra-lin', before);
    expect(restoreUserState).not.toHaveBeenCalledWith('entra-lin', written);
    // grace's UPDATE failed after its snapshot: it is restored too (hunt 2026-11-25 02 F9)
    expect(restoreUserState).toHaveBeenCalledWith('entra-grace', graceBefore);
    expect(history).toContain('bulk-provisioning:entra-snapshot-key');
    for (const value of ['765 4321', 'Night Porter', '000 1111', 'Day Clerk']) {
      expect(history).not.toContain(value);
    }
  }, 60_000);

  it.each([
    ['the Hub compensation patch', PRE_HUB_COMPENSATION_HISTORY],
    ['the Entra snapshot key patch', PRE_ENTRA_SNAPSHOT_KEY_HISTORY],
  ])(
    'replays a history recorded before %s',
    async (_patch, file) => {
      const history = JSON.parse(fs.readFileSync(file, 'utf8'));
      await expect(
        Worker.runReplayHistory({ workflowsPath: WORKFLOWS_PATH }, history),
      ).resolves.toBeUndefined();
    },
    60_000,
  );

  /** One DISABLE or DELETE of ada in Entra ID. */
  const removal = (type: BulkOperationType): BulkOperationRequest => ({
    ...request(['ada']),
    batchId: 'batch-removal',
    requireApprovalForDeletes: false,
    operations: [
      {
        id: 'op-0',
        type,
        priority: OperationPriority.NORMAL,
        targetSystems: ['entra-id'],
        user: { email: 'ada@example.com', firstName: 'ada', lastName: 'Test' },
      },
    ] as BulkOperationRequest['operations'],
  });

  it.each([BulkOperationType.DISABLE, BulkOperationType.DELETE])(
    'writes no Golden Record from the request body for a %s',
    async (type) => {
      const result = await harness.env.client.workflow.execute(bulkProvisioningWorkflow, {
        args: [removal(type)],
        taskQueue: harness.taskQueue,
        workflowId: `bulk-e2e-removal-${type}-${Date.now()}`,
      });

      expect(result.status).toBe('COMPLETED');
      // The identity is neither created nor overwritten (status ACTIVE) from the body
      expect(saveToHub).not.toHaveBeenCalled();
      expect(hub.records.size).toBe(0);
      expect(result.results[0].hubWrite).toBeUndefined();
      if (type === BulkOperationType.DISABLE) {
        expect(disableEntraUser).toHaveBeenCalledWith('ada@example.com', 'tenant-a', undefined);
      } else {
        expect(deleteUser).toHaveBeenCalled();
      }
    },
    60_000,
  );

  it('replays a history recorded before the removals stopped writing the Golden Record', async () => {
    const history = JSON.parse(fs.readFileSync(PRE_NO_HUB_WRITE_FOR_REMOVALS_HISTORY, 'utf8'));
    await expect(
      Worker.runReplayHistory({ workflowsPath: WORKFLOWS_PATH }, history),
    ).resolves.toBeUndefined();
  }, 60_000);

  const fixtureWorkflow = process.env.BULK_REMOVAL_FIXTURE_WORKFLOW;
  (fixtureWorkflow ? it : it.skip)(
    'records the pre-patch fixture (BULK_REMOVAL_FIXTURE_WORKFLOW = the pre-patch workflow file)',
    async () => {
      const pre = await createWorkflowTestHarness({
        workflowsPath: path.resolve(process.cwd(), fixtureWorkflow ?? ''),
        activities,
      });
      try {
        const handle = await pre.env.client.workflow.start(bulkProvisioningWorkflow, {
          args: [removal(BulkOperationType.DISABLE)],
          taskQueue: pre.taskQueue,
          workflowId: 'bulk-e2e-pre-no-hub-write-for-removals',
        });
        await handle.result();
        // The pre-patch workflow saved the body to the Hub
        expect(saveToHub).toHaveBeenCalledTimes(1);
        fs.writeFileSync(
          PRE_NO_HUB_WRITE_FOR_REMOVALS_HISTORY,
          historyJSON(await handle.fetchHistory()),
        );
      } finally {
        await pre.shutdown();
      }
    },
    120_000,
  );
});
