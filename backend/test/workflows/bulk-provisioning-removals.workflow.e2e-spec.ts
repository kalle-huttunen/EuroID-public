/**
 * The Hub after a bulk DISABLE or DELETE, end to end on the time-skipping Temporal test server,
 * with the real BulkProvisioningActivities (Entra ID and the identity store mocked). Opt-in via
 * TEMPORAL_E2E=1.
 *
 * Before the patch bulk-provisioning:mark-removed-accounts a bulk DISABLE or DELETE changed the
 * Entra ID account and told the Hub nothing: the identity's provisioning entry stayed SYNCED until
 * reconciliation found the drift, so offboarding and the mover took the account for active. The
 * operation body is no Hub record and writes none (patch bulk-provisioning:no-hub-write-for-
 * removals); the entry is marked by an activity that looks the identity up.
 *
 * Proves, for runs started now:
 *   - A removal that stays done marks the identity's Entra ID entry DEPROVISIONED, the identity
 *     found by the operation's source key, else its email; nothing is created or upserted.
 *   - A removal the run rolled back (fail-fast) marks nothing.
 *   - A history recorded before the patch (a successful DISABLE) still replays.
 *
 * Fixture test/fixtures/bulk-provisioning-pre-mark-removed-accounts.history.json was recorded with
 * the pre-patch workflow (the tree before this patch), from backend/:
 *   TEMPORAL_E2E=1 BULK_REMOVED_FIXTURE_WORKFLOW=src/workflows/bulk-provisioning.workflow.ts \
 *     npx jest -c test/jest-e2e.json bulk-provisioning-removals -t 'records the pre-patch fixture'
 * (Against a later tree: copy the pre-patch workflow files under other names first.)
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
import { MemoryHub, MemorySnapshots } from '../helpers/bulk-rollback-fakes';
import { historyJSON } from '../helpers/history-json';
import {
  createWorkflowTestHarness,
  describeTemporalE2E,
  type WorkflowTestHarness,
} from '../helpers/workflow-test-env';

type Deps = ConstructorParameters<typeof BulkProvisioningActivities>;

const WORKFLOWS_PATH = path.resolve(__dirname, '../../src/workflows/bulk-provisioning.workflow.ts');
const PRE_PATCH_HISTORY = path.resolve(
  __dirname,
  '../fixtures/bulk-provisioning-pre-mark-removed-accounts.history.json',
);

/** An identity provisioned to Entra ID (entry `entra`) and to GitHub. */
const identity = (id: string) => ({
  _id: id,
  provisioning: [
    { targetSystem: 'entra', status: 'SYNCED' },
    { targetSystem: 'github', status: 'SYNCED' },
  ],
});

