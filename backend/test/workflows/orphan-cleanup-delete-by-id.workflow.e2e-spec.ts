/**
 * orphanCleanupWorkflow deletes an orphan by the id its drift holds, on the time-skipping Temporal
 * test server. Opt-in via TEMPORAL_E2E=1.
 *
 * A SCIM orphan was found for its delete by its accountIdentifier (userName or email) only, never
 * by the SCIM id detection recorded as the drift's externalId, so a SCIM user without such a match
 * was not deleted and its drift stayed quarantined (HX-F2 follow-up). Behind the patch
 * orphan-cleanup:delete-by-external-id the cleanup passes externalId to deleteOrphanAccount, and
 * the activity deletes a SCIM user by it (orphan.activities.ts). A cleanup started before the
 * patch passes none, and the activity falls back to the identifier.
 *
 * Proves:
 *   - The delete after the extended grace gets the drift's external id.
 *   - A history recorded before the patch still replays.
 *
 * Fixture test/fixtures/orphan-cleanup-pre-delete-by-external-id.history.json was recorded with
 * the pre-patch workflow (commit a19a0505), from backend/:
 *   git show a19a0505:backend/src/workflows/orphan-cleanup.workflow.ts \
 *     > src/workflows/orphan-cleanup-pre-delete-by-external-id.workflow.ts
 *   TEMPORAL_E2E=1 \
 *     ORPHAN_FIXTURE_WORKFLOW=src/workflows/orphan-cleanup-pre-delete-by-external-id.workflow.ts \
 *     npx jest -c test/jest-e2e.json orphan-cleanup-delete-by-id -t 'records the pre-patch fixture'
 *   rm src/workflows/orphan-cleanup-pre-delete-by-external-id.workflow.ts
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
  '../fixtures/orphan-cleanup-pre-delete-by-external-id.history.json',
);

const scimOrphan: OrphanCleanupInput = {
  driftId: 'drift-scim',
  targetSystem: 'scim',
  externalId: '2819c223-7f76-453a-919d-413861904646',
  accountIdentifier: 'old.contractor@corp.example',
  tenantId: 'tenant-a',
};

describeTemporalE2E('orphanCleanupWorkflow deletes by the external id (e2e)', () => {
  let harness: WorkflowTestHarness;
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
      confirmOrphan: async () => ({ orphan: true }),
      disableOrphanAccount: async () => true,
      setOrphanDisabledAt: async () => undefined,
      deleteOrphanAccount: (...args: unknown[]) => deleteOrphanAccount(...args),
      updateOrphanDriftStatus: (...args: unknown[]) => updateOrphanDriftStatus(...args),
      keepOrphanAccount: async () => undefined,
    },
  });

  beforeAll(async () => {
    harness = await createWorkflowTestHarness({ workflowsPath: WORKFLOWS_PATH, ...workers() });
  }, 120_000);

  afterAll(async () => {
    await harness?.shutdown();
  }, 30_000);

  beforeEach(() => {
    deleteOrphanAccount.mockReset().mockResolvedValue({ success: true });
    updateOrphanDriftStatus.mockReset().mockResolvedValue(undefined);
  });

  it('deletes a SCIM orphan after the extended grace by the SCIM id its drift holds', async () => {
    await harness.env.client.workflow.execute(orphanCleanupWorkflow, {
      args: [scimOrphan],
      taskQueue: harness.taskQueue,
      workflowId: 'orphan-cleanup-e2e-delete-by-external-id',
    });

    expect(deleteOrphanAccount).toHaveBeenCalledWith(
      'scim',
      'old.contractor@corp.example',
      'tenant-a',
      undefined,
      '2819c223-7f76-453a-919d-413861904646',
    );
    expect(updateOrphanDriftStatus).toHaveBeenCalledWith(
      'drift-scim',
      'corrected',
      'DELETE',
      'auto-after-grace',
      'tenant-a',
    );
  }, 60_000);

  it('replays a history recorded before the delete-by-external-id patch', async () => {
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
          args: [scimOrphan],
          taskQueue: pre.taskQueue,
          workflowId: 'orphan-cleanup-e2e-pre-delete-by-external-id',
        });
        await handle.result();
        // The pre-patch workflow deleted by the identifier alone
        expect(deleteOrphanAccount).toHaveBeenCalledWith(
          'scim',
          'old.contractor@corp.example',
          'tenant-a',
        );
        fs.writeFileSync(PRE_PATCH_HISTORY, historyJSON(await handle.fetchHistory()));
      } finally {
        await pre.shutdown();
      }
    },
    120_000,
  );
});
