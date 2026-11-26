/**
 * An edit that meets an open mover run, on the time-skipping Temporal test server with mocked
 * activities. Opt-in via TEMPORAL_E2E=1.
 *
 * One mover run per identity at a time (workflow id t-<tenant>-mover-<identityId>). Before the
 * patch mover:reevaluate-queued-edit an edit (PATCH /identity/:id) that met an open run was
 * logged and dropped, so its access change waited for the next HR sync (hunt 2026-11-25 03 F5).
 * Now MoverService signals the open run (reevaluate) and the run, once it has recorded its
 * outcome, continues as new with the queued edit: one more evaluation of the identity.
 *
 * Proves, for runs started now:
 *   - A run signalled while it works continues as new once: the next run has the queued fields
 *     and, as their "before", what the first run applied and the baseline values the edit sent.
 *   - Two signals during one run make one more evaluation, not two.
 *   - A run that fails still continues with the queued edit.
 *   - A run nobody signals ends as before.
 *   - A history recorded before the patch (with the signal, which the old code had no handler
 *     for) still replays.
 *
 * Fixture test/fixtures/mover-pre-reevaluate-queued-edit.history.json was recorded with the
 * pre-patch workflow (the tree before this patch), from backend/:
 *   TEMPORAL_E2E=1 MOVER_REEVALUATE_FIXTURE_WORKFLOW=src/workflows/mover.workflow.ts \
 *     npx jest -c test/jest-e2e.json mover-reevaluate -t 'records the pre-patch fixture'
 * (Against a later tree: copy the pre-patch mover.workflow.ts and mover-access.ts under other
 * names first.)
 */
import * as fs from 'fs';
import * as path from 'path';
import { WorkflowFailedError } from '@temporalio/client';
import { ApplicationFailure } from '@temporalio/common';
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
  '../fixtures/mover-pre-reevaluate-queued-edit.history.json',
);
/**
 * Recorded before the patch mover:queued-edit-query (final review ID3), with an edit queued, from
 * backend/:
 *   TEMPORAL_E2E=1 MOVER_QUEUED_EDIT_QUERY_FIXTURE_WORKFLOW=src/workflows/mover.workflow.ts \
 *     npx jest -c test/jest-e2e.json mover-reevaluate -t 'records the pre-query fixture'
 * (Against a later tree: copy the pre-patch mover.workflow.ts and mover-reevaluation.ts under
 * other names first.)
 */
