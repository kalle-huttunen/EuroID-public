/**
 * End-to-end test for risk-score-calculation workflow using a real
 * (time-skipping) Temporal test server. Opt-in via TEMPORAL_E2E=1.
 *
 * Proves:
 *   - Workflow completes under the real SDK (no deterministic replay issue).
 *   - Activity inputs match what the workflow sends (tenantId, nowIso, batchSize): since the
 *     patch risk-score-calculation:per-tenant the named tenant is listed and scored in its own
 *     activity (risk-score-per-tenant.workflow.e2e-spec.ts covers more tenants and the replay).
 *   - Return shape matches the declared interface.
 */
import * as path from 'path';
import { riskScoreCalculationWorkflow } from '../../src/workflows/risk-score-calculation.workflow';
import {
  createWorkflowTestHarness,
  describeTemporalE2E,
  type WorkflowTestHarness,
} from '../helpers/workflow-test-env';

describeTemporalE2E('riskScoreCalculationWorkflow (e2e)', () => {
  let harness: WorkflowTestHarness;
  let listRiskScoreTenants: jest.Mock;
  let runRiskScoreTenant: jest.Mock;

  beforeAll(async () => {
    listRiskScoreTenants = jest.fn(async (tenantId: string) => [tenantId]);
    runRiskScoreTenant = jest.fn().mockResolvedValue({ processed: 42, errors: 1 });
    harness = await createWorkflowTestHarness({
      workflowsPath: path.resolve(
        __dirname,
        '../../src/workflows/risk-score-calculation.workflow.ts',
      ),
      activities: { listRiskScoreTenants, runRiskScoreTenant },
    });
  }, 120_000);

  afterAll(async () => {
    await harness?.shutdown();
  }, 30_000);

  it('runs the workflow end-to-end and returns the aggregated result', async () => {
    const result = await harness.env.client.workflow.execute(riskScoreCalculationWorkflow, {
      args: [{ tenantId: 'tenant-xyz', batchSize: 50 }],
      taskQueue: harness.taskQueue,
      workflowId: `risk-score-${Date.now()}`,
    });

    expect(result).toEqual({ processed: 42, errors: 1 });
    expect(listRiskScoreTenants).toHaveBeenCalledWith('tenant-xyz');
    expect(runRiskScoreTenant).toHaveBeenCalledTimes(1);
    const [tenantId, nowIso, batchSize] = runRiskScoreTenant.mock.calls[0];
    expect(tenantId).toBe('tenant-xyz');
    expect(batchSize).toBe(50);
    expect(typeof nowIso).toBe('string');
    expect(() => new Date(nowIso).toISOString()).not.toThrow();
  }, 60_000);
});
