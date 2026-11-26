/**
 * orphanCleanupWorkflow under requireApprovalForDeletes, on the time-skipping Temporal test
 * server. Opt-in via TEMPORAL_E2E=1.
 *
 * A reconciliation run started with requireApprovalForDeletes: true still started orphan
 * cleanups that deleted the account after the extended grace whenever the orphan config said
 * autoDeleteAfterExtended. Behind the patch orphan-cleanup:approval-for-deletes a cleanup whose
 * input carries the flag (dailyReconciliationWorkflow passes it) keeps the account disabled
 * after the extended grace; a person deletes it (DELETE signal).
 *
 * Proves:
 *   - With the flag and autoDeleteAfterExtended, the account is disabled and never deleted.
 *   - Without the flag the account is deleted after the extended grace, as before.
 *   - A history recorded before the patch (flag in the input, the account auto-deleted) still
 *     replays.
 *
 * Fixture test/fixtures/orphan-cleanup-pre-approval-for-deletes.history.json was recorded with
 * the pre-patch workflow (commit 47200b7b), from backend/:
 *   git show 47200b7b:backend/src/workflows/orphan-cleanup.workflow.ts \
 *     > src/workflows/orphan-cleanup-pre-approval-for-deletes.workflow.ts
 *   TEMPORAL_E2E=1 \
 *     ORPHAN_FIXTURE_WORKFLOW=src/workflows/orphan-cleanup-pre-approval-for-deletes.workflow.ts \
 *     npx jest -c test/jest-e2e.json orphan-cleanup-approval-for-deletes \
 *     -t 'records the pre-patch fixture'
 *   rm src/workflows/orphan-cleanup-pre-approval-for-deletes.workflow.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { Worker } from '@temporalio/worker';
import {
  orphanCleanupWorkflow,
  type OrphanCleanupInput,
} from '../../src/workflows/orphan-cleanup.workflow';
import {
  createWorkflowTestHarness,
  describeTemporalE2E,
  type WorkflowTestHarness,
  type WorkflowTestHarnessOptions,
} from '../helpers/workflow-test-env';
import { historyJSON } from '../helpers/history-json';

const WORKFLOWS_PATH = path.resolve(__dirname, '../../src/workflows/orphan-cleanup.workflow.ts');
const PRE_PATCH_HISTORY = path.resolve(
  __dirname,
  '../fixtures/orphan-cleanup-pre-approval-for-deletes.history.json',
);

const input: OrphanCleanupInput = {
  driftId: 'drift-1',
  targetSystem: 'entra-id',
  externalId: '7c1f6e2a-0b8d-4a51-9d3e-2f4b6c8a1e90',
  accountIdentifier: 'orphan@example.com',
  tenantId: 'tenant-a',
};

describeTemporalE2E('orphanCleanupWorkflow holds the delete for approval (e2e)', () => {
  let harness: WorkflowTestHarness;
  const disableOrphanAccount = jest.fn();
  const setOrphanDisabledAt = jest.fn();
  const deleteOrphanAccount = jest.fn();
  const updateOrphanDriftStatus = jest.fn();

  // Both grace periods pass (time skipping); the orphan config would delete afterwards
  const workers = (): Omit<WorkflowTestHarnessOptions, 'workflowsPath'> => ({
    activities: {
      getOrphanConfig: async () => ({
        gracePeriodDays: 1,
        extendedGraceDays: 1,
        autoDeleteAfterExtended: true,
      }),
      emitOrphanDetected: async () => undefined,
      // The account is still an orphan when the cleanup acts (patch recheck-before-acting)
      confirmOrphan: async () => ({ orphan: true }),
      disableOrphanAccount: (...args: unknown[]) => disableOrphanAccount(...args),
      setOrphanDisabledAt: (...args: unknown[]) => setOrphanDisabledAt(...args),
      deleteOrphanAccount: (...args: unknown[]) => deleteOrphanAccount(...args),
      updateOrphanDriftStatus: (...args: unknown[]) => updateOrphanDriftStatus(...args),
    },
  });

  beforeAll(async () => {
    harness = await createWorkflowTestHarness({ workflowsPath: WORKFLOWS_PATH, ...workers() });
  }, 120_000);

  afterAll(async () => {
    await harness?.shutdown();
  }, 30_000);

  beforeEach(() => {
    disableOrphanAccount.mockReset().mockResolvedValue(true);
    setOrphanDisabledAt.mockReset().mockResolvedValue(undefined);
    deleteOrphanAccount.mockReset().mockResolvedValue({ success: true });
    updateOrphanDriftStatus.mockReset().mockResolvedValue(undefined);
  });

  it('keeps the account disabled after the extended grace when the run asks for approval', async () => {
    await harness.env.client.workflow.execute(orphanCleanupWorkflow, {
      args: [{ ...input, requireApprovalForDeletes: true }],
      taskQueue: harness.taskQueue,
      workflowId: 'orphan-cleanup-e2e-approval-for-deletes',
    });

    expect(disableOrphanAccount).toHaveBeenCalledWith('entra-id', 'orphan@example.com', 'tenant-a');
    expect(deleteOrphanAccount).not.toHaveBeenCalled();
    expect(updateOrphanDriftStatus).not.toHaveBeenCalled();
  }, 60_000);

  it('deletes the account after the extended grace without the flag, as before', async () => {
    await harness.env.client.workflow.execute(orphanCleanupWorkflow, {
      args: [input],
      taskQueue: harness.taskQueue,
      workflowId: 'orphan-cleanup-e2e-no-approval-for-deletes',
    });

    expect(deleteOrphanAccount).toHaveBeenCalledWith(
      'entra-id',
      'orphan@example.com',
      'tenant-a',
      undefined,
      input.externalId,
    );
    expect(updateOrphanDriftStatus).toHaveBeenCalledWith(
      'drift-1',
      'corrected',
      'DELETE',
      'auto-after-grace',
      'tenant-a',
    );
  }, 60_000);

  it('replays a history recorded before the approval-for-deletes patch', async () => {
    const history = JSON.parse(fs.readFileSync(PRE_PATCH_HISTORY, 'utf8'));
    await expect(
      Worker.runReplayHistory({ workflowsPath: WORKFLOWS_PATH }, history),
    ).resolves.toBeUndefined();
  }, 60_000);

  const fixtureWorkflow = process.env.ORPHAN_FIXTURE_WORKFLOW;
  (fixtureWorkflow ? it : it.skip)(
    'records the pre-patch fixture (ORPHAN_FIXTURE_WORKFLOW = the pre-patch workflow file)',
    async () => {
      const pre = await createWorkflowTestHarness({
        workflowsPath: path.resolve(process.cwd(), fixtureWorkflow ?? ''),
        ...workers(),
      });
      try {
        const handle = await pre.env.client.workflow.start(orphanCleanupWorkflow, {
          args: [{ ...input, requireApprovalForDeletes: true }],
          taskQueue: pre.taskQueue,
          workflowId: 'orphan-cleanup-e2e-pre-approval-for-deletes',
        });
        await handle.result();
        // The pre-patch workflow deleted the account despite the flag
        expect(deleteOrphanAccount).toHaveBeenCalledTimes(1);
        fs.writeFileSync(PRE_PATCH_HISTORY, historyJSON(await handle.fetchHistory()));
      } finally {
        await pre.shutdown();
      }
    },
    120_000,
  );
});
