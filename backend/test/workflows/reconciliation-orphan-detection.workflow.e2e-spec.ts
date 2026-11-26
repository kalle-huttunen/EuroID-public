/**
 * dailyReconciliationWorkflow and orphan detection, on the time-skipping Temporal test server.
 * Opt-in via TEMPORAL_E2E=1.
 *
 * runOrphanDetection ran under the run's 5-minute proxy with no heartbeat while it listed every
 * account of a system, and a failure only logged "Orphan detection failed" (r2-05 N11). Behind
 * the patch reconciliation:orphan-detection-heartbeat it runs under its own proxy (2 hours per
 * attempt, heartbeat timeout 2 minutes: the activity heartbeats after each page of accounts),
 * and a system whose detection fails is named with the error in the report's
 * orphanDetectionFailures.
 *
 * Proves:
 *   - A failed detection is in the run's report with its system and message; the other system's
 *     detection still runs.
 *   - The activity is scheduled with the 2-hour timeout and the 2-minute heartbeat timeout.
 *   - A history recorded before the patch (failure logged only) still replays.
 *
 * Fixture test/fixtures/reconciliation-pre-orphan-detection-heartbeat.history.json was recorded
 * with the pre-patch workflow (commit de4e2379), bundled with its children, from backend/:
 *   git show de4e2379:backend/src/workflows/reconciliation.workflow.ts \
 *     > src/workflows/reconciliation-pre-orphan-detection-heartbeat.workflow.ts
 *   printf '%s\n' "export * from './reconciliation-pre-orphan-detection-heartbeat.workflow';" \
 *     "export * from './reconcile-batch.workflow';" "export * from './orphan-cleanup.workflow';" \
 *     > src/workflows/reconciliation-pre-orphan-detection-heartbeat.entry.ts
 *   TEMPORAL_E2E=1 \
 *     RECON_FIXTURE_WORKFLOWS=src/workflows/reconciliation-pre-orphan-detection-heartbeat.entry.ts \
 *     npx jest -c test/jest-e2e.json reconciliation-orphan-detection \
 *     -t 'records the pre-patch fixture'
 *   rm src/workflows/reconciliation-pre-orphan-detection-heartbeat.workflow.ts \
 *     src/workflows/reconciliation-pre-orphan-detection-heartbeat.entry.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { Worker } from '@temporalio/worker';
import { ApplicationFailure } from '@temporalio/common';
import { temporal } from '@temporalio/proto';
import { dailyReconciliationWorkflow } from '../../src/workflows';
import type { ReconciliationConfig } from '../../src/workflows/workflow-types';
import {
  createWorkflowTestHarness,
  describeTemporalE2E,
  type WorkflowTestHarness,
  type WorkflowTestHarnessOptions,
} from '../helpers/workflow-test-env';
import { historyJSON } from '../helpers/history-json';

const WORKFLOWS_PATH = path.resolve(__dirname, '../../src/workflows/index.ts');
const PRE_PATCH_HISTORY = path.resolve(
  __dirname,
  '../fixtures/reconciliation-pre-orphan-detection-heartbeat.history.json',
);
// Child ids derive from the parent's, so the replay runs under the recorded workflow id.
const PRE_PATCH_WORKFLOW_ID = 'recon-e2e-pre-orphan-detection-heartbeat';

const TENANT = 'tenant-a';
const user = { _id: 'identity-1', email: 'ada@example.com' };
const AD_FAILURE = 'AD connector config is incomplete (empty: host)';

const config: ReconciliationConfig = {
  tenantId: TENANT,
  enabled: true,
  cronSchedule: '0 2 * * *',
  targetSystems: ['ad', 'entra-id'],
  autoCorrect: false,
  autoCorrectTypes: [],
  requireApprovalForDeletes: true,
  notifyOnDrift: false,
  maxDriftsBeforeAlert: 0,
  criticalDriftAlertThreshold: 0,
};

describeTemporalE2E('dailyReconciliationWorkflow orphan detection (e2e)', () => {
  let harness: WorkflowTestHarness;
  const runOrphanDetection = jest.fn();

  const workers = (): Omit<WorkflowTestHarnessOptions, 'workflowsPath'> => ({
    activities: {
      getWorkflowStartTime: async () => new Date('2026-11-26T00:00:00Z'),
      getReconciliationUserCount: async () => 1,
      getReconciliationBatchPlan: async () => [{ skip: 0, limit: 1, index: 0 }],
      fetchHubUsersPage: async () => ({ users: [user], nextPageToken: null }),
      detectUserDrift: async () => ({ email: user.email, hasDrift: false, drifts: [] }),
      runOrphanDetection: (...args: unknown[]) => runOrphanDetection(...args),
      updateDriftWorkflowId: async () => undefined,
      generateReport: async () => ({ reportId: 'report-1', tenantId: TENANT, drifts: [] }),
    },
  });

  beforeAll(async () => {
    harness = await createWorkflowTestHarness({ workflowsPath: WORKFLOWS_PATH, ...workers() });
  }, 120_000);

  afterAll(async () => {
    await harness?.shutdown();
  }, 30_000);

  beforeEach(() => {
    runOrphanDetection.mockReset().mockImplementation(async (system: string) => {
      if (system === 'ad') throw ApplicationFailure.nonRetryable(AD_FAILURE, 'ConfigIncomplete');
      return [];
    });
  });

  it('names a system whose detection failed in the report, and still runs the next one', async () => {
    const report = await harness.env.client.workflow.execute(dailyReconciliationWorkflow, {
      args: [config],
      taskQueue: harness.taskQueue,
      workflowId: 'recon-e2e-orphan-detection-failure',
    });

    expect(report.orphanDetectionFailures).toEqual([{ system: 'ad', error: AD_FAILURE }]);
    expect(runOrphanDetection.mock.calls.map(([system]) => system)).toEqual(['ad', 'entra-id']);
  }, 60_000);

  it('schedules detection with a timeout for a long listing and a heartbeat timeout', async () => {
    const handle = await harness.env.client.workflow.start(dailyReconciliationWorkflow, {
      args: [{ ...config, targetSystems: ['entra-id'] }],
      taskQueue: harness.taskQueue,
      workflowId: 'recon-e2e-orphan-detection-timeouts',
    });
    await handle.result();

    const { events } = await handle.fetchHistory();
    const scheduled = (events ?? [])
      .map((e) => e.activityTaskScheduledEventAttributes)
      .find((a) => a?.activityType?.name === 'runOrphanDetection');
    expect(Number(scheduled?.startToCloseTimeout?.seconds)).toBe(2 * 60 * 60);
    expect(Number(scheduled?.heartbeatTimeout?.seconds)).toBe(2 * 60);
  }, 60_000);

  it('replays a history recorded before the orphan detection patch', async () => {
    const history = JSON.parse(
      fs.readFileSync(PRE_PATCH_HISTORY, 'utf8'),
    ) as temporal.api.history.v1.IHistory;
    await expect(
      Worker.runReplayHistory({ workflowsPath: WORKFLOWS_PATH }, history, PRE_PATCH_WORKFLOW_ID),
    ).resolves.toBeUndefined();
  }, 60_000);

  const fixtureWorkflows = process.env.RECON_FIXTURE_WORKFLOWS;
  (fixtureWorkflows ? it : it.skip)(
    'records the pre-patch fixture (RECON_FIXTURE_WORKFLOWS = the pre-patch entry module)',
    async () => {
      const pre = await createWorkflowTestHarness({
        workflowsPath: path.resolve(process.cwd(), fixtureWorkflows ?? ''),
        ...workers(),
      });
      try {
        const handle = await pre.env.client.workflow.start(dailyReconciliationWorkflow, {
          args: [config],
          taskQueue: pre.taskQueue,
          workflowId: PRE_PATCH_WORKFLOW_ID,
        });
        // The pre-patch run only logged the failure
        const report = await handle.result();
        expect(report).not.toHaveProperty('orphanDetectionFailures');
        fs.writeFileSync(PRE_PATCH_HISTORY, historyJSON(await handle.fetchHistory()));
      } finally {
        await pre.shutdown();
      }
    },
    120_000,
  );
});
