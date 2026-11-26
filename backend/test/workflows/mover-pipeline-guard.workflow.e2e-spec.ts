/**
 * The mover workflow and the tenant's provisioning pipeline status, on the time-skipping Temporal
 * test server with mocked activities. Opt-in via TEMPORAL_E2E=1.
 *
 * Before the patch mover:pipeline-guard-deployed the guard skipped a run only while the pipeline
 * was PAUSED or STOPPED, so a pipeline never deployed (DRAFT, or SIMULATED after an impact
 * analysis, also one an impact analysis moved there from DEPLOYED) changed access in the target
 * systems.
 *
 * Proves, for runs started now:
 *   - Only a DEPLOYED pipeline changes access. PAUSED, STOPPED, DRAFT and SIMULATED skip the run
 *     before the policies are evaluated, and the outcome (status skipped) says why.
 *   - A DEPLOYED pipeline changes access as before.
 *   - A history recorded before the patch (DRAFT: the access was changed) still replays.
 *
 * Fixture test/fixtures/mover-pre-pipeline-guard-deployed.history.json was recorded with the
 * pre-patch workflow (commit 9f3c929c), from backend/:
 *   git show 9f3c929c:backend/src/workflows/mover.workflow.ts \
 *     | sed "s#'./mover-access'#'./mover-access-pre-guard'#" > src/workflows/mover-pre-guard.workflow.ts
 *   git show 9f3c929c:backend/src/workflows/mover-access.ts > src/workflows/mover-access-pre-guard.ts
 *   TEMPORAL_E2E=1 MOVER_GUARD_FIXTURE_WORKFLOW=src/workflows/mover-pre-guard.workflow.ts \
 *     npx jest -c test/jest-e2e.json mover-pipeline-guard -t 'records the pre-patch fixture'
 *   rm src/workflows/mover-pre-guard.workflow.ts src/workflows/mover-access-pre-guard.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { Worker } from '@temporalio/worker';
import { QUEUE_NAMES } from '../../src/infrastructure/temporal/task-queue.config';
import type { MoverEvaluation, MoverOutcome } from '../../src/shared/types/mover';
import type { MoverWorkflowInput } from '../../src/workflows/mover.workflow';
import { historyJSON } from '../helpers/history-json';
import {
  createWorkflowTestHarness,
  describeTemporalE2E,
  type WorkflowTestHarness,
  type WorkflowTestHarnessOptions,
} from '../helpers/workflow-test-env';

const WORKFLOWS_PATH = path.resolve(__dirname, '../../src/workflows/mover.workflow.ts');
const PRE_PATCH_HISTORY = path.resolve(
  __dirname,
  '../fixtures/mover-pre-pipeline-guard-deployed.history.json',
);
const TENANT = 'tenant-a';

const EVALUATION: MoverEvaluation = {
  applied: { departmentName: 'Engineering' },
  toAdd: [{ type: 'group', action: 'add', target: 'entra-id', targetId: 'g-eng' }],
  toRemove: [{ type: 'group', action: 'remove', target: 'entra-id', targetId: 'g-sales' }],
  operationCounts: { before: 1, after: 1 },
  provisionedSystems: ['entra'],
};

const input: MoverWorkflowInput = {
  identityId: 'id-1',
  tenantId: TENANT,
  changedFields: ['departmentName'],
  previousAttributes: { departmentName: 'Sales' },
  trigger: 'attribute-change',
};

describeTemporalE2E('mover workflow and the pipeline status (e2e)', () => {
  let harness: WorkflowTestHarness;
  let pipelineStatus = 'DEPLOYED';
  const evaluateMoverChange = jest.fn();
  const applyMoverAccess = jest.fn();
  const recordMoverOutcome = jest.fn();

  const workers = (): Omit<WorkflowTestHarnessOptions, 'workflowsPath'> => ({
    taskQueue: 'provisioning-default',
    activities: {
      getPipelineStatus: async () => pipelineStatus,
      evaluateMoverChange: (...args: unknown[]) => evaluateMoverChange(...args),
      getActiveTargetSystems: async () => ['entra'],
      setProvisioningStatus: async () => undefined,
      recordMoverOutcome: (...args: unknown[]) => recordMoverOutcome(...args),
    },
    queueWorkers: [
      {
        taskQueue: QUEUE_NAMES['entra'],
        activities: { applyMoverAccess: (...args: unknown[]) => applyMoverAccess(...args) },
      },
    ],
  });

  beforeAll(async () => {
    harness = await createWorkflowTestHarness({ workflowsPath: WORKFLOWS_PATH, ...workers() });
  }, 120_000);

  afterAll(async () => {
    await harness?.shutdown();
  }, 30_000);

  beforeEach(() => {
    pipelineStatus = 'DEPLOYED';
    evaluateMoverChange.mockReset().mockResolvedValue(EVALUATION);
    applyMoverAccess.mockReset().mockResolvedValue({ changed: 2, unchanged: 0 });
    recordMoverOutcome.mockReset().mockResolvedValue(undefined);
  });

  const move = (h: WorkflowTestHarness, workflowId: string) =>
    h.env.client.workflow.start('moverWorkflow', {
      taskQueue: h.taskQueue,
      workflowId,
      args: [input],
    });

  const outcome = (): MoverOutcome => recordMoverOutcome.mock.calls[0][0] as MoverOutcome;

  it.each([
    ['PAUSED', 'The provisioning pipeline is paused.'],
    ['STOPPED', 'The provisioning pipeline is stopped.'],
    ['DRAFT', 'The provisioning pipeline is not deployed (DRAFT).'],
    ['SIMULATED', 'The provisioning pipeline is not deployed (SIMULATED).'],
  ])('changes no access while the pipeline is %s', async (status, reason) => {
    pipelineStatus = status;

    const handle = await move(harness, `t-${TENANT}-mover-guard-${status.toLowerCase()}`);
    await expect(handle.result()).resolves.toBe(`Mover skipped: pipeline ${status}`);

    expect(evaluateMoverChange).not.toHaveBeenCalled();
    expect(applyMoverAccess).not.toHaveBeenCalled();
    expect(outcome()).toMatchObject({ status: 'skipped', reason });
  }, 60_000);

  it('changes access while the pipeline is DEPLOYED', async () => {
    const handle = await move(harness, `t-${TENANT}-mover-guard-deployed`);
    await handle.result();

    expect(applyMoverAccess).toHaveBeenCalledTimes(1);
    expect(outcome()).toMatchObject({ status: 'completed' });
  }, 60_000);

  it('replays a history recorded before the patch mover:pipeline-guard-deployed', async () => {
    const history = JSON.parse(fs.readFileSync(PRE_PATCH_HISTORY, 'utf8'));
    await expect(
      Worker.runReplayHistory({ workflowsPath: WORKFLOWS_PATH }, history),
    ).resolves.toBeUndefined();
  }, 60_000);

  const fixtureWorkflow = process.env.MOVER_GUARD_FIXTURE_WORKFLOW;
  (fixtureWorkflow ? it : it.skip)(
    'records the pre-patch fixture (MOVER_GUARD_FIXTURE_WORKFLOW = the pre-patch workflow file)',
    async () => {
      pipelineStatus = 'DRAFT';
      const pre = await createWorkflowTestHarness({
        workflowsPath: path.resolve(process.cwd(), fixtureWorkflow ?? ''),
        ...workers(),
      });
      try {
        const handle = await move(pre, `t-${TENANT}-mover-pre-guard`);
        await handle.result();
        // The pre-patch code: a DRAFT pipeline changes the access
        expect(applyMoverAccess).toHaveBeenCalledTimes(1);
        fs.writeFileSync(PRE_PATCH_HISTORY, historyJSON(await handle.fetchHistory()));
      } finally {
        await pre.shutdown();
      }
    },
    120_000,
  );
});
