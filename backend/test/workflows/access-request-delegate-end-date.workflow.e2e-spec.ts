/**
 * Access request approval: the delegate is asked once, and a request whose end date passed
 * before approval completed is not fulfilled, end to end on the time-skipping Temporal test
 * server. Opt-in via TEMPORAL_E2E=1. The real accessRequestApprovalWorkflow runs with mocked
 * activities; expireBeforeFulfilment stands for AccessRequestClosureService.close (its MongoDB
 * behaviour is in src/modules/access-requests/access-request-decision.integration.spec.ts).
 *
 * Proves:
 *   - After a delegation the new approver is asked once, then the step waits for their decision
 *     (patch access-request-approval:notify-delegate-once). Before, the delegate branch asked and
 *     the top of the step loop asked again: two mails.
 *   - A time-bound request whose end date passed while its approval waited is not fulfilled: no
 *     SoD re-check, no provisioning, expireBeforeFulfilment ends it EXPIRED with the reason
 *     (patch access-request-approval:end-date-passed-before-approval). Before, it was provisioned
 *     and, the date being past, never revoked.
 *   - A request approved before its end date is fulfilled and expires on it, as before.
 *   - Histories recorded before the patches (a delegation; an approval after the end date)
 *     replay.
 *
 * Fixtures test/fixtures/access-request-pre-notify-delegate-once.history.json and
 * access-request-pre-end-date-passed.history.json are recorded with the workflow before both
 * patches (commit 9236839c), written to a file of its own so the working workflow file is never
 * touched, from backend/:
 *   git show 9236839c:backend/src/workflows/access-request-approval.workflow.ts \
 *     > src/workflows/access-request-pre-r6.workflow.ts
 *   TEMPORAL_E2E=1 DELEGATE_END_DATE_FIXTURE_WORKFLOW=src/workflows/access-request-pre-r6.workflow.ts \
 *     npx jest -c test/jest-e2e.json access-request-delegate-end-date -t 'records the pre-patch'
 *   rm src/workflows/access-request-pre-r6.workflow.ts
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
const fixture = (name: string) => path.resolve(__dirname, `../fixtures/${name}.history.json`);
const PRE_NOTIFY_DELEGATE_ONCE = fixture('access-request-pre-notify-delegate-once');
const PRE_END_DATE_PASSED = fixture('access-request-pre-end-date-passed');
const TENANT = 'tenant-a';
const DAY_MS = 86_400_000;

type Decision = { stepIndex: number; decision: 'approve' | 'reject' | 'delegate' };

const requestDoc = (expiresAt?: Date) => ({
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
  ...(expiresAt ? { timeConstraint: { requestedDurationDays: 1, expiresAt } } : {}),
});

describeTemporalE2E('access request approval: delegation and a passed end date (e2e)', () => {
  let harness: WorkflowTestHarness;
  let request: ReturnType<typeof requestDoc> = requestDoc();
  const updateRequestStatus = jest.fn();
  const notifyApprover = jest.fn();
  const provisionAccessRequest = jest.fn();
  const revokeAccessRequest = jest.fn();
  const recheckSodBeforeProvisioning = jest.fn();
  const expireBeforeFulfilment = jest.fn();

  const workers = (): Omit<WorkflowTestHarnessOptions, 'workflowsPath'> => ({
    activities: {
      getAccessRequest: async () => request,
      updateRequestStatus: (...args: unknown[]) => updateRequestStatus(...args),
      notifyApprover: (...args: unknown[]) => notifyApprover(...args),
      provisionAccessRequest: (...args: unknown[]) => provisionAccessRequest(...args),
      revokeAccessRequest: (...args: unknown[]) => revokeAccessRequest(...args),
      recheckSodBeforeProvisioning: (...args: unknown[]) => recheckSodBeforeProvisioning(...args),
      expireBeforeFulfilment: (...args: unknown[]) => expireBeforeFulfilment(...args),
    },
  });

  beforeAll(async () => {
    harness = await createWorkflowTestHarness({ workflowsPath: WORKFLOWS_PATH, ...workers() });
  }, 120_000);

  afterAll(async () => {
    await harness?.shutdown();
  }, 30_000);

  beforeEach(() => {
    request = requestDoc();
    updateRequestStatus.mockReset().mockResolvedValue(undefined);
    notifyApprover.mockReset().mockResolvedValue(undefined);
    provisionAccessRequest.mockReset().mockResolvedValue(true);
    revokeAccessRequest.mockReset().mockResolvedValue({ success: true, failedSystems: [] });
    recheckSodBeforeProvisioning.mockReset().mockResolvedValue({ passed: true });
    expireBeforeFulfilment.mockReset().mockResolvedValue(undefined);
  });

  const input = { requestId: 'req-1', tenantId: TENANT, approvalTimeoutDays: 7 };
  const statuses = () => updateRequestStatus.mock.calls.map(([, status]) => status);
  const notifiedSteps = () => notifyApprover.mock.calls.map(([, stepIndex]) => stepIndex);

  /** Starts the run with `decision` signalled in its first workflow task. */
  const startWithDecision = (env: WorkflowTestHarness, workflowId: string, decision: Decision) =>
    env.env.client.workflow.signalWithStart(accessRequestApprovalWorkflow, {
      args: [input],
      taskQueue: env.taskQueue,
      workflowId,
      signal: approvalDecisionSignal,
      signalArgs: [decision],
    });

  const start = (env: WorkflowTestHarness, workflowId: string) =>
    env.env.client.workflow.start(accessRequestApprovalWorkflow, {
      args: [input],
      taskQueue: env.taskQueue,
      workflowId,
    });

  /** Waits (real time, no time skipping) until the approver was asked `times` times. */
  const notified = async (times: number) => {
    for (let i = 0; i < 100 && notifyApprover.mock.calls.length < times; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(notifyApprover.mock.calls.length).toBeGreaterThanOrEqual(times);
  };

  /** A one-day request; the approval comes two days after the start, past its end date. */
  const approveAfterEndDate = async (env: WorkflowTestHarness, workflowId: string) => {
    request = requestDoc(new Date((await env.env.currentTimeMs()) + DAY_MS));
    const handle = await start(env, workflowId);
    await notified(1);
    await env.env.sleep(2 * DAY_MS);
    await handle.signal(approvalDecisionSignal, { stepIndex: 0, decision: 'approve' });
    await handle.result();
    return handle;
  };

  /** Delegates the only step at the start, then approves once the delegate was asked. */
  const delegateThenApprove = async (env: WorkflowTestHarness, workflowId: string) => {
    const handle = await startWithDecision(env, workflowId, { stepIndex: 0, decision: 'delegate' });
    await notified(2);
    await handle.signal(approvalDecisionSignal, { stepIndex: 0, decision: 'approve' });
    await handle.result();
    return handle;
  };

  it('asks the delegate once, then waits for their decision', async () => {
    await delegateThenApprove(harness, 'ar-e2e-delegate-asked-once');

    // The first approver at the start, the delegate after the delegation: no second mail
    expect(notifiedSteps()).toEqual([0, 0]);
    expect(statuses()).toEqual(['ACTIVE']);
  }, 60_000);

  it('does not fulfil a request whose end date passed while its approval waited', async () => {
    await approveAfterEndDate(harness, 'ar-e2e-end-date-passed');

    expect(expireBeforeFulfilment).toHaveBeenCalledWith('req-1', TENANT);
    expect(recheckSodBeforeProvisioning).not.toHaveBeenCalled();
    expect(provisionAccessRequest).not.toHaveBeenCalled();
    expect(revokeAccessRequest).not.toHaveBeenCalled();
    // expireBeforeFulfilment stored EXPIRED and the reason; the workflow writes nothing more
    expect(statuses()).toEqual([]);
  }, 60_000);

  it('fulfils a request approved before its end date, and expires it on that date', async () => {
    request = requestDoc(new Date((await harness.env.currentTimeMs()) + 10 * DAY_MS));
    const handle = await startWithDecision(harness, 'ar-e2e-end-date-ahead', {
      stepIndex: 0,
      decision: 'approve',
    });
    await handle.result();

    expect(expireBeforeFulfilment).not.toHaveBeenCalled();
    expect(provisionAccessRequest).toHaveBeenCalledWith('req-1', TENANT);
    expect(statuses()).toEqual(['ACTIVE', 'EXPIRED']);
    expect(revokeAccessRequest).toHaveBeenCalledWith('req-1', TENANT);
  }, 60_000);

  it('replays a delegation recorded before the patch access-request-approval:notify-delegate-once', async () => {
    const history = JSON.parse(fs.readFileSync(PRE_NOTIFY_DELEGATE_ONCE, 'utf8'));
    await expect(
      Worker.runReplayHistory({ workflowsPath: WORKFLOWS_PATH }, history),
    ).resolves.toBeUndefined();
  }, 60_000);

  it('replays an approval after the end date recorded before access-request-approval:end-date-passed-before-approval', async () => {
    const history = JSON.parse(fs.readFileSync(PRE_END_DATE_PASSED, 'utf8'));
    await expect(
      Worker.runReplayHistory({ workflowsPath: WORKFLOWS_PATH }, history),
    ).resolves.toBeUndefined();
  }, 60_000);

  const fixtureWorkflow = process.env.DELEGATE_END_DATE_FIXTURE_WORKFLOW;
  (fixtureWorkflow ? it : it.skip)(
    'records the pre-patch fixtures (DELEGATE_END_DATE_FIXTURE_WORKFLOW = the pre-patch workflow file)',
    async () => {
      const pre = await createWorkflowTestHarness({
        workflowsPath: path.resolve(process.cwd(), fixtureWorkflow ?? ''),
        ...workers(),
      });
      try {
        // A delegation: the delegate branch asks, the top of the loop asks again
        const delegated = await delegateThenApprove(pre, 'ar-e2e-pre-notify-delegate-once');
        expect(notifiedSteps()).toEqual([0, 0, 0]);
        expect(statuses()).toEqual(['ACTIVE']);
        fs.writeFileSync(PRE_NOTIFY_DELEGATE_ONCE, historyJSON(await delegated.fetchHistory()));

        // Approved after the end date: provisioned, ACTIVE, never revoked
        updateRequestStatus.mockClear();
        notifyApprover.mockClear();
        provisionAccessRequest.mockClear();
        const late = await approveAfterEndDate(pre, 'ar-e2e-pre-end-date-passed');
        expect(expireBeforeFulfilment).not.toHaveBeenCalled();
        expect(provisionAccessRequest).toHaveBeenCalledWith('req-1', TENANT);
        expect(statuses()).toEqual(['ACTIVE']);
        expect(revokeAccessRequest).not.toHaveBeenCalled();
        fs.writeFileSync(PRE_END_DATE_PASSED, historyJSON(await late.fetchHistory()));
      } finally {
        await pre.shutdown();
      }
    },
    120_000,
  );
});
