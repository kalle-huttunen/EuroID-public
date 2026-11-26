/**
 * orphanCleanupWorkflow emits no orphan.detected of its own, on the time-skipping Temporal test
 * server. Opt-in via TEMPORAL_E2E=1.
 *
 * orphan.detected went out twice per orphan: detection (OrphanDetectionService) emitted it when it
 * recorded the drift, and the cleanup workflow emitted it again through emitOrphanDetected, so
 * the audit log, the websocket and webhook subscribers got each orphan twice. Detection keeps
 * the event (it fires when the orphan is found; reconciliation starts the cleanup workflows one
 * after another); the workflow emits it only when replaying a history from before the patch
 * orphan-cleanup:detection-emits-orphan-detected.
 *
 * Proves:
 *   - A run started now never calls emitOrphanDetected and still runs the grace periods and the
 *     disable.
 *   - A history recorded before the patch (with its emitOrphanDetected) still replays.
 *
 * Fixture test/fixtures/orphan-cleanup-pre-detected-once.history.json was recorded with the
 * pre-patch workflow (commit 817b568b), from backend/:
 *   git show 817b568b:backend/src/workflows/orphan-cleanup.workflow.ts \
 *     > src/workflows/orphan-cleanup-pre-detected-once.workflow.ts
 *   TEMPORAL_E2E=1 ORPHAN_FIXTURE_WORKFLOW=src/workflows/orphan-cleanup-pre-detected-once.workflow.ts \
 *     npx jest -c test/jest-e2e.json orphan-cleanup-detected-once -t 'records the pre-patch fixture'
 *   rm src/workflows/orphan-cleanup-pre-detected-once.workflow.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { Worker } from '@temporalio/worker';
import { orphanCleanupWorkflow } from '../../src/workflows/orphan-cleanup.workflow';
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
  '../fixtures/orphan-cleanup-pre-detected-once.history.json',
);

const input = {
  driftId: 'drift-1',
  targetSystem: 'entra-id',
  externalId: '7c1f6e2a-0b8d-4a51-9d3e-2f4b6c8a1e90',
  accountIdentifier: 'orphan@example.com',
  tenantId: 'tenant-a',
};

describeTemporalE2E('orphanCleanupWorkflow emits no orphan.detected of its own (e2e)', () => {
  let harness: WorkflowTestHarness;
  const emitOrphanDetected = jest.fn();
  const disableOrphanAccount = jest.fn();
  const setOrphanDisabledAt = jest.fn();

  // Both grace periods pass (time skipping); the account stays disabled
  const workers = (): Omit<WorkflowTestHarnessOptions, 'workflowsPath'> => ({
    activities: {
      getOrphanConfig: async () => ({
        gracePeriodDays: 1,
        extendedGraceDays: 1,
        autoDeleteAfterExtended: false,
      }),
      emitOrphanDetected: (...args: unknown[]) => emitOrphanDetected(...args),
      // The account is still an orphan when the cleanup acts (patch recheck-before-acting)
      confirmOrphan: async () => ({ orphan: true }),
      disableOrphanAccount: (...args: unknown[]) => disableOrphanAccount(...args),
      setOrphanDisabledAt: (...args: unknown[]) => setOrphanDisabledAt(...args),
    },
  });

  beforeAll(async () => {
    harness = await createWorkflowTestHarness({ workflowsPath: WORKFLOWS_PATH, ...workers() });
  }, 120_000);

  afterAll(async () => {
    await harness?.shutdown();
  }, 30_000);

  beforeEach(() => {
    emitOrphanDetected.mockReset().mockResolvedValue(undefined);
    disableOrphanAccount.mockReset().mockResolvedValue(true);
    setOrphanDisabledAt.mockReset().mockResolvedValue(undefined);
  });

  it('runs the grace periods and the disable without emitting orphan.detected', async () => {
    await harness.env.client.workflow.execute(orphanCleanupWorkflow, {
      args: [input],
      taskQueue: harness.taskQueue,
      workflowId: 'orphan-cleanup-e2e-detected-once',
    });

    expect(emitOrphanDetected).not.toHaveBeenCalled();
    expect(disableOrphanAccount).toHaveBeenCalledWith('entra-id', 'orphan@example.com', 'tenant-a');
    expect(setOrphanDisabledAt).toHaveBeenCalledWith('drift-1', 'tenant-a');
  }, 60_000);

  it('replays a history recorded before the detection-emits-orphan-detected patch', async () => {
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
          args: [input],
          taskQueue: pre.taskQueue,
          workflowId: 'orphan-cleanup-e2e-pre-detected-once',
        });
        await handle.result();
        // The pre-patch workflow emitted the event a second time
        expect(emitOrphanDetected).toHaveBeenCalledTimes(1);
        fs.writeFileSync(PRE_PATCH_HISTORY, historyJSON(await handle.fetchHistory()));
      } finally {
        await pre.shutdown();
      }
    },
    120_000,
  );
});
