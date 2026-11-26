/**
 * Access request approval: decisions that arrive before their step waits, and time-bound access
 * longer than one timer, end to end on the time-skipping Temporal test server. Opt-in via
 * TEMPORAL_E2E=1. The real accessRequestApprovalWorkflow runs with mocked activities.
 *
 * Proves:
 *   - An approval that arrives before its step starts waiting (here with the start:
 *     signalWithStart) counts for that step, and the request is fulfilled (patch
 *     access-request-approval:buffer-step-decisions). Before, the step dropped it, timed out and
 *     the request was REJECTED although the stored step said APPROVED.
 *   - A decision for a later step never counts for an earlier one; it waits for its own step.
 *   - A delegation still asks the new approver and waits for their decision.
 *   - A 200-day request expires on its date: timers of at most 90 days until expiresAt, then
 *     revoke and EXPIRED (patch access-request-approval:expire-on-date). Before, the access was
 *     revoked and the request marked EXPIRED after 90 days.
 *   - Histories recorded before the patches replay: the dropped approval, and a request sleeping
 *     its 90-day cap (it keeps the old behaviour).
 *
 * Fixtures test/fixtures/access-request-pre-step-decisions.history.json and
 * access-request-pre-expire-on-date.history.json were recorded with the workflow before both
 * patches (commit 817b568b), from backend/:
 *   git show 817b568b:backend/src/workflows/access-request-approval.workflow.ts \
 *     > src/workflows/access-request-pre-step-decisions.workflow.ts
 *   TEMPORAL_E2E=1 APPROVAL_FIXTURE_WORKFLOW=src/workflows/access-request-pre-step-decisions.workflow.ts \
 *     npx jest -c test/jest-e2e.json access-request-approval.workflow -t 'records the pre-patch'
 *   rm src/workflows/access-request-pre-step-decisions.workflow.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { Worker } from '@temporalio/worker';
import type { WorkflowHandle } from '@temporalio/client';
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
const PRE_STEP_DECISIONS = fixture('access-request-pre-step-decisions');
const PRE_EXPIRE_ON_DATE = fixture('access-request-pre-expire-on-date');
const TENANT = 'tenant-a';
const DAY_MS = 86_400_000;

type Decision = { stepIndex: number; decision: 'approve' | 'reject' | 'delegate' };

const step = (stepOrder: number) => ({ stepOrder, approverType: 'MANAGER', status: 'PENDING' });
const requestDoc = (steps: number, expiresAt?: Date) => ({
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
  approvalSteps: Array.from({ length: steps }, (_, i) => step(i)),
  ...(expiresAt ? { timeConstraint: { requestedDurationDays: 200, expiresAt } } : {}),
});

/** Durations (ms) of the timers that fired, in order. */
function firedTimerDurations(history: Awaited<ReturnType<WorkflowHandle['fetchHistory']>>) {
  const events = history.events ?? [];
  const started = new Map(
    events
      .filter((e) => e.timerStartedEventAttributes)
      .map((e) => [String(e.eventId), e.timerStartedEventAttributes!.startToFireTimeout]),
  );
  return events
    .filter((e) => e.timerFiredEventAttributes)
    .map((e) => started.get(String(e.timerFiredEventAttributes!.startedEventId)))
    .map((d) => Number(String(d?.seconds ?? 0)) * 1000 + Math.floor((d?.nanos ?? 0) / 1e6));
}

