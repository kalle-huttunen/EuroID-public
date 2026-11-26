/**
 * Access request approval: a step the request itself approved is not waited for, end to end on
 * the time-skipping Temporal test server. Opt-in via TEMPORAL_E2E=1. The real
 * accessRequestApprovalWorkflow runs with mocked activities.
 *
 * Proves (hunt 04 F9):
 *   - A step stored APPROVED when the request was created (its approver is the requester: a
 *     manager requesting for their report is the MANAGER step's approver, approval-chain.ts) is
 *     skipped: its approver is not asked and the run waits for the next step only (patch
 *     access-request-approval:skip-steps-approved-at-creation). Before, the run waited for a
 *     decision on it that the self-approval guard refused to everyone, and the request timed out
 *     REJECTED.
 *   - A history recorded before the patch (such a step waited for, then the timeout) replays.
 *
 * Fixture test/fixtures/access-request-pre-skip-approved-steps.history.json is recorded with the
 * workflow before the patch (as of commit e1de6080), from backend/:
 *   git show e1de6080:backend/src/workflows/access-request-approval.workflow.ts \
 *     > src/workflows/access-request-pre-skip-approved.workflow.ts
 *   TEMPORAL_E2E=1 APPROVED_STEPS_FIXTURE_WORKFLOW=src/workflows/access-request-pre-skip-approved.workflow.ts \
 *     npx jest -c test/jest-e2e.json access-request-approved-at-creation -t 'records the pre-patch'
 *   rm src/workflows/access-request-pre-skip-approved.workflow.ts
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
const PRE_SKIP_APPROVED = path.resolve(
  __dirname,
  '../fixtures/access-request-pre-skip-approved-steps.history.json',
);
const TENANT = 'tenant-a';

/** A manager's request for a report: the MANAGER step approved by the request, OWNER waiting. */
const request = {
  requestId: 'req-1',
  status: 'PENDING_APPROVAL',
  requesterId: 'id-manager',
  targetIdentityId: 'id-report',
  entitlements: [
    { catalogEntryId: 'cat-1', system: 'entra-id', nativeId: 'Payables', entitlementType: 'Group' },
  ],
  approvalSteps: [
    {
      stepOrder: 0,
      approverType: 'MANAGER',
      approverId: 'id-manager',
      approverEmail: 'mia.manager@a.example',
      status: 'APPROVED',
      decidedBy: 'mia.manager@a.example',
    },
    {
      stepOrder: 1,
      approverType: 'OWNER',
      approverId: 'id-owner',
      approverEmail: 'fin.owner@a.example',
      status: 'PENDING',
    },
  ],
};

describeTemporalE2E('access request approval: a step approved at creation (e2e)', () => {
  let harness: WorkflowTestHarness;
  const updateRequestStatus = jest.fn();
  const notifyApprover = jest.fn();
  const provisionAccessRequest = jest.fn();

  const workers = (): Omit<WorkflowTestHarnessOptions, 'workflowsPath'> => ({
    activities: {
      getAccessRequest: async () => request,
      updateRequestStatus: (...args: unknown[]) => updateRequestStatus(...args),
      notifyApprover: (...args: unknown[]) => notifyApprover(...args),
      provisionAccessRequest: (...args: unknown[]) => provisionAccessRequest(...args),
      revokeAccessRequest: async () => ({ success: true, failedSystems: [] }),
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
    updateRequestStatus.mockReset().mockResolvedValue(undefined);
    notifyApprover.mockReset().mockResolvedValue(undefined);
    provisionAccessRequest.mockReset().mockResolvedValue(true);
  });

  const input = { requestId: 'req-1', tenantId: TENANT, approvalTimeoutDays: 7 };
  const statuses = () => updateRequestStatus.mock.calls.map(([, status]) => status);
  const notifiedSteps = () => notifyApprover.mock.calls.map(([, stepIndex]) => stepIndex);

  /** The owner approves step 1 in the run's first workflow task. */
  const ownerApproves = (env: WorkflowTestHarness, workflowId: string) =>
    env.env.client.workflow.signalWithStart(accessRequestApprovalWorkflow, {
      args: [input],
      taskQueue: env.taskQueue,
      workflowId,
      signal: approvalDecisionSignal,
      signalArgs: [{ stepIndex: 1, decision: 'approve' }],
    });

  it('waits for the owner only, and fulfils the request on their approval', async () => {
    const handle = await ownerApproves(harness, 'ar-e2e-approved-at-creation');

    await handle.result();

    expect(notifiedSteps()).toEqual([1]);
    expect(provisionAccessRequest).toHaveBeenCalledWith('req-1', TENANT);
    expect(statuses()).toEqual(['ACTIVE']);
  }, 60_000);

  it('replays a run recorded before access-request-approval:skip-steps-approved-at-creation', async () => {
    const history = JSON.parse(fs.readFileSync(PRE_SKIP_APPROVED, 'utf8'));
    await expect(
      Worker.runReplayHistory({ workflowsPath: WORKFLOWS_PATH }, history),
    ).resolves.toBeUndefined();
  }, 60_000);

  const fixtureWorkflow = process.env.APPROVED_STEPS_FIXTURE_WORKFLOW;
  (fixtureWorkflow ? it : it.skip)(
    'records the pre-patch fixture (APPROVED_STEPS_FIXTURE_WORKFLOW = the pre-patch workflow file)',
    async () => {
      const pre = await createWorkflowTestHarness({
        workflowsPath: path.resolve(process.cwd(), fixtureWorkflow ?? ''),
        ...workers(),
      });
      try {
        // The old run waits for step 0, which nobody may decide, and times out REJECTED
        const handle = await ownerApproves(pre, 'ar-e2e-pre-skip-approved-steps');
        await handle.result();
        expect(notifiedSteps()).toEqual([0]);
        expect(provisionAccessRequest).not.toHaveBeenCalled();
        expect(statuses()).toEqual(['REJECTED']);
        fs.writeFileSync(PRE_SKIP_APPROVED, historyJSON(await handle.fetchHistory()));
      } finally {
        await pre.shutdown();
      }
    },
    120_000,
  );
});
