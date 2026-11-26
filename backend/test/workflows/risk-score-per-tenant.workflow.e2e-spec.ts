/**
 * riskScoreCalculationWorkflow per tenant, on the time-skipping Temporal test server. Opt-in via
 * TEMPORAL_E2E=1.
 *
 * One 30-minute activity with no heartbeat and 2 attempts scored every identity of every tenant:
 * past 30 minutes nothing was kept and the retry started over (r2-05 N6). Behind the patch
 * risk-score-calculation:per-tenant the workflow lists the tenants (listRiskScoreTenants) and
 * scores each in its own activity (runRiskScoreTenant), which heartbeats its offset and resumes
 * from it on a retry; after TENANTS_PER_RUN tenants it continues as new with the rest.
 *
 * Proves:
 *   - Each tenant is scored in its own activity with the run's time; the counts add up, a tenant
 *     that fails for good counts as one error and the others are still scored.
 *   - More tenants than one run takes continue as new, every tenant scored once, counts carried.
 *   - A history recorded before the patch (one runRiskScoreBatch for all tenants) still replays.
 *
 * Fixture test/fixtures/risk-score-calculation-pre-per-tenant.history.json was recorded with the
 * pre-patch workflow (commit 6e1dbf9d), from backend/:
 *   git show 6e1dbf9d:backend/src/workflows/risk-score-calculation.workflow.ts \
 *     > src/workflows/risk-score-calculation-pre-per-tenant.workflow.ts
 *   TEMPORAL_E2E=1 \
 *     RISK_FIXTURE_WORKFLOW=src/workflows/risk-score-calculation-pre-per-tenant.workflow.ts \
 *     npx jest -c test/jest-e2e.json risk-score-per-tenant -t 'records the pre-patch fixture'
 *   rm src/workflows/risk-score-calculation-pre-per-tenant.workflow.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { Worker } from '@temporalio/worker';
import { ApplicationFailure } from '@temporalio/common';
import {
  riskScoreCalculationWorkflow,
  TENANTS_PER_RUN,
} from '../../src/workflows/risk-score-calculation.workflow';
import {
  createWorkflowTestHarness,
  describeTemporalE2E,
  type WorkflowTestHarness,
} from '../helpers/workflow-test-env';
import { historyJSON } from '../helpers/history-json';

const WORKFLOWS_PATH = path.resolve(
  __dirname,
  '../../src/workflows/risk-score-calculation.workflow.ts',
);
const PRE_PATCH_HISTORY = path.resolve(
  __dirname,
  '../fixtures/risk-score-calculation-pre-per-tenant.history.json',
);

describeTemporalE2E('riskScoreCalculationWorkflow per tenant (e2e)', () => {
  let harness: WorkflowTestHarness;
  const listRiskScoreTenants = jest.fn();
  const runRiskScoreTenant = jest.fn();
  const runRiskScoreBatch = jest.fn();

  const activities = {
    listRiskScoreTenants: (...args: unknown[]) => listRiskScoreTenants(...args),
    runRiskScoreTenant: (...args: unknown[]) => runRiskScoreTenant(...args),
    runRiskScoreBatch: (...args: unknown[]) => runRiskScoreBatch(...args),
  };

  beforeAll(async () => {
    harness = await createWorkflowTestHarness({ workflowsPath: WORKFLOWS_PATH, activities });
  }, 120_000);

  afterAll(async () => {
    await harness?.shutdown();
  }, 30_000);

  beforeEach(() => {
    listRiskScoreTenants.mockReset();
    runRiskScoreTenant.mockReset();
    runRiskScoreBatch.mockReset().mockResolvedValue({ processed: 7, errors: 0 });
  });

  it('scores each tenant in its own activity and adds up the counts', async () => {
    listRiskScoreTenants.mockResolvedValue(['tenant-a', 'tenant-b', 'tenant-c']);
    runRiskScoreTenant.mockImplementation(async (tenantId: string) => {
      if (tenantId === 'tenant-b') {
        throw ApplicationFailure.nonRetryable('policy store unavailable', 'TestFailure');
      }
      return tenantId === 'tenant-a' ? { processed: 40, errors: 2 } : { processed: 10, errors: 0 };
    });

    const result = await harness.env.client.workflow.execute(riskScoreCalculationWorkflow, {
      args: [{ batchSize: 50 }],
      taskQueue: harness.taskQueue,
      workflowId: 'risk-score-e2e-per-tenant',
    });

    expect(result).toEqual({ processed: 50, errors: 3 });
    expect(listRiskScoreTenants).toHaveBeenCalledWith('');
    expect(runRiskScoreTenant.mock.calls.map(([tenantId]) => tenantId)).toEqual([
      'tenant-a',
      'tenant-b',
      'tenant-c',
    ]);
    const times = new Set(runRiskScoreTenant.mock.calls.map(([, nowIso]) => nowIso));
    expect(times.size).toBe(1);
    expect(runRiskScoreTenant.mock.calls[0][2]).toBe(50);
    expect(runRiskScoreBatch).not.toHaveBeenCalled();
  }, 60_000);

  it('continues as new after the tenants one run takes, scoring each tenant once', async () => {
    const tenants = Array.from({ length: TENANTS_PER_RUN + 3 }, (_, i) => `tenant-${i}`);
    listRiskScoreTenants.mockResolvedValue(tenants);
    runRiskScoreTenant.mockResolvedValue({ processed: 1, errors: 0 });

    const handle = await harness.env.client.workflow.start(riskScoreCalculationWorkflow, {
      args: [{}],
      taskQueue: harness.taskQueue,
      workflowId: 'risk-score-e2e-continue-as-new',
    });
    const result = await handle.result();

    expect(result).toEqual({ processed: tenants.length, errors: 0 });
    expect(runRiskScoreTenant.mock.calls.map(([tenantId]) => tenantId)).toEqual(tenants);
    expect(listRiskScoreTenants).toHaveBeenCalledTimes(1);
    const times = new Set(runRiskScoreTenant.mock.calls.map(([, nowIso]) => nowIso));
    expect(times.size).toBe(1);
    // The run that returned is a later one than the first
    const description = await handle.describe();
    expect(description.runId).not.toBe(handle.firstExecutionRunId);
  }, 60_000);

  it('replays a history recorded before the per-tenant patch', async () => {
    const history = JSON.parse(fs.readFileSync(PRE_PATCH_HISTORY, 'utf8'));
    await expect(
      Worker.runReplayHistory({ workflowsPath: WORKFLOWS_PATH }, history),
    ).resolves.toBeUndefined();
  }, 60_000);

  const fixtureWorkflow = process.env.RISK_FIXTURE_WORKFLOW;
  (fixtureWorkflow ? it : it.skip)(
    'records the pre-patch fixture (RISK_FIXTURE_WORKFLOW = the pre-patch workflow file)',
    async () => {
      const pre = await createWorkflowTestHarness({
        workflowsPath: path.resolve(process.cwd(), fixtureWorkflow ?? ''),
        activities,
      });
      try {
        const handle = await pre.env.client.workflow.start(riskScoreCalculationWorkflow, {
          args: [{ batchSize: 50 }],
          taskQueue: pre.taskQueue,
          workflowId: 'risk-score-e2e-pre-per-tenant',
        });
        // The pre-patch workflow scored every tenant in one activity
        expect(await handle.result()).toEqual({ processed: 7, errors: 0 });
        expect(runRiskScoreBatch).toHaveBeenCalledTimes(1);
        fs.writeFileSync(PRE_PATCH_HISTORY, historyJSON(await handle.fetchHistory()));
      } finally {
        await pre.shutdown();
      }
    },
    120_000,
  );
});