describeTemporalE2E('access request approval: early decisions and long expiry (e2e)', () => {
  let harness: WorkflowTestHarness;
  let request: ReturnType<typeof requestDoc> = requestDoc(1);
  const updateRequestStatus = jest.fn();
  const notifyApprover = jest.fn();
  const provisionAccessRequest = jest.fn();
  const revokeAccessRequest = jest.fn();

  const workers = (): Omit<WorkflowTestHarnessOptions, 'workflowsPath'> => ({
    activities: {
      getAccessRequest: async () => request,
      updateRequestStatus: (...args: unknown[]) => updateRequestStatus(...args),
      notifyApprover: (...args: unknown[]) => notifyApprover(...args),
      provisionAccessRequest: (...args: unknown[]) => provisionAccessRequest(...args),
      revokeAccessRequest: (...args: unknown[]) => revokeAccessRequest(...args),
      recheckSodBeforeProvisioning: async () => ({ passed: true }),
    },
  });

  beforeAll(async () => {
    harness = await createWorkflowTestHarness({ workflowsPath: WORKFLOWS_PATH, ...workers() });
  }, 120_000);

  afterAll(async () => {
    await harness?.shutdown();
  }, 30_000);

  beforeEach(() => {
    request = requestDoc(1);
    updateRequestStatus.mockReset().mockResolvedValue(undefined);
    notifyApprover.mockReset().mockResolvedValue(undefined);
    provisionAccessRequest.mockReset().mockResolvedValue(true);
    revokeAccessRequest.mockReset().mockResolvedValue({ success: true, failedSystems: [] });
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

  it('counts an approval that arrives before its step starts waiting', async () => {
    const handle = await startWithDecision(harness, 'ar-e2e-early-approval', {
      stepIndex: 0,
      decision: 'approve',
    });
    await handle.result();

    expect(provisionAccessRequest).toHaveBeenCalledWith('req-1', TENANT);
    expect(statuses()).toEqual(['ACTIVE']);
  }, 60_000);

  it('never counts a decision for a later step for an earlier one', async () => {
    request = requestDoc(2);
    const handle = await startWithDecision(harness, 'ar-e2e-later-step-only', {
      stepIndex: 1,
      decision: 'approve',
    });
    await handle.result();

    // Step 0 was never decided: it timed out
    expect(notifiedSteps()).toEqual([0]);
    expect(provisionAccessRequest).not.toHaveBeenCalled();
    expect(statuses()).toEqual(['REJECTED']);
  }, 60_000);

  it('keeps a decision for a later step until that step, then counts it', async () => {
    request = requestDoc(2);
    const handle = await startWithDecision(harness, 'ar-e2e-later-step-kept', {
      stepIndex: 1,
      decision: 'approve',
    });
    await notified(1);
    await handle.signal(approvalDecisionSignal, { stepIndex: 0, decision: 'approve' });
    await handle.result();

    expect(notifiedSteps()).toEqual([0, 1]);
    expect(statuses()).toEqual(['ACTIVE']);
  }, 60_000);

  it('after a delegation asks the new approver and waits for their decision', async () => {
    const handle = await startWithDecision(harness, 'ar-e2e-delegate', {
      stepIndex: 0,
      decision: 'delegate',
    });
    // The first ask, then the ask after the delegation; the step still waits
    await notified(2);
    expect(statuses()).toEqual([]);
    await handle.signal(approvalDecisionSignal, { stepIndex: 0, decision: 'approve' });
    await handle.result();

    expect(notifiedSteps().every((s) => s === 0)).toBe(true);
    expect(statuses()).toEqual(['ACTIVE']);
  }, 60_000);

  it('expires a 200-day request on its date, in timers of at most 90 days', async () => {
    const expiresAt = new Date((await harness.env.currentTimeMs()) + 200 * DAY_MS);
    request = requestDoc(1, expiresAt);
    const handle = await startWithDecision(harness, 'ar-e2e-200-days', {
      stepIndex: 0,
      decision: 'approve',
    });
    await handle.result();

    expect(statuses()).toEqual(['ACTIVE', 'EXPIRED']);
    expect(revokeAccessRequest).toHaveBeenCalledWith('req-1', TENANT);
    const provisionedAt = new Date(updateRequestStatus.mock.calls[0][2].provisionedAt).getTime();
    const timers = firedTimerDurations(await handle.fetchHistory());
    expect(timers).toHaveLength(3);
    expect(timers.slice(0, 2)).toEqual([90 * DAY_MS, 90 * DAY_MS]);
    expect(Math.max(...timers)).toBeLessThanOrEqual(90 * DAY_MS);
    // The timers end at expiresAt (the run reads its clock again after storing ACTIVE)
    const sum = timers.reduce((a, b) => a + b, 0);
    expect(Math.abs(provisionedAt + sum - expiresAt.getTime())).toBeLessThan(60_000);
  }, 60_000);

  it('replays a history recorded before the patch access-request-approval:buffer-step-decisions', async () => {
    const history = JSON.parse(fs.readFileSync(PRE_STEP_DECISIONS, 'utf8'));
    await expect(
      Worker.runReplayHistory({ workflowsPath: WORKFLOWS_PATH }, history),
    ).resolves.toBeUndefined();
  }, 60_000);

  it('replays a request sleeping its 90-day cap from before access-request-approval:expire-on-date', async () => {
    const history = JSON.parse(fs.readFileSync(PRE_EXPIRE_ON_DATE, 'utf8'));
    await expect(
      Worker.runReplayHistory({ workflowsPath: WORKFLOWS_PATH }, history),
    ).resolves.toBeUndefined();
  }, 60_000);

  const fixtureWorkflow = process.env.APPROVAL_FIXTURE_WORKFLOW;
  (fixtureWorkflow ? it : it.skip)(
    'records the pre-patch fixtures (APPROVAL_FIXTURE_WORKFLOW = the pre-patch workflow file)',
    async () => {
      const pre = await createWorkflowTestHarness({
        workflowsPath: path.resolve(process.cwd(), fixtureWorkflow ?? ''),
        ...workers(),
      });
      try {
        // The approval arrives before the step waits: dropped, the step times out, REJECTED
        const early = await startWithDecision(pre, 'ar-e2e-pre-step-decisions', {
          stepIndex: 0,
          decision: 'approve',
        });
        await early.result();
        expect(provisionAccessRequest).not.toHaveBeenCalled();
        expect(statuses()).toEqual(['REJECTED']);
        fs.writeFileSync(PRE_STEP_DECISIONS, historyJSON(await early.fetchHistory()));

        // A 200-day request: one 90-day timer, then revoked and EXPIRED
        updateRequestStatus.mockClear();
        notifyApprover.mockClear();
        request = requestDoc(1, new Date((await pre.env.currentTimeMs()) + 200 * DAY_MS));
        const long = await start(pre, 'ar-e2e-pre-expire-on-date');
        await notified(1);
        await long.signal(approvalDecisionSignal, { stepIndex: 0, decision: 'approve' });
        await long.result();
        expect(statuses()).toEqual(['ACTIVE', 'EXPIRED']);
        const history = await long.fetchHistory();
        expect(firedTimerDurations(history)).toEqual([90 * DAY_MS]);
        fs.writeFileSync(PRE_EXPIRE_ON_DATE, historyJSON(history));
      } finally {
        await pre.shutdown();
      }
    },
    120_000,
  );
});
