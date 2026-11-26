/**
 * Drift thresholds of dailyReconciliationWorkflow, on the time-skipping Temporal test server.
 * Opt-in via TEMPORAL_E2E=1.
 *
 * The start body required maxDriftsBeforeAlert and criticalDriftAlertThreshold, and nothing read
 * them. Behind the patch reconciliation:drift-threshold-alerts the run counts the drifts it
 * gathered: a threshold it reached (0 = off) is named in the report's `alerts`, and with
 * notifyOnDrift the run calls notifyDriftThresholdExceeded once (the activity emits
 * reconciliation.drift_threshold_exceeded and mails notifyEmail).
 *
 * Proves:
 *   - Over both thresholds: one notification with the run's ids and the counts, both alerts in
 *     the report.
 *   - Under them, or with both at 0: no notification and no alerts.
 *   - notifyOnDrift off: the alerts are in the report, no notification.
 *   - A history recorded before the patch (over the thresholds, notifyOnDrift on) still replays.
 *
 * Fixture test/fixtures/reconciliation-pre-drift-threshold-alerts.history.json was recorded with
 * the pre-patch workflow (commit 488754d0), bundled with its children, from backend/:
 *   git show 488754d0:backend/src/workflows/reconciliation.workflow.ts \
 *     > src/workflows/reconciliation-pre-drift-threshold-alerts.workflow.ts
 *   printf '%s\n' "export * from './reconciliation-pre-drift-threshold-alerts.workflow';" \
 *     "export * from './reconcile-batch.workflow';" "export * from './orphan-cleanup.workflow';" \
 *     > src/workflows/reconciliation-pre-drift-threshold-alerts.entry.ts
 *   TEMPORAL_E2E=1 \
 *     RECON_FIXTURE_WORKFLOWS=src/workflows/reconciliation-pre-drift-threshold-alerts.entry.ts \
 *     npx jest -c test/jest-e2e.json reconciliation-drift-alerts -t 'records the pre-patch fixture'
 *   rm src/workflows/reconciliation-pre-drift-threshold-alerts.workflow.ts \
 *     src/workflows/reconciliation-pre-drift-threshold-alerts.entry.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { Worker } from '@temporalio/worker';
import { dailyReconciliationWorkflow } from '../../src/workflows';
import type { ReconciliationConfig, SystemDrift } from '../../src/workflows/workflow-types';
import {
  createWorkflowTestHarness,
  describeTemporalE2E,
  type WorkflowTestHarness,
  type WorkflowTestHarnessOptions,
} from '../helpers/workflow-test-env';
import { historyJSON } from '../helpers/history-json';

// The worker's entry module: it exports the children too, so they run on the same worker.
const WORKFLOWS_PATH = path.resolve(__dirname, '../../src/workflows/index.ts');
const PRE_PATCH_HISTORY = path.resolve(
  __dirname,
  '../fixtures/reconciliation-pre-drift-threshold-alerts.history.json',
);
// Child ids derive from the parent's, so the replay runs under the recorded workflow id.
const PRE_PATCH_WORKFLOW_ID = 'recon-e2e-pre-drift-threshold-alerts';

const TENANT = 'tenant-a';
const users = [
  { _id: 'identity-1', email: 'ada@example.com' },
  { _id: 'identity-2', email: 'grace@example.com' },
];

const drift = (severity: SystemDrift['severity'], field: string): SystemDrift =>
  ({
    system: 'entra-id',
    driftType: 'FIELD_MISMATCH',
    field,
    description: `Field "${field}" differs`,
    severity,
    autoCorrect: false,
  }) as SystemDrift;

/** Five drifts over two identities, two of them CRITICAL. */
const driftsOf: Record<string, SystemDrift[]> = {
  'identity-1': [drift('CRITICAL', 'email'), drift('LOW', 'jobTitle'), drift('MEDIUM', 'lastName')],
  'identity-2': [drift('CRITICAL', 'status'), drift('LOW', 'officeLocation')],
};

const config = (overrides: Partial<ReconciliationConfig>): ReconciliationConfig => ({
  tenantId: TENANT,
  enabled: true,
  cronSchedule: '0 2 * * *',
  targetSystems: ['entra-id'],
  autoCorrect: false,
  autoCorrectTypes: [],
  requireApprovalForDeletes: true,
  notifyOnDrift: true,
  notifyEmail: 'secops@example.com',
  maxDriftsBeforeAlert: 5,
  criticalDriftAlertThreshold: 2,
  ...overrides,
});

