/**
 * orphanCleanupWorkflow asks again before it acts, on the time-skipping Temporal test server.
 * Opt-in via TEMPORAL_E2E=1.
 *
 * After the 30-day grace the cleanup disabled the account without checking that its drift was
 * still open or the account still an orphan (hunt r2-05 N4): IT pre-creates an Entra account, HR
 * creates the identity on day 20, and the active employee's account is disabled on day 30. It
 * also stamped disabledAt after a disable that did nothing (an AD orphan, 05 F9). Behind the
 * patch orphan-cleanup:recheck-before-acting it asks confirmOrphan before it disables or
 * deletes, and stamps disabledAt only after a disable that happened.
 *
 * Proves:
 *   - An account that is no longer an orphan is neither disabled nor deleted.
 *   - A disable that changed nothing leaves disabledAt unset; the auto-delete still asks first.
 *   - A history recorded before the patch (disable answered false, disabledAt stamped, account
 *     auto-deleted) still replays.
 *
 * Fixture test/fixtures/orphan-cleanup-pre-recheck-before-acting.history.json was recorded with
 * the pre-patch workflow (commit 37375def), from backend/:
 *   git show 37375def:backend/src/workflows/orphan-cleanup.workflow.ts \
 *     > src/workflows/orphan-cleanup-pre-recheck.workflow.ts
 *   TEMPORAL_E2E=1 ORPHAN_FIXTURE_WORKFLOW=src/workflows/orphan-cleanup-pre-recheck.workflow.ts \
 *     npx jest -c test/jest-e2e.json orphan-cleanup-recheck -t 'records the pre-patch fixture'
 *   rm src/workflows/orphan-cleanup-pre-recheck.workflow.ts
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
  '../fixtures/orphan-cleanup-pre-recheck-before-acting.history.json',
);

const input: OrphanCleanupInput = {
  driftId: 'drift-1',
  targetSystem: 'ad',
  externalId: '33221100-5544-7766-8899-aabbccddeeff',
  accountIdentifier: 'orphan@corp.example',
  tenantId: 'tenant-a',
};

describeTemporalE2E('orphanCleanupWorkflow asks again before it acts (e2e)', () => {
  let harness: WorkflowTestHarness;
  const confirmOrphan = jest.fn();
  const disableOrphanAccount = jest.fn();
  const setOrphanDisabledAt = jest.fn();
  const deleteOrphanAccount = jest.fn();
  const updateOrphanDriftStatus = jest.fn();

  // Both grace periods pass (time skipping); the orphan config deletes afterwards
  const workers = (): Omit<WorkflowTestHarnessOptions, 'workflowsPath'> => ({
    activities: {
      getOrphanConfig: async () => ({
        gracePeriodDays: 1,
        extendedGraceDays: 1,
        autoDeleteAfterExtended: true,
      }),
      emitOrphanDetected: async () => undefined,
      confirmOrphan: (...args: unknown[]) => confirmOrphan(...args),
      disableOrphanAccount: (...args: unknown[]) => disableOrphanAccount(...args),
      setOrphanDisabledAt: (...args: unknown[]) => setOrphanDisabledAt(...args),
      deleteOrphanAccount: (...args: unknown[]) => deleteOrphanAccount(...args),
      updateOrphanDriftStatus: (...args: unknown[]) => updateOrphanDriftStatus(...args),
      // An AD orphan is kept, never deleted (patch orphan-cleanup:ad-never-deleted)
      keepOrphanAccount: async () => undefined,
    },
  });

  const run = (workflowId: string) =>
    harness.env.client.workflow.execute(orphanCleanupWorkflow, {
      args: [input],
      taskQueue: harness.taskQueue,
      workflowId,
    });

  beforeAll(async () => {
    harness = await createWorkflowTestHarness({ workflowsPath: WORKFLOWS_PATH, ...workers() });
  }, 120_000);

  afterAll(async () => {
    await harness?.shutdown();
  }, 30_000);

  beforeEach(() => {
    confirmOrphan.mockReset().mockResolvedValue({ orphan: true });
    disableOrphanAccount.mockReset().mockResolvedValue(false);
    setOrphanDisabledAt.mockReset().mockResolvedValue(undefined);
    deleteOrphanAccount.mockReset().mockResolvedValue({ success: false, error: 'not supported' });
    updateOrphanDriftStatus.mockReset().mockResolvedValue(undefined);
  });

  it('leaves an account that is no longer an orphan alone', async () => {
    confirmOrphan.mockResolvedValue({ orphan: false, reason: 'an identity has it' });

    await run('orphan-cleanup-e2e-recheck-owner');

    expect(confirmOrphan).toHaveBeenCalledWith('drift-1', 'orphan@corp.example', 'tenant-a');
    expect(disableOrphanAccount).not.toHaveBeenCalled();
    expect(deleteOrphanAccount).not.toHaveBeenCalled();
  }, 60_000);

  it('stamps no disabledAt after a disable that did nothing, and asks before the delete', async () => {
    await run('orphan-cleanup-e2e-recheck-not-disabled');

    expect(disableOrphanAccount).toHaveBeenCalledWith('ad', 'orphan@corp.example', 'tenant-a');
    expect(setOrphanDisabledAt).not.toHaveBeenCalled();
    expect(confirmOrphan).toHaveBeenCalledTimes(2);
    // The delete failed: the drift is not recorded as deleted
    expect(updateOrphanDriftStatus).not.toHaveBeenCalled();
  }, 60_000);

  it('replays a history recorded before the recheck-before-acting patch', async () => {
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
        deleteOrphanAccount.mockResolvedValue({ success: true });
        const handle = await pre.env.client.workflow.start(orphanCleanupWorkflow, {
          args: [input],
          taskQueue: pre.taskQueue,
          workflowId: 'orphan-cleanup-e2e-pre-recheck-before-acting',
        });
        await handle.result();
        // The pre-patch workflow acted without asking and stamped disabledAt regardless
        expect(confirmOrphan).not.toHaveBeenCalled();
        expect(setOrphanDisabledAt).toHaveBeenCalledTimes(1);
        expect(deleteOrphanAccount).toHaveBeenCalledTimes(1);
        fs.writeFileSync(PRE_PATCH_HISTORY, historyJSON(await handle.fetchHistory()));
      } finally {
        await pre.shutdown();
      }
    },
    120_000,
  );
});
