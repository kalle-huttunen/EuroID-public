/**
 * Access request approval: a time-bound request is marked EXPIRED only once its access is
 * removed, end to end on the time-skipping Temporal test server. Opt-in via TEMPORAL_E2E=1. The
 * real accessRequestApprovalWorkflow runs with mocked activities; revokeAccessRequest answers as
 * AccessRequestActivities.revokeAccessRequest does ({ success, failedSystems }).
 *
 * Proves (hunt 04 F4):
 *   - A revoke that fails (a system down at the expiry) is tried again, after 5 minutes, then
 *     twice as long each time up to 6 hours, until it succeeds; the request stays ACTIVE in the
 *     meantime and is marked EXPIRED after the revoke that succeeded (patch
 *     access-request-approval:revoke-until-done). Before, the run ignored the answer and marked
 *     it EXPIRED at once: the person kept the access and nothing tried again.
 *   - A revoke that succeeds the first time expires the request as before.
 *   - A history recorded before the patch (a failed revoke, then EXPIRED) replays.
 *
 * Fixture test/fixtures/access-request-pre-revoke-until-done.history.json is recorded with the
 * workflow before the patch (as of commit 2f575a56), written to a file of its own so the working
 * workflow file is never touched, from backend/:
 *   git show 2f575a56:backend/src/workflows/access-request-approval.workflow.ts \
 *     > src/workflows/access-request-pre-revoke-until-done.workflow.ts
 *   TEMPORAL_E2E=1 REVOKE_FIXTURE_WORKFLOW=src/workflows/access-request-pre-revoke-until-done.workflow.ts \
 *     npx jest -c test/jest-e2e.json access-request-revoke-until-done -t 'records the pre-patch'
 *   rm src/workflows/access-request-pre-revoke-until-done.workflow.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { Worker } from '@temporalio/worker';
import {
  accessRequestApprovalWorkflow,
  approvalDecisionSignal,
} from '../../src/workflows/access-request-approval.workflow';
import {
  createWorkflowTestHarness,
  describeTemporalE2E,
  type WorkflowTestHarness,
  type WorkflowTestHarnessOptions,
} from '../helpers/workflow-test-env';
import { historyJSON } from '../helpers/history-json';

const WORKFLOWS_PATH = path.resolve(
  __dirname,
  '../../src/workflows/access-request-approval.workflow.ts',
);
const PRE_REVOKE_UNTIL_DONE = path.resolve(
  __dirname,
  '../fixtures/access-request-pre-revoke-until-done.history.json',
);
const TENANT = 'tenant-a';
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

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

describeTemporalE2E('access request approval: expired only once revoked (e2e)', () => {
  let harness: WorkflowTestHarness;
  let request: ReturnType<typeof requestDoc>;
  /** What happened, in order: revoke answers and status writes. */
  let events: string[];
  const updateRequestStatus = jest.fn();
  const revokeAccessRequest = jest.fn();

  const workers = (): Omit<WorkflowTestHarnessOptions, 'workflowsPath'> => ({
    activities: {
      getAccessRequest: async () => request,
      updateRequestStatus: async (...args: unknown[]) => {
        const status = args[1] as string;
        events.push(status);
        updateRequestStatus(status);
      },
      notifyApprover: async () => undefined,
      provisionAccessRequest: async () => true,
      revokeAccessRequest: async () => {
        const answer = await revokeAccessRequest();
        events.push(answer.success ? 'revoked' : 'revoke failed');
        return answer;
      },
      recheckSodBeforeProvisioning: async () => ({ passed: true }),
      expireBeforeFulfilment: async () => undefined,
    },
  });

  beforeAll(async () => {
    harness = await createWorkflowTestHarness({ workflowsPath: WORKFLOWS_PATH, ...workers() });
  }, 120_000);

  afterAll(async () => {
    await harness?.shutdown();
  }, 30_000);

  beforeEach(() => {
    events = [];
    updateRequestStatus.mockReset();
    revokeAccessRequest.mockReset().mockResolvedValue(DONE);
  });

  const input = { requestId: 'req-1', tenantId: TENANT, approvalTimeoutDays: 7 };

  /** A one-day request approved at its start; the run then waits until its end date. */
  const approvedOneDayRequest = async (env: WorkflowTestHarness, workflowId: string) => {
    request = requestDoc(new Date((await env.env.currentTimeMs()) + DAY_MS));
    const handle = await env.env.client.workflow.signalWithStart(accessRequestApprovalWorkflow, {
      args: [input],
      taskQueue: env.taskQueue,
      workflowId,
      signal: approvalDecisionSignal,
      signalArgs: [{ stepIndex: 0, decision: 'approve' }],
    });
    return handle;
  };

  it('tries a failed revoke again and marks the request EXPIRED only after it succeeds', async () => {
    revokeAccessRequest
      .mockResolvedValueOnce(FAILED)
      .mockResolvedValueOnce(FAILED)
      .mockResolvedValueOnce(DONE);
    const handle = await approvedOneDayRequest(harness, 'ar-e2e-revoke-until-done');
    const started = await harness.env.currentTimeMs();

    await handle.result();

    expect(events).toEqual(['ACTIVE', 'revoke failed', 'revoke failed', 'revoked', 'EXPIRED']);
    // One day to the end date, then 5 and 10 minutes between the attempts
    const history = await handle.fetchHistory();
    const timers = (history.events ?? [])
      .filter((e) => e.timerStartedEventAttributes)
      .map((e) => Number(e.timerStartedEventAttributes!.startToFireTimeout!.seconds) * 1000);
    expect(timers.slice(-2)).toEqual([5 * MINUTE_MS, 10 * MINUTE_MS]);
    expect((await harness.env.currentTimeMs()) - started).toBeGreaterThanOrEqual(
      DAY_MS + 15 * MINUTE_MS - MINUTE_MS,
    );
  }, 60_000);

  it('expires the request at once when the first revoke succeeds', async () => {
    const handle = await approvedOneDayRequest(harness, 'ar-e2e-revoke-first-time');

    await handle.result();

    expect(events).toEqual(['ACTIVE', 'revoked', 'EXPIRED']);
    expect(revokeAccessRequest).toHaveBeenCalledTimes(1);
  }, 60_000);

  it('replays a failed revoke recorded before access-request-approval:revoke-until-done', async () => {
    const history = JSON.parse(fs.readFileSync(PRE_REVOKE_UNTIL_DONE, 'utf8'));
    await expect(
      Worker.runReplayHistory({ workflowsPath: WORKFLOWS_PATH }, history),
    ).resolves.toBeUndefined();
  }, 60_000);

  const fixtureWorkflow = process.env.REVOKE_FIXTURE_WORKFLOW;
  (fixtureWorkflow ? it : it.skip)(
    'records the pre-patch fixture (REVOKE_FIXTURE_WORKFLOW = the pre-patch workflow file)',
    async () => {
      const pre = await createWorkflowTestHarness({
        workflowsPath: path.resolve(process.cwd(), fixtureWorkflow ?? ''),
        ...workers(),
      });
      try {
        // The revoke fails; the old run marks the request EXPIRED anyway
        revokeAccessRequest.mockResolvedValue(FAILED);
        const handle = await approvedOneDayRequest(pre, 'ar-e2e-pre-revoke-until-done');
        await handle.result();
        expect(events).toEqual(['ACTIVE', 'revoke failed', 'EXPIRED']);
        fs.writeFileSync(PRE_REVOKE_UNTIL_DONE, historyJSON(await handle.fetchHistory()));
      } finally {
        await pre.shutdown();
      }
    },
    120_000,
  );
});
