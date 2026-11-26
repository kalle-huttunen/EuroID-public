/**
 * orphanCleanupWorkflow and an Active Directory orphan, on the time-skipping Temporal test
 * server. Opt-in via TEMPORAL_E2E=1.
 *
 * EuroID never deletes an AD account (no recycle bin guarantee, and a deleted account's SID is
 * lost). Before, the auto-delete after the extended grace called deleteOrphanAccount for an AD
 * orphan, which failed, and the cleanup only logged it. Behind the patch
 * orphan-cleanup:ad-never-deleted the cleanup does not try: the account stays disabled, the drift
 * quarantined, and the reason is recorded on it (keepOrphanAccount). Entra ID and SCIM orphans
 * are deleted as before.
 *
 * Proves:
 *   - An AD orphan is disabled, never deleted, and the reason goes on its drift.
 *   - A SCIM orphan is deleted after the extended grace.
 *   - A history recorded before the patch (the AD delete tried and failed) still replays.
 *
 * Fixture test/fixtures/orphan-cleanup-pre-ad-never-deleted.history.json was recorded with the
 * pre-patch workflow (commit 5372cd07), from backend/:
 *   git show 5372cd07:backend/src/workflows/orphan-cleanup.workflow.ts \
 *     > src/workflows/orphan-cleanup-pre-ad-never-deleted.workflow.ts
 *   TEMPORAL_E2E=1 \
 *     ORPHAN_FIXTURE_WORKFLOW=src/workflows/orphan-cleanup-pre-ad-never-deleted.workflow.ts \
 *     npx jest -c test/jest-e2e.json orphan-cleanup-ad-kept -t 'records the pre-patch fixture'
 *   rm src/workflows/orphan-cleanup-pre-ad-never-deleted.workflow.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { Worker } from '@temporalio/worker';
import {
  orphanCleanupWorkflow,
  type OrphanCleanupInput,
} from '../../src/workflows/orphan-cleanup.workflow';
import { AD_ORPHAN_KEPT_REASON } from '../../src/shared/utils/orphan-delete-policy';
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
  '../fixtures/orphan-cleanup-pre-ad-never-deleted.history.json',
);

const adOrphan: OrphanCleanupInput = {
  driftId: 'drift-ad',
  targetSystem: 'ad',
  externalId: '33221100-5544-7766-8899-aabbccddeeff',
  accountIdentifier: 'old.admin@corp.example',
  tenantId: 'tenant-a',
};

describeTemporalE2E('orphanCleanupWorkflow never deletes an AD account (e2e)', () => {
  let harness: WorkflowTestHarness;
  const disableOrphanAccount = jest.fn();
  const setOrphanDisabledAt = jest.fn();
  const deleteOrphanAccount = jest.fn();
  const updateOrphanDriftStatus = jest.fn();
  const keepOrphanAccount = jest.fn();

  // Both grace periods pass (time skipping); the orphan config deletes afterwards
  const workers = (): Omit<WorkflowTestHarnessOptions, 'workflowsPath'> => ({
    activities: {
      getOrphanConfig: async () => ({
        gracePeriodDays: 1,
        extendedGraceDays: 1,
        autoDeleteAfterExtended: true,
      }),
      emitOrphanDetected: async () => undefined,
      confirmOrphan: async () => ({ orphan: true }),
      disableOrphanAccount: (...args: unknown[]) => disableOrphanAccount(...args),
      setOrphanDisabledAt: (...args: unknown[]) => setOrphanDisabledAt(...args),
      deleteOrphanAccount: (...args: unknown[]) => deleteOrphanAccount(...args),
      updateOrphanDriftStatus: (...args: unknown[]) => updateOrphanDriftStatus(...args),
      keepOrphanAccount: (...args: unknown[]) => keepOrphanAccount(...args),
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
    // As the activity answers for AD: refused
    deleteOrphanAccount
      .mockReset()
      .mockImplementation(async (system: string) =>
        system === 'ad' ? { success: false, error: AD_ORPHAN_KEPT_REASON } : { success: true },
      );
    updateOrphanDriftStatus.mockReset().mockResolvedValue(undefined);
    keepOrphanAccount.mockReset().mockResolvedValue(undefined);
  });

  it('keeps an AD orphan disabled and quarantined, with the reason on its drift', async () => {
    await harness.env.client.workflow.execute(orphanCleanupWorkflow, {
      args: [adOrphan],
      taskQueue: harness.taskQueue,
      workflowId: 'orphan-cleanup-e2e-ad-kept',
    });

    expect(disableOrphanAccount).toHaveBeenCalledWith('ad', 'old.admin@corp.example', 'tenant-a');
    expect(deleteOrphanAccount).not.toHaveBeenCalled();
    expect(updateOrphanDriftStatus).not.toHaveBeenCalled();
    expect(keepOrphanAccount).toHaveBeenCalledWith('drift-ad', AD_ORPHAN_KEPT_REASON, 'tenant-a');
  }, 60_000);

  it('deletes a SCIM orphan after the extended grace', async () => {
    await harness.env.client.workflow.execute(orphanCleanupWorkflow, {
      args: [{ ...adOrphan, driftId: 'drift-scim', targetSystem: 'scim' }],
      taskQueue: harness.taskQueue,
      workflowId: 'orphan-cleanup-e2e-scim-deleted',
    });

    expect(deleteOrphanAccount).toHaveBeenCalledWith(
      'scim',
      'old.admin@corp.example',
      'tenant-a',
      undefined,
      adOrphan.externalId,
    );
    expect(updateOrphanDriftStatus).toHaveBeenCalledWith(
      'drift-scim',
      'corrected',
      'DELETE',
      'auto-after-grace',
      'tenant-a',
    );
    expect(keepOrphanAccount).not.toHaveBeenCalled();
  }, 60_000);

  it('replays a history recorded before the ad-never-deleted patch', async () => {
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
          args: [adOrphan],
          taskQueue: pre.taskQueue,
          workflowId: 'orphan-cleanup-e2e-pre-ad-never-deleted',
        });
        await handle.result();
        // The pre-patch workflow tried the delete, which the activity refused
        expect(deleteOrphanAccount).toHaveBeenCalledTimes(1);
        fs.writeFileSync(PRE_PATCH_HISTORY, historyJSON(await handle.fetchHistory()));
      } finally {
        await pre.shutdown();
      }
    },
    120_000,
  );
});
