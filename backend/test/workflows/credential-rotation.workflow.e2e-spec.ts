/**
 * credentialRotationWorkflow per tenant (patch credential-rotation:per-tenant), on the
 * time-skipping Temporal test server with mocked activities. Opt-in via TEMPORAL_E2E=1.
 *
 * Proves:
 *   - The schedule's run (no tenant named) lists the active tenants in one activity and runs each
 *     tenant in its own runCredentialRotationBatch call, so each tenant has its own 30-minute
 *     timeout and its own retries. Before the patch one call ran every tenant under one timeout,
 *     so a slow tenant could time out the call and every tenant after it.
 *   - A tenant whose call fails after its retry does not stop the tenants after it (a call that
 *     outlives its 30 minutes fails the same way; the time-skipping server does not move its clock
 *     while an activity runs, so that case is not run here); the run then fails, naming the
 *     tenant and the reason, so the schedule shows it.
 *   - A tenant the input names runs alone, without the listing.
 *   - A history recorded by the pre-patch workflow (one call with tenant '') replays: the
 *     pre-patch history has no patch marker and keeps the single call.
 *
 * Fixture: test/fixtures/credential-rotation-pre-per-tenant.history.json, recorded with the
 * pre-patch workflow (main 0aa851f9). To record it again, from backend/:
 *   git show 0aa851f9:backend/src/workflows/credential-rotation.workflow.ts \
 *     > src/workflows/credential-rotation-pre-per-tenant.workflow.ts
 *   TEMPORAL_E2E=1 ROTATION_FIXTURE_WORKFLOW=src/workflows/credential-rotation-pre-per-tenant.workflow.ts \
 *     npx jest -c test/jest-e2e.json credential-rotation -t 'records the pre-patch fixture'
 *   rm src/workflows/credential-rotation-pre-per-tenant.workflow.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { ApplicationFailure, WorkflowFailedError } from '@temporalio/client';
import { Worker } from '@temporalio/worker';
import type { CredentialRotationResult } from '../../src/workflows/credential-rotation.workflow';
import {
  createWorkflowTestHarness,
  describeTemporalE2E,
  type WorkflowTestHarness,
} from '../helpers/workflow-test-env';
import { historyJSON } from '../helpers/history-json';

const WORKFLOWS_PATH = path.resolve(
  __dirname,
  '../../src/workflows/credential-rotation.workflow.ts',
);
const FIXTURE = path.resolve(
  __dirname,
  '../fixtures/credential-rotation-pre-per-tenant.history.json',
);
const THIRTY_MINUTES_S = 30 * 60;

const counts = (over: Partial<CredentialRotationResult> = {}): CredentialRotationResult => ({
  rotated: 0,
  failed: 0,
  notified: 0,
  statusesUpdated: 0,
  observed: 0,
  unknown: 0,
  removed: 0,
  overdue: 0,
  ...over,
});

const listCredentialRotationTenants = jest.fn<Promise<string[]>, []>();
const runCredentialRotationBatch = jest.fn<
  Promise<CredentialRotationResult>,
  [string, string, number]
>();
const activities = {
  listCredentialRotationTenants,
  runCredentialRotationBatch,
} as unknown as Record<string, (...args: unknown[]) => unknown>;

type Duration = { seconds?: unknown } | null | undefined;
type History = {
  events?: Array<{
    markerRecordedEventAttributes?: { markerName?: string | null } | null;
    activityTaskScheduledEventAttributes?: {
      activityType?: { name?: string | null } | null;
      startToCloseTimeout?: Duration;
    } | null;
  }> | null;
};

/** True when the history recorded a patch marker (the workflow's only patch: per-tenant). */
function hasPatchMarker(history: History): boolean {
  return (history.events ?? []).some(
    (e) => e.markerRecordedEventAttributes?.markerName === 'core_patch',
  );
}

/** The activities the run scheduled, in order, each with its start-to-close timeout in seconds. */
function scheduled(history: History): Array<[string, number]> {
  return (history.events ?? [])
    .map((e) => e.activityTaskScheduledEventAttributes)
    .filter((a): a is NonNullable<typeof a> => !!a)
    .map((a) => [a.activityType?.name ?? '', Number(String(a.startToCloseTimeout?.seconds ?? 0))]);
}

