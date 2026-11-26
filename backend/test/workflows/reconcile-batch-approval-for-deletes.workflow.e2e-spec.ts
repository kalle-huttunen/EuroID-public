/**
 * reconcileBatchWorkflow under requireApprovalForDeletes, on the time-skipping Temporal test
 * server. Opt-in via TEMPORAL_E2E=1.
 *
 * The reconciliation start body required requireApprovalForDeletes and nothing read it. Behind
 * the patch reconcile-batch:approval-for-deletes the flag holds what cannot be undone or takes
 * granted access away: the group and license corrections (GROUP_MISMATCH, LICENSE_MISMATCH) stay
 * open drifts for the Correct action (POST /reconciliation/drifts/:id/correct). A disable is the
 * reversible containment step and never waits for a person: a leaver's account still enabled in
 * a target (ORPHANED_USER, STATUS_MISMATCH against an identity that is not ACTIVE) is disabled at
 * once, flag or not.
 *
 * Proves:
 *   - With the flag, the add (MISSING_USER), the enable (STATUS_MISMATCH, identity ACTIVE) and
 *     the disables (ORPHANED_USER, STATUS_MISMATCH, identity TERMINATED) are corrected; the
 *     group and license corrections are not.
 *   - Without the flag every eligible drift is corrected, as before.
 *   - A history recorded before the patch (flag set, the disable corrected) still replays.
 *
 * Fixture test/fixtures/reconcile-batch-pre-approval-for-deletes.history.json was recorded with
 * the pre-patch workflow (commit 47200b7b), from backend/:
 *   git show 47200b7b:backend/src/workflows/reconcile-batch.workflow.ts \
 *     > src/workflows/reconcile-batch-pre-approval-for-deletes.workflow.ts
 *   TEMPORAL_E2E=1 \
 *     BATCH_FIXTURE_WORKFLOW=src/workflows/reconcile-batch-pre-approval-for-deletes.workflow.ts \
 *     npx jest -c test/jest-e2e.json reconcile-batch-approval-for-deletes \
 *     -t 'records the pre-patch fixture'
 *   rm src/workflows/reconcile-batch-pre-approval-for-deletes.workflow.ts
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
  '../fixtures/reconcile-batch-pre-approval-for-deletes.history.json',
);

const TENANT = 'tenant-a';
const active = { _id: 'identity-1', email: 'ada@example.com', status: 'ACTIVE' };
const leaver = { _id: 'identity-2', email: 'grace@example.com', status: 'TERMINATED' };

const drift = (driftType: DriftType, field?: string): SystemDrift => ({
  system: 'entra-id',
  driftType,
  ...(field ? { field } : {}),
  description: `${driftType} in entra-id`,
  severity: 'HIGH',
  autoCorrect: true,
});

/** What detectUserDrift finds per identity. */
const driftsOf: Record<string, SystemDrift[]> = {
  'identity-1': [
    drift(DriftType.MISSING_USER),
    drift(DriftType.STATUS_MISMATCH, 'status'),
    drift(DriftType.GROUP_MISMATCH),
    drift(DriftType.LICENSE_MISMATCH),
  ],
  'identity-2': [drift(DriftType.ORPHANED_USER), drift(DriftType.STATUS_MISMATCH, 'status')],
};

const config = (requireApprovalForDeletes: boolean): ReconciliationConfig => ({
  tenantId: TENANT,
  enabled: true,
  cronSchedule: '0 2 * * *',
  targetSystems: ['entra-id'],
  autoCorrect: true,
  autoCorrectTypes: Object.values(DriftType),
  requireApprovalForDeletes,
  notifyOnDrift: false,
  maxDriftsBeforeAlert: 0,
  criticalDriftAlertThreshold: 0,
});

describeTemporalE2E('reconcileBatchWorkflow holds removals for approval (e2e)', () => {
  let harness: WorkflowTestHarness;
  const correctDrift = jest.fn();

  const workers = (): Omit<WorkflowTestHarnessOptions, 'workflowsPath'> => ({
    activities: {
      fetchHubUsersPage: async () => ({ users: [active, leaver], nextPageToken: null }),
      detectUserDrift: async (user: unknown) => {
        const identity = user as typeof active;
        const drifts = driftsOf[identity._id];
        return {
          userId: identity._id,
          email: identity.email,
          hasDrift: true,
          hubState: identity,
          drifts,
          severity: 'HIGH',
          detectedAt: new Date('2026-11-25T00:00:00Z'),
        };
      },
      correctDrift: (...args: unknown[]) => correctDrift(...args),
    },
  });

  /** The corrected drifts as "<identity> <drift type>". */
  const corrected = () =>
    correctDrift.mock.calls.map(
      ([d, user]) => `${(user as typeof active)._id} ${(d as SystemDrift).driftType}`,
    );

  const run = (workflowId: string, requireApprovalForDeletes: boolean) =>
    harness.env.client.workflow.execute(reconcileBatchWorkflow, {
      args: [{ config: config(requireApprovalForDeletes), skip: 0, limit: 2, batchIndex: 0 }],
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
      action: 'UPDATE',
      success: true,
      executedAt: new Date('2026-11-25T00:00:00Z'),
    }));
  });

  it('corrects the add, the enable and the disables, and leaves group and license open', async () => {
    const result = await run('batch-e2e-approval-for-deletes', true);

    expect(corrected()).toEqual([
      'identity-1 MISSING_USER',
      'identity-1 STATUS_MISMATCH',
      'identity-2 ORPHANED_USER',
      'identity-2 STATUS_MISMATCH',
    ]);
    expect(result.corrections).toHaveLength(4);
    // Every drift is still reported: the held ones are the open drifts a person corrects
    expect(result.drifts.flatMap((d) => d.drifts)).toHaveLength(6);
  }, 60_000);

  it('corrects every eligible drift without the flag, as before', async () => {
    await run('batch-e2e-no-approval-for-deletes', false);

    expect(corrected()).toEqual([
      'identity-1 MISSING_USER',
      'identity-1 STATUS_MISMATCH',
      'identity-1 GROUP_MISMATCH',
      'identity-1 LICENSE_MISMATCH',
      'identity-2 ORPHANED_USER',
      'identity-2 STATUS_MISMATCH',
    ]);
  }, 60_000);

  it('replays a history recorded before the approval-for-deletes patch', async () => {
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
          args: [{ config: config(true), skip: 0, limit: 2, batchIndex: 0 }],
          taskQueue: pre.taskQueue,
          workflowId: 'batch-e2e-pre-approval-for-deletes',
        });
        await handle.result();
        // The pre-patch workflow corrected the removals despite the flag
        expect(corrected()).toContain('identity-2 ORPHANED_USER');
        fs.writeFileSync(PRE_PATCH_HISTORY, historyJSON(await handle.fetchHistory()));
      } finally {
        await pre.shutdown();
      }
    },
    120_000,
  );
});
