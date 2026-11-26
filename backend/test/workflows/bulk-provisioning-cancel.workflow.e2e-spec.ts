/**
 * Cancelling a bulk run, end to end on the time-skipping Temporal test server, with the real
 * BulkProvisioningActivities (Entra ID mocked, Golden Record and snapshot store in memory). Opt-in
 * via TEMPORAL_E2E=1.
 *
 * Before the patch bulk-provisioning:cancel-compensates the workflow read the cancel signal only
 * between phases and at the delete approval gate, and then ended FAILED without a rollback; the
 * API terminated the run right after the signal, so an operation in flight was left half done,
 * the completed ones stayed in place and the results were lost (hunt 2026-11-25 02 F10 follow-up).
 *
 * Proves, for runs started now:
 *   - The signal stops the run before its next batch: no further operation starts.
 *   - What the run changed is compensated (the created Entra ID account disabled, the Golden
 *     Record it created removed), and the run ends CANCELLED with its results.
 *   - A cancel while the run waits for delete approval compensates the earlier phases too, and
 *     deletes nothing.
 *   - A history recorded before the patch (the signal mid-batch, the run going on to the phase
 *     end and failing there) still replays.
 *
 * Fixture test/fixtures/bulk-provisioning-pre-cancel-compensates.history.json was recorded with
 * the pre-patch workflow (the tree before this patch), from backend/:
 *   TEMPORAL_E2E=1 BULK_CANCEL_FIXTURE_WORKFLOW=src/workflows/bulk-provisioning.workflow.ts \
 *     npx jest -c test/jest-e2e.json bulk-provisioning-cancel -t 'records the pre-patch fixture'
 * (Against a later tree: copy the pre-patch workflow files under other names first.)
 */
import * as fs from 'fs';
import * as path from 'path';
import { Worker } from '@temporalio/worker';
import {
  bulkProvisioningWorkflow,
  cancelWorkflowSignal,
  getCurrentPhaseQuery,
} from '../../src/workflows/bulk-provisioning.workflow';
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
  '../fixtures/bulk-provisioning-pre-cancel-compensates.history.json',
);

