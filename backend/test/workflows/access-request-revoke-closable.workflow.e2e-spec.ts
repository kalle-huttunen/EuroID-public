/**
 * Access request approval: the removal at the end date that keeps failing can be closed by an
 * admin, and the retry loop continues as new, end to end on the time-skipping Temporal test
 * server. Opt-in via TEMPORAL_E2E=1. The real accessRequestApprovalWorkflow runs with mocked
 * activities; revokeAccessRequest answers as AccessRequestActivities.revokeAccessRequest does.
 *
 * Proves (HX-E2 follow-up, patch access-request-approval:revoke-closable-continue-as-new):
 *   - The REMOVED_MANUALLY signal (sent by POST /access-requests/:id/removed-manually after it
 *     closed the request EXPIRED) ends the retry loop at once: no further revoke, and no status
 *     write by the run. Before, nothing could end the loop but a removal that succeeded.
 *   - After REVOKE_ATTEMPTS_PER_RUN failed retries the run continues as new with the attempt
 *     count, keeps the 6-hour backoff and ends EXPIRED once the removal succeeds. Before, the
 *     history grew by one timer and one activity every 6 hours, forever.
 *   - A history recorded before the patch (failed revokes retried, then EXPIRED) replays.
 *   - A run that was already in the loop under the old code honours the signal at its next
 *     attempt once the worker runs the new code (only with CLOSABLE_FIXTURE_WORKFLOW set: it
 *     needs the pre-patch workflow file, see below).
 *
 * Fixture test/fixtures/access-request-pre-revoke-closable.history.json is recorded with the
 * workflow before the patch (as of commit df2b570b), written to a file of its own so the working
 * workflow file is never touched, from backend/:
 *   git show df2b570b:backend/src/workflows/access-request-approval.workflow.ts \
 *     > src/workflows/access-request-pre-revoke-closable.workflow.ts
 *   TEMPORAL_E2E=1 CLOSABLE_FIXTURE_WORKFLOW=src/workflows/access-request-pre-revoke-closable.workflow.ts \
 *     npx jest -c test/jest-e2e.json access-request-revoke-closable
 *   rm src/workflows/access-request-pre-revoke-closable.workflow.ts
 * With CLOSABLE_FIXTURE_WORKFLOW set the run records the fixture and also runs the old-run test.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Worker } from '@temporalio/worker';
import {
  accessRequestApprovalWorkflow,
  approvalDecisionSignal,
  removedManuallySignal,
} from '../../src/workflows/access-request-approval.workflow';
import { REVOKE_ATTEMPTS_PER_RUN } from '../../src/workflows/access-request-revoke-retry';
import {
  createTestWorkflowEnvironment,
  createWorkflowTestHarness,
  describeTemporalE2E,
  type WorkflowTestHarness,
  type WorkflowTestHarnessOptions,
} from '../helpers/workflow-test-env';
import { historyJSON } from '../helpers/history-json';
import { testDataConverter } from '../helpers/test-payload-codec';

const WORKFLOWS_PATH = path.resolve(
  __dirname,
  '../../src/workflows/access-request-approval.workflow.ts',
);
const PRE_CLOSABLE = path.resolve(
  __dirname,
  '../fixtures/access-request-pre-revoke-closable.history.json',
);
const TENANT = 'tenant-a';
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

const requestDoc = (expiresAt: Date) => ({
  requestId: 'req-1',
  status: 'PENDING_APPROVAL',
  requesterId: 'id-person',
  entitlements: [
    {
      catalogEntryId: 'cat-1',
      system: 'entra-id',
      nativeId: 'Approvers',
      entitlementType: 'Group',
    },
  ],
  approvalSteps: [{ stepOrder: 0, approverType: 'MANAGER', status: 'PENDING' }],
  timeConstraint: { requestedDurationDays: 1, expiresAt },
});

const FAILED = { success: false, failedSystems: ['entra-id'] };
const DONE = { success: true, failedSystems: [] };

describeTemporalE2E('access request approval: a failing removal closed or continued (e2e)', () => {
  let harness: WorkflowTestHarness;
  let request: ReturnType<typeof requestDoc>;
  /** What happened, in order: revoke answers and status writes. */
  let events: string[];
  const revokeAccessRequest = jest.fn();
  /** Called after each revoke answer, so a test can act once the run is in the loop. */
  let afterRevoke: () => void;

  const activities = (): WorkflowTestHarnessOptions['activities'] => ({
    getAccessRequest: async () => request,
    updateRequestStatus: async (...args: unknown[]) => {
      events.push(args[1] as string);
    },
    notifyApprover: async () => undefined,
    provisionAccessRequest: async () => true,
    revokeAccessRequest: async () => {
      const answer = await revokeAccessRequest();
      events.push(answer.success ? 'revoked' : 'revoke failed');
      afterRevoke();
      return answer;
    },
    recheckSodBeforeProvisioning: async () => ({ passed: true }),
    expireBeforeFulfilment: async () => undefined,
  });

  beforeAll(async () => {
    harness = await createWorkflowTestHarness({
      workflowsPath: WORKFLOWS_PATH,
      activities: activities(),
    });
  }, 120_000);

  afterAll(async () => {
    await harness?.shutdown();
  }, 30_000);

  beforeEach(() => {
    events = [];
    afterRevoke = () => undefined;
    revokeAccessRequest.mockReset().mockResolvedValue(DONE);
  });

  const input = { requestId: 'req-1', tenantId: TENANT, approvalTimeoutDays: 7 };

  /** A one-day request approved at its start; the run then waits until its end date. */
  const approvedOneDayRequest = async (env: WorkflowTestHarness, workflowId: string) => {
    request = requestDoc(new Date((await env.env.currentTimeMs()) + DAY_MS));
    return env.env.client.workflow.signalWithStart(accessRequestApprovalWorkflow, {
      args: [input],
      taskQueue: env.taskQueue,
      workflowId,
      signal: approvalDecisionSignal,
      signalArgs: [{ stepIndex: 0, decision: 'approve' }],
    });
  };

  /** Resolves once the revoke has failed `times` times. */
  const failedRevokes = (times: number) =>
    new Promise<void>((resolve) => {
      afterRevoke = () => {
        if (events.filter((e) => e === 'revoke failed').length >= times) resolve();
      };
    });

  it('ends the retry loop when an admin closes the request as removed by hand', async () => {
    revokeAccessRequest.mockResolvedValue(FAILED);
    const failedTwice = failedRevokes(2);
    const handle = await approvedOneDayRequest(harness, 'ar-e2e-closable-signal');
    const result = handle.result();

    await failedTwice;
    await handle.signal(removedManuallySignal);
    await result;

    // The API closed the request (EXPIRED, with the admin): the run writes no status of its own
    expect(events).toEqual(['ACTIVE', 'revoke failed', 'revoke failed']);
    expect(revokeAccessRequest).toHaveBeenCalledTimes(2);
  }, 60_000);

  it('continues as new after REVOKE_ATTEMPTS_PER_RUN retries and expires once removed', async () => {
    // The first revoke, the retries of the first run, two more in the next run, then success
    const failures = 1 + REVOKE_ATTEMPTS_PER_RUN + 2;
    for (let i = 0; i < failures; i++) revokeAccessRequest.mockResolvedValueOnce(FAILED);
    revokeAccessRequest.mockResolvedValueOnce(DONE);
    const handle = await approvedOneDayRequest(harness, 'ar-e2e-closable-continue');
    const firstRunId = handle.signaledRunId;

    await handle.result();

    expect(events.filter((e) => e === 'revoke failed')).toHaveLength(failures);
    expect(events.slice(-2)).toEqual(['revoked', 'EXPIRED']);
    expect(events.filter((e) => e === 'ACTIVE')).toHaveLength(1);

    const first = await harness.env.client.workflow
      .getHandle('ar-e2e-closable-continue', firstRunId)
      .fetchHistory();
    const firstEvents = first.events ?? [];
    expect(
      firstEvents[firstEvents.length - 1]?.workflowExecutionContinuedAsNewEventAttributes,
    ).toBeTruthy();
    const scheduledInFirst = firstEvents.filter(
      (e) => e.activityTaskScheduledEventAttributes?.activityType?.name === 'revokeAccessRequest',
    );
    expect(scheduledInFirst).toHaveLength(1 + REVOKE_ATTEMPTS_PER_RUN);

    // The next run waits as long as the attempt count says: the 6-hour cap
    const latest = await harness.env.client.workflow
      .getHandle('ar-e2e-closable-continue')
      .fetchHistory();
    const timers = (latest.events ?? [])
      .filter((e) => e.timerStartedEventAttributes)
      .map((e) => Number(e.timerStartedEventAttributes!.startToFireTimeout!.seconds) * 1000);
    expect(timers).toEqual([6 * HOUR_MS, 6 * HOUR_MS, 6 * HOUR_MS]);
  }, 120_000);

  it('replays failed revokes retried before access-request-approval:revoke-closable-continue-as-new', async () => {
    const history = JSON.parse(fs.readFileSync(PRE_CLOSABLE, 'utf8'));
    await expect(
      Worker.runReplayHistory({ workflowsPath: WORKFLOWS_PATH }, history),
    ).resolves.toBeUndefined();
  }, 60_000);

  const fixtureWorkflow = process.env.CLOSABLE_FIXTURE_WORKFLOW;
  const preWorkflowPath = path.resolve(process.cwd(), fixtureWorkflow ?? '');

  (fixtureWorkflow ? it : it.skip)(
    'records the pre-patch fixture (CLOSABLE_FIXTURE_WORKFLOW = the pre-patch workflow file)',
    async () => {
      const pre = await createWorkflowTestHarness({
        workflowsPath: preWorkflowPath,
        activities: activities(),
      });
      try {
        revokeAccessRequest
          .mockResolvedValueOnce(FAILED)
          .mockResolvedValueOnce(FAILED)
          .mockResolvedValueOnce(FAILED)
          .mockResolvedValueOnce(DONE);
        const handle = await approvedOneDayRequest(pre, 'ar-e2e-pre-revoke-closable');
        await handle.result();
        expect(events).toEqual([
          'ACTIVE',
          'revoke failed',
          'revoke failed',
          'revoke failed',
          'revoked',
          'EXPIRED',
        ]);
        fs.writeFileSync(PRE_CLOSABLE, historyJSON(await handle.fetchHistory()));
      } finally {
        await pre.shutdown();
      }
    },
    120_000,
  );

  (fixtureWorkflow ? it : it.skip)(
    'closes a run the old code left in the loop at its next attempt under the new code',
    async () => {
      const env = await createTestWorkflowEnvironment();
      const taskQueue = 'closable-upgrade';
      const workerWith = (workflowsPath: string) =>
        Worker.create({
          connection: env.nativeConnection,
          namespace: env.namespace,
          taskQueue,
          workflowsPath,
          activities: activities(),
          dataConverter: testDataConverter,
          // No sticky queue: the next workflow task goes to the task queue the new worker polls
          maxCachedWorkflows: 0,
        });
      try {
        revokeAccessRequest.mockResolvedValue(FAILED);
        const oldWorker = await workerWith(preWorkflowPath);
        const oldRun = oldWorker.run();
        const handle = await approvedOneDayRequest(
          { env, taskQueue } as WorkflowTestHarness,
          'ar-e2e-closable-upgrade',
        );
        // Past the end date an hour at a time, without awaiting the result (time skips only that
        // far), until the old code is retrying
        while (!events.includes('revoke failed')) await env.sleep(HOUR_MS);
        // and until it has started its retry timer (its workflow task is done), a second at a time
        const retryTimerStarted = async () => {
          const history = (await handle.fetchHistory()).events ?? [];
          const lastRevoke = history
            .map((e) => !!e.activityTaskCompletedEventAttributes)
            .lastIndexOf(true);
          return history.slice(lastRevoke).some((e) => !!e.timerStartedEventAttributes);
        };
        while (!(await retryTimerStarted())) await env.sleep(1000);
        oldWorker.shutdown();
        await oldRun;
        const attemptsUnderOldCode = revokeAccessRequest.mock.calls.length;

        const newWorker = await workerWith(WORKFLOWS_PATH);
        const newRun = newWorker.run();
        try {
          await handle.signal(removedManuallySignal);
          await handle.result();
        } finally {
          newWorker.shutdown();
          await newRun;
        }

        // At most one more attempt (the old run's timer was already running), and no EXPIRED
        // written by the run: the API closed the request
        expect(attemptsUnderOldCode).toBeGreaterThan(0);
        expect(events).not.toContain('EXPIRED');
        expect(revokeAccessRequest.mock.calls.length).toBeLessThanOrEqual(attemptsUnderOldCode + 1);
      } finally {
        await env.teardown();
      }
    },
    120_000,
  );
});