describeTemporalE2E('reconciliation drift thresholds (e2e)', () => {
  let harness: WorkflowTestHarness;
  const notifyDriftThresholdExceeded = jest.fn();

  const workers = (): Omit<WorkflowTestHarnessOptions, 'workflowsPath'> => ({
    activities: {
      getWorkflowStartTime: async () => new Date('2026-11-25T00:00:00Z'),
      getReconciliationUserCount: async () => 2,
      getReconciliationBatchPlan: async () => [{ skip: 0, limit: 2, index: 0 }],
      fetchHubUsersPage: async () => ({ users, nextPageToken: null }),
      detectUserDrift: async (user: unknown) => {
        const identity = user as (typeof users)[number];
        return {
          userId: identity._id,
          email: identity.email,
          hasDrift: true,
          hubState: identity,
          drifts: driftsOf[identity._id],
          severity: 'CRITICAL',
          detectedAt: new Date('2026-11-25T00:00:00Z'),
        };
      },
      runOrphanDetection: async () => [],
      updateDriftWorkflowId: async () => undefined,
      generateReport: async () => ({ reportId: 'report-1', tenantId: TENANT, drifts: [] }),
      notifyDriftThresholdExceeded: (...args: unknown[]) => notifyDriftThresholdExceeded(...args),
    },
  });

  const run = (workflowId: string, overrides: Partial<ReconciliationConfig> = {}) =>
    harness.env.client.workflow.execute(dailyReconciliationWorkflow, {
      args: [config(overrides)],
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
    notifyDriftThresholdExceeded.mockReset().mockResolvedValue(undefined);
  });

  const alerts = [
    { threshold: 'maxDriftsBeforeAlert', limit: 5, found: 5 },
    { threshold: 'criticalDriftAlertThreshold', limit: 2, found: 2 },
  ];

  it('notifies once with the counts and names both alerts in the report', async () => {
    const report = await run('recon-e2e-alerts-over');

    expect(notifyDriftThresholdExceeded).toHaveBeenCalledTimes(1);
    const [tenantId, notice] = notifyDriftThresholdExceeded.mock.calls[0];
    expect(tenantId).toBe(TENANT);
    expect(notice).toEqual({
      workflowId: 'recon-e2e-alerts-over',
      runId: expect.any(String),
      totalDrifts: 5,
      criticalDrifts: 2,
      alerts,
      notifyEmail: 'secops@example.com',
    });
    expect(report.alerts).toEqual(alerts);
  }, 60_000);

  it('raises nothing under the thresholds', async () => {
    const report = await run('recon-e2e-alerts-under', {
      maxDriftsBeforeAlert: 6,
      criticalDriftAlertThreshold: 3,
    });

    expect(notifyDriftThresholdExceeded).not.toHaveBeenCalled();
    expect(report.alerts).toBeUndefined();
  }, 60_000);

  it('raises nothing with both thresholds at 0', async () => {
    const report = await run('recon-e2e-alerts-off', {
      maxDriftsBeforeAlert: 0,
      criticalDriftAlertThreshold: 0,
    });

    expect(notifyDriftThresholdExceeded).not.toHaveBeenCalled();
    expect(report.alerts).toBeUndefined();
  }, 60_000);

  it('names the alerts without notifying when notifyOnDrift is off', async () => {
    const report = await run('recon-e2e-alerts-quiet', { notifyOnDrift: false });

    expect(notifyDriftThresholdExceeded).not.toHaveBeenCalled();
    expect(report.alerts).toEqual(alerts);
  }, 60_000);

  it('replays a history recorded before the drift-threshold-alerts patch', async () => {
    const history = JSON.parse(fs.readFileSync(PRE_PATCH_HISTORY, 'utf8'));
    await expect(
      Worker.runReplayHistory({ workflowsPath: WORKFLOWS_PATH }, history, PRE_PATCH_WORKFLOW_ID),
    ).resolves.toBeUndefined();
  }, 60_000);

  const fixtureWorkflows = process.env.RECON_FIXTURE_WORKFLOWS;
  (fixtureWorkflows ? it : it.skip)(
    'records the pre-patch fixture (RECON_FIXTURE_WORKFLOWS = entry of the pre-patch bundle)',
    async () => {
      const pre = await createWorkflowTestHarness({
        workflowsPath: path.resolve(process.cwd(), fixtureWorkflows ?? ''),
        ...workers(),
      });
      try {
        const handle = await pre.env.client.workflow.start(dailyReconciliationWorkflow, {
          args: [config({})],
          taskQueue: pre.taskQueue,
          workflowId: PRE_PATCH_WORKFLOW_ID,
        });
        await handle.result();
        // Over both thresholds, and the pre-patch run notified nobody
        expect(notifyDriftThresholdExceeded).not.toHaveBeenCalled();
        fs.writeFileSync(PRE_PATCH_HISTORY, historyJSON(await handle.fetchHistory()));
      } finally {
        await pre.shutdown();
      }
    },
    120_000,
  );
});