describeTemporalE2E('bulkProvisioningWorkflow removals and the Hub (e2e)', () => {
  let harness: WorkflowTestHarness;
  let activities: Record<string, (...args: unknown[]) => unknown>;
  const hub = new MemoryHub(async () => 'hub-1');
  const findIdentityBySourceKey = jest.fn();
  const findIdentityByEmail = jest.fn();
  const updateProvisioningState = jest.fn();
  const disableEntraUser = jest.fn();
  const enableEntraUser = jest.fn();
  const deleteUser = jest.fn();

  beforeAll(async () => {
    const identityService = Object.assign(hub, {
      findIdentityBySourceKey,
      findIdentityByEmail,
      updateProvisioningState,
    });
    const bulk = new BulkProvisioningActivities(
      { disableEntraUser, enableEntraUser, deleteUser } as unknown as Deps[0],
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
        checkUserExists: async (email: string) => `entra-${email}`,
        getCredentialState: async () => ({ accountEnabled: true }),
      } as unknown as Deps[8],
      new MemorySnapshots() as unknown as Deps[9],
      identityService as unknown as Deps[10],
    );
    const bind =
      <K extends keyof BulkProvisioningActivities>(name: K) =>
      (...args: unknown[]) =>
        (bulk[name] as (...a: unknown[]) => unknown)(...args);
    activities = {
      validateBatch: async () => ({
        safe: true,
        errors: [],
        warnings: [],
        risk: { level: 'LOW', reasons: [], destructiveOps: 0, vipUsersAffected: 0 },
      }),
      initializeRateLimit: async () => undefined,
      partitionOperations: bind('partitionOperations'),
      saveToHubWithSnapshot: bind('saveToHubWithSnapshot'),
      executeSystemOperation: bind('executeSystemOperation'),
      compensateOperation: bind('compensateOperation'),
      markRemovedAccounts: bind('markRemovedAccounts'),
    };
    harness = await createWorkflowTestHarness({ workflowsPath: WORKFLOWS_PATH, activities });
  }, 120_000);

  afterAll(async () => {
    await harness?.shutdown();
  }, 30_000);

  beforeEach(() => {
    findIdentityBySourceKey.mockReset().mockResolvedValue(null);
    findIdentityByEmail.mockReset().mockResolvedValue(null);
    updateProvisioningState.mockReset().mockResolvedValue(null);
    disableEntraUser.mockReset().mockResolvedValue(true);
    enableEntraUser.mockReset().mockResolvedValue(true);
    deleteUser.mockReset().mockResolvedValue({ success: true });
  });

  const op = (
    name: string,
    i: number,
    type: BulkOperationType,
    source?: { sourceSystem: string; sourceUserId: string },
  ) => ({
    id: `op-${i}`,
    type,
    priority: OperationPriority.NORMAL,
    targetSystems: ['entra-id'],
    user: { email: `${name}@example.com`, firstName: name, lastName: 'Test', ...source },
  });

  const request = (operations: ReturnType<typeof op>[]): BulkOperationRequest => ({
    batchId: 'batch-removals',
    tenantId: 'tenant-a',
    initiatedBy: 'e2e',
    batchSize: 1,
    requireApprovalForDeletes: false,
    operations: operations as BulkOperationRequest['operations'],
  });

  const run = (req: BulkOperationRequest, id: string) =>
    harness.env.client.workflow.execute(bulkProvisioningWorkflow, {
      args: [req],
      taskQueue: harness.taskQueue,
      workflowId: `bulk-e2e-removals-${id}-${Date.now()}`,
    });

  it('marks the Entra ID entry of the identity a DISABLE removed, found by its source key', async () => {
    findIdentityBySourceKey.mockResolvedValue(identity('identity-ada'));

    const result = await run(
      request([
        op('ada', 0, BulkOperationType.DISABLE, { sourceSystem: 'csv-hr', sourceUserId: 'E-1' }),
      ]),
      'disable',
    );

    expect(result.status).toBe('COMPLETED');
    expect(findIdentityBySourceKey).toHaveBeenCalledWith('csv-hr', 'E-1', 'tenant-a');
    expect(updateProvisioningState).toHaveBeenCalledTimes(1);
    expect(updateProvisioningState).toHaveBeenCalledWith('identity-ada', 'entra', 'DEPROVISIONED');
    // No Golden Record written from the body
    expect(hub.records.size).toBe(0);
  }, 60_000);

  it('finds the identity a DELETE removed by its email when the operation has no source key', async () => {
    findIdentityByEmail.mockResolvedValue(identity('identity-bob'));

    await run(request([op('bob', 0, BulkOperationType.DELETE)]), 'delete');

    expect(findIdentityBySourceKey).not.toHaveBeenCalled();
    expect(findIdentityByEmail).toHaveBeenCalledWith('bob@example.com', { tenantId: 'tenant-a' });
    expect(updateProvisioningState).toHaveBeenCalledWith('identity-bob', 'entra', 'DEPROVISIONED');
  }, 60_000);

  it('marks nothing for a DISABLE the run rolled back', async () => {
    findIdentityByEmail.mockResolvedValue(identity('identity-ada'));
    disableEntraUser.mockImplementation(async (email: string) => email === 'ada@example.com');

    const result = await run(
      request([op('ada', 0, BulkOperationType.DISABLE), op('grace', 1, BulkOperationType.DISABLE)]),
      'rolled-back',
    );

    expect(result.status).toBe('FAILED');
    expect(result.results[0]).toMatchObject({ operationId: 'op-0', rolledBack: true });
    expect(enableEntraUser).toHaveBeenCalledWith('ada@example.com', 'tenant-a', undefined);
    expect(updateProvisioningState).not.toHaveBeenCalled();
  }, 60_000);

  it('replays a history recorded before the patch bulk-provisioning:mark-removed-accounts', async () => {
    const history = JSON.parse(fs.readFileSync(PRE_PATCH_HISTORY, 'utf8'));
    await expect(
      Worker.runReplayHistory({ workflowsPath: WORKFLOWS_PATH }, history),
    ).resolves.toBeUndefined();
  }, 60_000);

  const fixtureWorkflow = process.env.BULK_REMOVED_FIXTURE_WORKFLOW;
  (fixtureWorkflow ? it : it.skip)(
    'records the pre-patch fixture (BULK_REMOVED_FIXTURE_WORKFLOW = the pre-patch workflow file)',
    async () => {
      const pre = await createWorkflowTestHarness({
        workflowsPath: path.resolve(process.cwd(), fixtureWorkflow ?? ''),
        activities,
      });
      try {
        const handle = await pre.env.client.workflow.start(bulkProvisioningWorkflow, {
          args: [
            request([
              op('ada', 0, BulkOperationType.DISABLE, {
                sourceSystem: 'csv-hr',
                sourceUserId: 'E-1',
              }),
            ]),
          ],
          taskQueue: pre.taskQueue,
          workflowId: 'bulk-e2e-pre-mark-removed-accounts',
        });
        const result = await handle.result();
        // The pre-patch code: the account is disabled and the Hub is not told
        expect(result.status).toBe('COMPLETED');
        expect(disableEntraUser).toHaveBeenCalledTimes(1);
        expect(updateProvisioningState).not.toHaveBeenCalled();
        fs.writeFileSync(PRE_PATCH_HISTORY, historyJSON(await handle.fetchHistory()));
      } finally {
        await pre.shutdown();
      }
    },
    120_000,
  );
});