describeTemporalE2E('credential rotation workflow per tenant', () => {
  let harness: WorkflowTestHarness;
  let runs = 0;

  function start(args: object = {}) {
    return harness.env.client.workflow.start('credentialRotationWorkflow', {
      taskQueue: harness.taskQueue,
      workflowId: `credential-rotation-test-${++runs}`,
      args: [args],
    });
  }

  beforeAll(async () => {
    harness = await createWorkflowTestHarness({ workflowsPath: WORKFLOWS_PATH, activities });
  }, 120_000);

  afterAll(async () => {
    await harness?.shutdown();
  }, 30_000);

  beforeEach(() => {
    listCredentialRotationTenants.mockReset();
    runCredentialRotationBatch.mockReset();
  });

  it('lists the active tenants, then runs each in its own call with its own timeout', async () => {
    listCredentialRotationTenants.mockResolvedValue(['tenant-a', 'tenant-b']);
    runCredentialRotationBatch.mockImplementation(async (tenantId) =>
      tenantId === 'tenant-a'
        ? counts({ notified: 1, statusesUpdated: 2, observed: 5, unknown: 1, overdue: 1 })
        : counts({ notified: 2, statusesUpdated: 1, observed: 3, removed: 1 }),
    );

    const handle = await start();
    await expect(handle.result()).resolves.toEqual(
      counts({ notified: 3, statusesUpdated: 3, observed: 8, unknown: 1, removed: 1, overdue: 1 }),
    );

    const calls = runCredentialRotationBatch.mock.calls;
    expect(calls.map(([tenantId, , batchSize]) => [tenantId, batchSize])).toEqual([
      ['tenant-a', 50],
      ['tenant-b', 50],
    ]);
    expect(calls[1][1]).toBe(calls[0][1]); // one workflow time for the whole run
    const history = (await handle.fetchHistory()) as History;
    expect(hasPatchMarker(history)).toBe(true);
    expect(scheduled(history)).toEqual([
      ['listCredentialRotationTenants', expect.any(Number)],
      ['runCredentialRotationBatch', THIRTY_MINUTES_S],
      ['runCredentialRotationBatch', THIRTY_MINUTES_S],
    ]);
  }, 60_000);

  it('runs the tenants after a failing one, then fails naming it and the reason', async () => {
    listCredentialRotationTenants.mockResolvedValue(['tenant-a', 'tenant-b', 'tenant-c']);
    runCredentialRotationBatch.mockImplementation(async (tenantId) => {
      if (tenantId === 'tenant-b') throw new Error('credential_inventory unavailable');
      return counts({ observed: 1 });
    });

    const handle = await start();
    const error = await handle.result().catch((e: unknown) => e);

    // tenant-b retried once (SCHEDULED_SYNC_RETRY), tenant-c still run
    expect(runCredentialRotationBatch.mock.calls.map(([tenantId]) => tenantId)).toEqual([
      'tenant-a',
      'tenant-b',
      'tenant-b',
      'tenant-c',
    ]);
    expect(error).toBeInstanceOf(WorkflowFailedError);
    const cause = (error as WorkflowFailedError).cause as ApplicationFailure;
    expect(cause).toBeInstanceOf(ApplicationFailure);
    expect(cause.nonRetryable).toBe(true);
    expect(cause.message).toBe(
      'The credential run failed for 1 of 3 tenant(s): tenant-b (credential_inventory unavailable)',
    );
  }, 60_000);

  it('runs a tenant the input names alone, without listing the tenants', async () => {
    runCredentialRotationBatch.mockResolvedValue(counts({ observed: 4 }));

    const handle = await start({ tenantId: 'tenant-a', batchSize: 10 });
    await expect(handle.result()).resolves.toEqual(counts({ observed: 4 }));

    expect(listCredentialRotationTenants).not.toHaveBeenCalled();
    expect(runCredentialRotationBatch.mock.calls.map(([t, , size]) => [t, size])).toEqual([
      ['tenant-a', 10],
    ]);
  }, 60_000);

  it('replays a history recorded before the per-tenant patch', async () => {
    if (!fs.existsSync(FIXTURE)) {
      throw new Error(
        `Fixture pending: ${FIXTURE}. Record it with the workflow as of 0aa851f9 ` +
          '(see "records the pre-patch fixture" in this file).',
      );
    }
    const history = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    expect(hasPatchMarker(history)).toBe(false);
    expect(scheduled(history).map(([name]) => name)).toEqual(['runCredentialRotationBatch']);
    await expect(
      Worker.runReplayHistory({ workflowsPath: WORKFLOWS_PATH }, history),
    ).resolves.toBeUndefined();
  }, 60_000);

  /**
   * The pre-patch workflow as the schedule starts it ({}): one runCredentialRotationBatch call
   * with tenant '' (every active tenant inside the activity). Replayed, the current code must make
   * that one call too: without the patch marker in the history it takes the old path.
   */
  const fixtureWorkflow = process.env.ROTATION_FIXTURE_WORKFLOW;
  (fixtureWorkflow ? it : it.skip)(
    'records the pre-patch fixture (ROTATION_FIXTURE_WORKFLOW = the pre-patch workflow file)',
    async () => {
      runCredentialRotationBatch.mockResolvedValue(counts({ notified: 1, observed: 3 }));
      const pre = await createWorkflowTestHarness({
        workflowsPath: path.resolve(process.cwd(), fixtureWorkflow ?? ''),
        activities,
      });
      try {
        const handle = await pre.env.client.workflow.start('credentialRotationWorkflow', {
          taskQueue: pre.taskQueue,
          workflowId: 'credential-rotation-pre-per-tenant',
          args: [{}],
        });
        await expect(handle.result()).resolves.toEqual(counts({ notified: 1, observed: 3 }));
        expect(runCredentialRotationBatch.mock.calls.map(([t, , size]) => [t, size])).toEqual([
          ['', 50],
        ]);
        fs.writeFileSync(FIXTURE, historyJSON(await handle.fetchHistory()));
      } finally {
        await pre.shutdown();
      }
    },
    120_000,
  );
});
