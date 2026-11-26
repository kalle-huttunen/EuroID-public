/**
 * reconcileBatchWorkflow and leaver containment, on the time-skipping Temporal test server.
 * Opt-in via TEMPORAL_E2E=1.
 *
 * Every STATUS_MISMATCH was CRITICAL and not auto-correctable, and the batch corrects no CRITICAL
 * drift, so a TERMINATED identity's account still enabled in a target was never disabled by a run
 * (package H report). Detection now marks the disable direction auto-correctable; behind the
 * patch reconcile-batch:status-containment the batch corrects it although it is CRITICAL. The
 * enable direction grants access and stays with a person.
 *
 * Proves:
 *   - The leaver's account is disabled, the enable is left open, both drifts are reported.
 *   - A history recorded before the patch (the same drifts, nothing corrected) still replays.
 *
 * Fixture test/fixtures/reconcile-batch-pre-status-containment.history.json was recorded with the
 * pre-patch workflow (commit 37375def), from backend/:
 *   git show 37375def:backend/src/workflows/reconcile-batch.workflow.ts \
 *     > src/workflows/reconcile-batch-pre-status-containment.workflow.ts
 *   TEMPORAL_E2E=1 \
 *     BATCH_FIXTURE_WORKFLOW=src/workflows/reconcile-batch-pre-status-containment.workflow.ts \
 *     npx jest -c test/jest-e2e.json reconcile-batch-status-containment \
 *     -t 'records the pre-patch fixture'
 *   rm src/workflows/reconcile-batch-pre-status-containment.workflow.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { Worker } from '@temporalio/worker';
import { reconcileBatchWorkflow } from '../../src/workflows/reconcile-batch.workflow';
import {
  DriftType,
  type ReconciliationConfig,
  type SystemDrift,
} from '../../src/workflows/workflow-types';
import {
  createWorkflowTestHarness,
  describeTemporalE2E,
  type WorkflowTestHarness,
  type WorkflowTestHarnessOptions,
} from '../helpers/workflow-test-env';
import { historyJSON } from '../helpers/history-json';

const WORKFLOWS_PATH = path.resolve(__dirname, '../../src/workflows/reconcile-batch.workflow.ts');
const PRE_PATCH_HISTORY = path.resolve(
  __dirname,
  '../fixtures/reconcile-batch-pre-status-containment.history.json',
);

const TENANT = 'tenant-a';
const leaver = { _id: 'identity-2', email: 'grace@example.com', status: 'TERMINATED' };
const joiner = { _id: 'identity-3', email: 'alan@example.com', status: 'ACTIVE' };

const statusDrift = (expectedValue: 'ENABLED' | 'DISABLED'): SystemDrift => ({
  system: 'entra-id',
  driftType: DriftType.STATUS_MISMATCH,
  field: 'status',
  expectedValue,
  actualValue: expectedValue === 'DISABLED' ? 'ENABLED' : 'DISABLED',
  description: `Account in entra-id expected ${expectedValue}`,
  severity: 'CRITICAL',
  autoCorrect: expectedValue === 'DISABLED',
});

/** What detectUserDrift finds per identity. */
const driftsOf: Record<string, SystemDrift[]> = {
  'identity-2': [statusDrift('DISABLED')],
  'identity-3': [statusDrift('ENABLED')],
};

const config: ReconciliationConfig = {
  tenantId: TENANT,
  targetSystems: ['entra-id'],
  autoCorrect: true,
  autoCorrectTypes: [DriftType.STATUS_MISMATCH],
  requireApprovalForDeletes: true,
  notifyOnDrift: false,
  maxDriftsBeforeAlert: 0,
  criticalDriftAlertThreshold: 0,
};

describeTemporalE2E('reconcileBatchWorkflow disables a leaver account (e2e)', () => {
  let harness: WorkflowTestHarness;
  const correctDrift = jest.fn();

  const workers = (): Omit<WorkflowTestHarnessOptions, 'workflowsPath'> => ({
    activities: {
      fetchHubUsersPage: async () => ({ users: [leaver, joiner], nextPageToken: null }),
      detectUserDrift: async (user: unknown) => {
        const identity = user as typeof leaver;
        return {
          userId: identity._id,
          email: identity.email,
          hasDrift: true,
          hubState: identity,
          drifts: driftsOf[identity._id],
          severity: 'CRITICAL',
          detectedAt: new Date('2026-11-26T00:00:00Z'),
        };
      },
      correctDrift: (...args: unknown[]) => correctDrift(...args),
    },
  });

  const run = (workflowId: string) =>
    harness.env.client.workflow.execute(reconcileBatchWorkflow, {
      args: [{ config, skip: 0, limit: 2, batchIndex: 0 }],
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
    correctDrift.mockReset().mockImplementation(async (d: SystemDrift) => ({
      driftId: d.driftType,
      system: d.system,
      action: 'DISABLE',
      success: true,
      executedAt: new Date('2026-11-26T00:00:00Z'),
    }));
  });

  it("disables the leaver's account and leaves the enable to a person", async () => {
    const result = await run('batch-e2e-status-containment');

    expect(correctDrift.mock.calls.map(([d, user]) => [(user as typeof leaver)._id, d])).toEqual([
      ['identity-2', expect.objectContaining({ expectedValue: 'DISABLED' })],
    ]);
    expect(result.corrections).toHaveLength(1);
    expect(result.drifts.flatMap((d) => d.drifts)).toHaveLength(2);
  }, 60_000);

  it('replays a history recorded before the status-containment patch', async () => {
    const history = JSON.parse(fs.readFileSync(PRE_PATCH_HISTORY, 'utf8'));
    await expect(
      Worker.runReplayHistory({ workflowsPath: WORKFLOWS_PATH }, history),
    ).resolves.toBeUndefined();
  }, 60_000);

  const fixtureWorkflow = process.env.BATCH_FIXTURE_WORKFLOW;
  (fixtureWorkflow ? it : it.skip)(
    'records the pre-patch fixture (BATCH_FIXTURE_WORKFLOW = the pre-patch workflow file)',
    async () => {
      const pre = await createWorkflowTestHarness({
        workflowsPath: path.resolve(process.cwd(), fixtureWorkflow ?? ''),
        ...workers(),
      });
      try {
        const handle = await pre.env.client.workflow.start(reconcileBatchWorkflow, {
          args: [{ config, skip: 0, limit: 2, batchIndex: 0 }],
          taskQueue: pre.taskQueue,
          workflowId: 'batch-e2e-pre-status-containment',
        });
        await handle.result();
        // The pre-patch workflow corrected no CRITICAL drift
        expect(correctDrift).not.toHaveBeenCalled();
        fs.writeFileSync(PRE_PATCH_HISTORY, historyJSON(await handle.fetchHistory()));
      } finally {
        await pre.shutdown();
      }
    },
    120_000,
  );
});