const PRE_QUERY_HISTORY = path.resolve(
  __dirname,
  '../fixtures/mover-pre-queued-edit-query.history.json',
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

/** What the edit made during the run sends: the job title, its baseline value as "before". */
const queuedEdit = { changedFields: ['jobTitle'], previousAttributes: { jobTitle: 'Clerk' } };

describeTemporalE2E('mover workflow and an edit queued during a run (e2e)', () => {
  let harness: WorkflowTestHarness;
  const evaluateMoverChange = jest.fn();
  const applyMoverAccess = jest.fn();
  const recordMoverOutcome = jest.fn();
  /** Runs inside each evaluateMoverChange call, before it answers. */
  let duringEvaluation: (call: number) => Promise<void> = async () => undefined;

  const workers = (): Omit<WorkflowTestHarnessOptions, 'workflowsPath'> => ({
    taskQueue: 'provisioning-default',
    activities: {
      getPipelineStatus: async () => 'DEPLOYED',
      evaluateMoverChange: async (...args: unknown[]) => {
        const result = await evaluateMoverChange(...args);
        await duringEvaluation(evaluateMoverChange.mock.calls.length);
        return result;
      },
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
    evaluateMoverChange.mockReset().mockResolvedValue(EVALUATION);
    applyMoverAccess.mockReset().mockResolvedValue({ changed: 2, unchanged: 0 });
    recordMoverOutcome.mockReset().mockResolvedValue(undefined);
    duringEvaluation = async () => undefined;
  });

  const move = (h: WorkflowTestHarness, workflowId: string) =>
    h.env.client.workflow.start('moverWorkflow', {
      taskQueue: h.taskQueue,
      workflowId,
      args: [input],
    });

  /** Signals the run from inside its first evaluation, `times` times. */
  const queueDuringFirstEvaluation = (h: WorkflowTestHarness, workflowId: string, times = 1) => {
    duringEvaluation = async (call) => {
      if (call !== 1) return;
      for (let i = 0; i < times; i++) {
        await h.env.client.workflow.getHandle(workflowId).signal('reevaluate', queuedEdit);
      }
    };
  };

  const outcomes = () => recordMoverOutcome.mock.calls.map(([o]) => o as MoverOutcome);
  /** The input of each evaluation: [identityId, changedFields, previousAttributes, ...]. */
  const evaluated = () => evaluateMoverChange.mock.calls.map((call) => [call[1], call[2]]);

  it('evaluates once more with the queued edit after the run records its outcome', async () => {
    const workflowId = `t-${TENANT}-mover-queued-${Date.now()}`;
    queueDuringFirstEvaluation(harness, workflowId);

    const handle = await move(harness, workflowId);
    await handle.result();

    expect(evaluated()).toEqual([
      [['departmentName'], { departmentName: 'Sales' }],
      // The first run applied Engineering; the edit's job title keeps its baseline "before"
      [['departmentName', 'jobTitle'], { departmentName: 'Engineering', jobTitle: 'Clerk' }],
    ]);
    expect(outcomes().map((o) => o.status)).toEqual(['completed', 'completed']);
    expect(applyMoverAccess).toHaveBeenCalledTimes(2);
  }, 60_000);

  it('makes one more evaluation for two edits queued during one run', async () => {
    const workflowId = `t-${TENANT}-mover-queued-twice-${Date.now()}`;
    queueDuringFirstEvaluation(harness, workflowId, 2);

    await (await move(harness, workflowId)).result();

    expect(evaluateMoverChange).toHaveBeenCalledTimes(2);
  }, 60_000);

  it('continues with the queued edit after a failed run', async () => {
    const workflowId = `t-${TENANT}-mover-queued-failed-${Date.now()}`;
    queueDuringFirstEvaluation(harness, workflowId);
    applyMoverAccess.mockRejectedValueOnce(
      ApplicationFailure.nonRetryable('Entra ID refused', 'EntraChangesFailed'),
    );

    await (await move(harness, workflowId)).result();

    // Nothing was applied: the first run's fields keep their "before"
    expect(evaluated()[1]).toEqual([
      ['departmentName', 'jobTitle'],
      { departmentName: 'Sales', jobTitle: 'Clerk' },
    ]);
    expect(outcomes().map((o) => o.status)).toEqual(['failed', 'completed']);
  }, 60_000);

  it('ends as before when no edit is queued', async () => {
    applyMoverAccess.mockRejectedValueOnce(
      ApplicationFailure.nonRetryable('Entra ID refused', 'EntraChangesFailed'),
    );
    const handle = await move(harness, `t-${TENANT}-mover-not-queued-${Date.now()}`);

    await expect(handle.result()).rejects.toBeInstanceOf(WorkflowFailedError);
    expect(evaluateMoverChange).toHaveBeenCalledTimes(1);
  }, 60_000);

  it('replays a history recorded before the patch mover:reevaluate-queued-edit', async () => {
    const history = JSON.parse(fs.readFileSync(PRE_PATCH_HISTORY, 'utf8'));
    await expect(
      Worker.runReplayHistory({ workflowsPath: WORKFLOWS_PATH }, history),
    ).resolves.toBeUndefined();
  }, 60_000);

  // Final review ID3: the API asks this query before it queues an edit on an open run. A run whose
  // history predates the patch (or a worker of the old build) has no handler, and the API then
  // starts a run of its own after that one ends instead of queueing on it.
  it('answers acceptsQueuedEdits on a run started now (patch mover:queued-edit-query)', async () => {
    const workflowId = `t-${TENANT}-mover-accepts-${Date.now()}`;
    let accepts: unknown;
    duringEvaluation = async (call) => {
      if (call === 1) {
        accepts = await harness.env.client.workflow
          .getHandle(workflowId)
          .query('acceptsQueuedEdits');
      }
    };

    await (await move(harness, workflowId)).result();

    expect(accepts).toBe(true);
  }, 60_000);

  it('replays a history recorded before the patch mover:queued-edit-query', async () => {
    const history = JSON.parse(fs.readFileSync(PRE_QUERY_HISTORY, 'utf8'));
    await expect(
      Worker.runReplayHistory({ workflowsPath: WORKFLOWS_PATH }, history),
    ).resolves.toBeUndefined();
  }, 60_000);

  const preQueryWorkflow = process.env.MOVER_QUEUED_EDIT_QUERY_FIXTURE_WORKFLOW;
  (preQueryWorkflow ? it : it.skip)(
    'records the pre-query fixture (MOVER_QUEUED_EDIT_QUERY_FIXTURE_WORKFLOW = the pre-patch workflow file)',
    async () => {
      const pre = await createWorkflowTestHarness({
        workflowsPath: path.resolve(process.cwd(), preQueryWorkflow ?? ''),
        ...workers(),
      });
      try {
        const workflowId = `t-${TENANT}-mover-pre-queued-edit-query`;
        queueDuringFirstEvaluation(pre, workflowId);
        const handle = await move(pre, workflowId);
        await handle.result();
        // The first run of the chain: it continued as new with the queued edit
        const first = pre.env.client.workflow.getHandle(workflowId, handle.firstExecutionRunId);
        fs.writeFileSync(PRE_QUERY_HISTORY, historyJSON(await first.fetchHistory()));
      } finally {
        await pre.shutdown();
      }
    },
    120_000,
  );

  const fixtureWorkflow = process.env.MOVER_REEVALUATE_FIXTURE_WORKFLOW;
  (fixtureWorkflow ? it : it.skip)(
    'records the pre-patch fixture (MOVER_REEVALUATE_FIXTURE_WORKFLOW = the pre-patch workflow file)',
    async () => {
      const pre = await createWorkflowTestHarness({
        workflowsPath: path.resolve(process.cwd(), fixtureWorkflow ?? ''),
        ...workers(),
      });
      try {
        const workflowId = `t-${TENANT}-mover-pre-reevaluate`;
        queueDuringFirstEvaluation(pre, workflowId);
        const handle = await move(pre, workflowId);
        await handle.result();
        // The pre-patch code has no handler: the signal is dropped, one evaluation
        expect(evaluateMoverChange).toHaveBeenCalledTimes(1);
        fs.writeFileSync(PRE_PATCH_HISTORY, historyJSON(await handle.fetchHistory()));
      } finally {
        await pre.shutdown();
      }
    },
    120_000,
  );
});