describeTemporalE2E('bulkProvisioningWorkflow cancel (e2e)', () => {
  let harness: WorkflowTestHarness;
  let activities: Record<string, (...args: unknown[]) => unknown>;
  const hub = new MemoryHub(async () => 'hub-1');
  const provisionUserToEntra = jest.fn();
  const deleteUser = jest.fn();
  const disableUser = jest.fn();
  /** Runs inside the Entra ID activity of each operation, before it answers. */
  let duringOperation: (opId: string) => Promise<void> = async () => undefined;

  beforeAll(async () => {
    const bulk = new BulkProvisioningActivities(
      { provisionUserToEntra, deleteUser } as unknown as Deps[0],
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
        captureUserState: async () => ({ existed: false }),
        disableUser,
      } as unknown as Deps[8],
      new MemorySnapshots() as unknown as Deps[9],
      hub as unknown as Deps[10],
    );
    activities = {
      validateBatch: async () => ({
        safe: true,
        errors: [],
        warnings: [],
        risk: { level: 'LOW', reasons: [], destructiveOps: 0, vipUsersAffected: 0 },
      }),
      initializeRateLimit: async () => undefined,
      partitionOperations: (...args: unknown[]) =>
        bulk.partitionOperations(...(args as Parameters<typeof bulk.partitionOperations>)),
      saveToHubWithSnapshot: (...args: unknown[]) =>
        bulk.saveToHubWithSnapshot(...(args as Parameters<typeof bulk.saveToHubWithSnapshot>)),
      executeSystemOperation: async (...args: unknown[]) => {
        const outcome = await bulk.executeSystemOperation(
          ...(args as Parameters<typeof bulk.executeSystemOperation>),
        );
        await duringOperation((args[0] as { id: string }).id);
        return outcome;
      },
      compensateOperation: (...args: unknown[]) =>
        bulk.compensateOperation(...(args as Parameters<typeof bulk.compensateOperation>)),
    };
    harness = await createWorkflowTestHarness({ workflowsPath: WORKFLOWS_PATH, activities });
  }, 120_000);

  afterAll(async () => {
    await harness?.shutdown();
  }, 30_000);

  beforeEach(() => {
    hub.records.clear();
    hub.removeIdentity.mockClear();
    provisionUserToEntra.mockReset().mockImplementation(async (user: { email: string }) => ({
      success: true,
      objectId: `entra-${user.email.split('@')[0]}`,
    }));
    deleteUser.mockReset().mockResolvedValue({ success: true });
    disableUser.mockReset().mockResolvedValue(true);
    duringOperation = async () => undefined;
  });

  const op = (name: string, i: number, type = BulkOperationType.CREATE) => ({
    id: `op-${i}`,
    type,
    priority: OperationPriority.NORMAL,
    targetSystems: ['entra-id'],
    user: { email: `${name}@example.com`, firstName: name, lastName: 'Test' },
  });

  /** Three creates, one per batch. */
  const creates = (): BulkOperationRequest => ({
    batchId: 'batch-cancel',
    tenantId: 'tenant-a',
    initiatedBy: 'e2e',
    batchSize: 1,
    operations: [op('ada', 0), op('grace', 1), op('lin', 2)] as BulkOperationRequest['operations'],
  });

  /** Cancels the run from inside op-0's Entra ID activity: the signal lands mid-batch. */
  const cancelDuringFirstOperation = (h: WorkflowTestHarness, workflowId: string) => {
    duringOperation = async (opId) => {
      if (opId === 'op-0') {
        await h.env.client.workflow.getHandle(workflowId).signal(cancelWorkflowSignal);
      }
    };
  };

  const emails = (mock: jest.Mock) =>
    mock.mock.calls.map(([user]) => (user as { email: string }).email);

  it('stops before the next batch, compensates what it changed and ends CANCELLED', async () => {
    const workflowId = `bulk-e2e-cancel-${Date.now()}`;
    cancelDuringFirstOperation(harness, workflowId);

    const result = await harness.env.client.workflow.execute(bulkProvisioningWorkflow, {
      args: [creates()],
      taskQueue: harness.taskQueue,
      workflowId,
    });

    expect(emails(provisionUserToEntra)).toEqual(['ada@example.com']);
    expect(result.status).toBe('CANCELLED');
    expect(result.errors).toEqual(['Workflow cancelled by user']);
    expect(result.results.map((r) => [r.operationId, r.success, r.rolledBack])).toEqual([
      ['op-0', true, true],
    ]);
    expect(result.summary).toMatchObject({ total: 3, successful: 0, rolledBack: 1 });
    // ada's Entra ID account is disabled again and the Golden Record the run created is gone
    expect(disableUser).toHaveBeenCalledWith('entra-ada');
    expect(hub.removeIdentity).toHaveBeenCalledWith('identity-ada@example.com', 'bulk-rollback');
    expect(hub.records.size).toBe(0);
  }, 60_000);

  it('compensates the earlier phases and deletes nothing when cancelled at the delete approval', async () => {
    const workflowId = `bulk-e2e-cancel-approval-${Date.now()}`;
    const handle = await harness.env.client.workflow.start(bulkProvisioningWorkflow, {
      args: [
        {
          ...creates(),
          requireApprovalForDeletes: true,
          operations: [op('ada', 0), op('bob', 1, BulkOperationType.DELETE)],
        } as BulkOperationRequest,
      ],
      taskQueue: harness.taskQueue,
      workflowId,
    });
    for (let i = 0; i < 50; i++) {
      if ((await handle.query(getCurrentPhaseQuery)) === 'AWAITING_DELETE_APPROVAL') break;
      await harness.env.sleep(100); // time-skipping: lets the run reach the gate
    }
    await handle.signal(cancelWorkflowSignal);
    const result = await handle.result();

    expect(result.status).toBe('CANCELLED');
    expect(deleteUser).not.toHaveBeenCalled();
    expect(result.results.map((r) => [r.operationId, r.rolledBack])).toEqual([['op-0', true]]);
    expect(disableUser).toHaveBeenCalledWith('entra-ada');
  }, 60_000);

  it('replays a history recorded before the patch bulk-provisioning:cancel-compensates', async () => {
    const history = JSON.parse(fs.readFileSync(PRE_PATCH_HISTORY, 'utf8'));
    await expect(
      Worker.runReplayHistory({ workflowsPath: WORKFLOWS_PATH }, history),
    ).resolves.toBeUndefined();
  }, 60_000);

  const fixtureWorkflow = process.env.BULK_CANCEL_FIXTURE_WORKFLOW;
  (fixtureWorkflow ? it : it.skip)(
    'records the pre-patch fixture (BULK_CANCEL_FIXTURE_WORKFLOW = the pre-patch workflow file)',
    async () => {
      const pre = await createWorkflowTestHarness({
        workflowsPath: path.resolve(process.cwd(), fixtureWorkflow ?? ''),
        activities,
      });
      try {
        const workflowId = 'bulk-e2e-pre-cancel-compensates';
        cancelDuringFirstOperation(pre, workflowId);
        const handle = await pre.env.client.workflow.start(bulkProvisioningWorkflow, {
          args: [creates()],
          taskQueue: pre.taskQueue,
          workflowId,
        });
        const result = await handle.result();
        // The pre-patch code: every create runs, then the run fails at the phase end, no rollback
        expect(emails(provisionUserToEntra)).toHaveLength(3);
        expect(result.status).toBe('FAILED');
        expect(disableUser).not.toHaveBeenCalled();
        fs.writeFileSync(PRE_PATCH_HISTORY, historyJSON(await handle.fetchHistory()));
      } finally {
        await pre.shutdown();
      }
    },
    120_000,
  );
});
