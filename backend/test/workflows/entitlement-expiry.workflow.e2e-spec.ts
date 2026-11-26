/**
 * entitlementExpiryWorkflow's batches (patch entitlement-expiry:continue-past-failures), on the
 * time-skipping Temporal test server with a mocked runEntitlementExpiryCheck. Opt-in via
 * TEMPORAL_E2E=1.
 *
 * Proves:
 *   - A batch whose entries all failed does not end the run: the next batch reaches the
 *     identities after them (before the patch the run ended there, and the same failing entries
 *     filled the first batch of every hourly run). The failures are counted in the result.
 *   - The run ends at the first batch that neither deprovisions nor fails anything, and every
 *     batch gets the same time and batch size.
 *   - A history recorded by the pre-patch workflow, whose last batch reported failures, replays:
 *     the pre-patch history stops there, without the patch marker.
 *
 * Fixture: test/fixtures/entitlement-expiry-pre-continue-past-failures.history.json, recorded with
 * the pre-patch workflow (main 08fd38d4). To record it again, from backend/:
 *   git show 08fd38d4:backend/src/workflows/entitlement-expiry.workflow.ts \
 *     > src/workflows/entitlement-expiry-pre-failures.workflow.ts
 *   TEMPORAL_E2E=1 EXPIRY_FIXTURE_WORKFLOW=src/workflows/entitlement-expiry-pre-failures.workflow.ts \
 *     npx jest -c test/jest-e2e.json entitlement-expiry -t 'records the pre-patch fixture'
 *   rm src/workflows/entitlement-expiry-pre-failures.workflow.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { Worker } from '@temporalio/worker';
import type { EntitlementExpiryResult } from '../../src/workflows/entitlement-expiry.workflow';
import {
  createWorkflowTestHarness,
  describeTemporalE2E,
  type WorkflowTestHarness,
} from '../helpers/workflow-test-env';
import { historyJSON } from '../helpers/history-json';

const WORKFLOWS_PATH = path.resolve(
  __dirname,
  '../../src/workflows/entitlement-expiry.workflow.ts',
);
const FIXTURE = path.resolve(
  __dirname,
  '../fixtures/entitlement-expiry-pre-continue-past-failures.history.json',
);

type Batch = Partial<EntitlementExpiryResult>;
const batch = (over: Batch): Batch => ({
  processed: 0,
  failed: 0,
  expiringSoonCount: 0,
  expiringTomorrowCount: 0,
  ...over,
});

const runEntitlementExpiryCheck = jest.fn<Promise<Batch>, [string, string, number]>();
const activities = { runEntitlementExpiryCheck } as unknown as Record<
  string,
  (...args: unknown[]) => unknown
>;

/** The activity answers these batches in turn, then empty ones. */
function answer(batches: Batch[]) {
  runEntitlementExpiryCheck.mockReset();
  for (const b of batches) runEntitlementExpiryCheck.mockResolvedValueOnce(b);
  runEntitlementExpiryCheck.mockResolvedValue(batch({}));
}

type History = {
  events?: Array<{ markerRecordedEventAttributes?: { markerName?: string | null } | null }> | null;
};

/** True when the history recorded a patch marker (the workflow's only patch: continue-past-failures). */
function hasPatchMarker(history: History): boolean {
  return (history.events ?? []).some(
    (e) => e.markerRecordedEventAttributes?.markerName === 'core_patch',
  );
}

describeTemporalE2E('entitlement expiry workflow batches', () => {
  let harness: WorkflowTestHarness;
  let runs = 0;

  async function start(h: WorkflowTestHarness = harness, args: object = { batchSize: 2 }) {
    return h.env.client.workflow.start('entitlementExpiryWorkflow', {
      taskQueue: h.taskQueue,
      workflowId: `entitlement-expiry-test-${++runs}`,
      args: [args],
    });
  }

  beforeAll(async () => {
    harness = await createWorkflowTestHarness({ workflowsPath: WORKFLOWS_PATH, activities });
  }, 120_000);

  afterAll(async () => {
    await harness?.shutdown();
  });

  it('goes on past a batch whose entries all failed', async () => {
    answer([
      batch({ failed: 2 }),
      batch({ processed: 1, expiringSoonCount: 1 }),
      batch({ failed: 1 }),
    ]);

    const handle = await start();
    await expect(handle.result()).resolves.toEqual({
      processed: 1,
      failed: 3,
      expiringSoonCount: 1,
      expiringTomorrowCount: 0,
    });

    // Three batches with work, then one with none
    expect(runEntitlementExpiryCheck).toHaveBeenCalledTimes(4);
    const calls = runEntitlementExpiryCheck.mock.calls;
    const [tenantId, nowIso, limit] = calls[0];
    expect(calls.every((c) => c[0] === tenantId && c[1] === nowIso && c[2] === limit)).toBe(true);
    expect([tenantId, limit]).toEqual(['', 2]);
    expect(hasPatchMarker((await handle.fetchHistory()) as History)).toBe(true);
  }, 60_000);

  it('ends at the first batch that neither deprovisions nor fails anything', async () => {
    answer([batch({ processed: 3 }), batch({})]);

    const handle = await start(harness, { tenantId: 'tenant-a', batchSize: 50 });
    await expect(handle.result()).resolves.toMatchObject({ processed: 3, failed: 0 });
    expect(runEntitlementExpiryCheck).toHaveBeenCalledTimes(2);
    expect(runEntitlementExpiryCheck.mock.calls[0][0]).toBe('tenant-a');
  }, 60_000);

  it('replays a history recorded before the continue-past-failures patch', async () => {
    if (!fs.existsSync(FIXTURE)) {
      throw new Error(
        `Fixture pending: ${FIXTURE}. Record it with the workflow as of 08fd38d4 ` +
          '(see "records the pre-patch fixture" in this file).',
      );
    }
    const history = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    expect(hasPatchMarker(history)).toBe(false);
    await expect(
      Worker.runReplayHistory({ workflowsPath: WORKFLOWS_PATH }, history),
    ).resolves.toBeUndefined();
  }, 60_000);

  /**
   * The pre-patch workflow ends at the second batch (nothing deprovisioned) although it reported
   * failures, the activity of this branch on a pre-patch run. Replayed, the current code must
   * end there too: without the patch marker in the history it takes the old condition.
   */
  const fixtureWorkflow = process.env.EXPIRY_FIXTURE_WORKFLOW;
  (fixtureWorkflow ? it : it.skip)(
    'records the pre-patch fixture (EXPIRY_FIXTURE_WORKFLOW = the pre-patch workflow file)',
    async () => {
      answer([batch({ processed: 1 }), batch({ failed: 2 })]);
      const pre = await createWorkflowTestHarness({
        workflowsPath: path.resolve(process.cwd(), fixtureWorkflow ?? ''),
        activities,
      });
      try {
        const handle = await pre.env.client.workflow.start('entitlementExpiryWorkflow', {
          taskQueue: pre.taskQueue,
          workflowId: 'entitlement-expiry-pre-continue-past-failures',
          args: [{}],
        });
        await handle.result();
        expect(runEntitlementExpiryCheck).toHaveBeenCalledTimes(2);
        fs.writeFileSync(FIXTURE, historyJSON(await handle.fetchHistory()));
      } finally {
        await pre.shutdown();
      }
    },
    120_000,
  );
});
