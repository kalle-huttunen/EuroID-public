/**
 * Access request approval with the SoD re-check before fulfilment, end to end on the
 * time-skipping Temporal test server. Opt-in via TEMPORAL_E2E=1.
 *
 * The real accessRequestApprovalWorkflow runs with mocked activities; recheckSodBeforeProvisioning
 * stands for AccessRequestSodService.claimForProvisioning (its MongoDB behaviour is covered by
 * src/modules/access-requests/access-request-sod.integration.spec.ts).
 *
 * Proves:
 *   - After the last approval the request is re-checked before fulfilment; the re-check marks it
 *     PROVISIONING, so the workflow no longer does.
 *   - A re-check that finds a Block conflict ends the run: nothing is fulfilled (the activity
 *     stored REJECTED and the conflict).
 *   - A history recorded before the patch access-request:sod-recheck-before-provision still
 *     replays.
 *
 * Fixture test/fixtures/access-request-pre-sod-recheck.history.json was recorded with the
 * pre-patch workflow (commit ca5a8b11), from backend/:
 *   git show ca5a8b11:backend/src/workflows/access-request-approval.workflow.ts \
 *     > src/workflows/access-request-pre-sod-recheck.workflow.ts
 *   TEMPORAL_E2E=1 SOD_RECHECK_FIXTURE_WORKFLOW=src/workflows/access-request-pre-sod-recheck.workflow.ts \
 *     npx jest -c test/jest-e2e.json access-request-sod-recheck -t 'records the pre-patch fixture'
 *   rm src/workflows/access-request-pre-sod-recheck.workflow.ts
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
const PRE_PATCH_HISTORY = path.resolve(
  __dirname,
  '../fixtures/access-request-pre-sod-recheck.history.json',
);
const TENANT = 'tenant-a';

const request = {
  requestId: 'req-1',
  status: 'PENDING_APPROVAL',
  requesterId: 'id-person',
  entitlements: [
    {
      catalogEntryId: 'cat-approvers',
      system: 'entra-id',
      nativeId: 'Approvers',
      entitlementType: 'Group',
    },
  ],
  approvalSteps: [{ stepOrder: 0, approverType: 'MANAGER', status: 'PENDING' }],
  sodCheckResult: { passed: true, violations: [] },
};

describeTemporalE2E('access request: SoD re-check before fulfilment (e2e)', () => {
  let harness: WorkflowTestHarness;
  const updateRequestStatus = jest.fn();
  const provisionAccessRequest = jest.fn();
  const recheckSodBeforeProvisioning = jest.fn();
  const notifyApprover = jest.fn();

  const workers = (): Omit<WorkflowTestHarnessOptions, 'workflowsPath'> => ({
    taskQueue: 'provisioning-default',
    activities: {
      getAccessRequest: async () => request,
      updateRequestStatus: (...args: unknown[]) => updateRequestStatus(...args),
      notifyApprover: (...args: unknown[]) => notifyApprover(...args),
      provisionAccessRequest: (...args: unknown[]) => provisionAccessRequest(...args),
      revokeAccessRequest: async () => ({ success: true, failedSystems: [] }),
      recheckSodBeforeProvisioning: (...args: unknown[]) => recheckSodBeforeProvisioning(...args),
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
    provisionAccessRequest.mockReset().mockResolvedValue(true);
    recheckSodBeforeProvisioning.mockReset().mockResolvedValue({ passed: true });
    notifyApprover.mockReset().mockResolvedValue(undefined);
  });

  const input = { requestId: 'req-1', tenantId: TENANT, approvalTimeoutDays: 7 };
  const approval = { stepIndex: 0, decision: 'approve' as const };

  /**
   * Starts the run with its only step approved (signalWithStart: a decision that arrives before
   * the step waits counts for it, patch access-request-approval:buffer-step-decisions), waits for
   * the run to end.
   */
  const approveAndFinish = async (env: WorkflowTestHarness, workflowId: string) => {
    const handle = await env.env.client.workflow.signalWithStart(accessRequestApprovalWorkflow, {
      args: [input],
      taskQueue: env.taskQueue,
      workflowId,
      signal: approvalDecisionSignal,
      signalArgs: [approval],
    });
    await handle.result();
    return handle;
  };

  const statuses = () => updateRequestStatus.mock.calls.map(([, status]) => status);

  it('re-checks after the last approval, then fulfils', async () => {
    await approveAndFinish(harness, 'access-request-e2e-recheck-passes');

    expect(recheckSodBeforeProvisioning).toHaveBeenCalledWith('req-1', TENANT);
    expect(recheckSodBeforeProvisioning.mock.invocationCallOrder[0]).toBeLessThan(
      provisionAccessRequest.mock.invocationCallOrder[0],
    );
    expect(provisionAccessRequest).toHaveBeenCalledWith('req-1', TENANT);
    // The re-check marked the request PROVISIONING
    expect(statuses()).toEqual(['ACTIVE']);
  }, 60_000);

  it('fulfils nothing when the re-check finds a Block conflict', async () => {
    recheckSodBeforeProvisioning.mockResolvedValue({ passed: false });

    await approveAndFinish(harness, 'access-request-e2e-recheck-blocks');

    expect(provisionAccessRequest).not.toHaveBeenCalled();
    // The activity stored REJECTED with the conflict; the workflow writes nothing more
    expect(statuses()).toEqual([]);
  }, 60_000);

  it('replays a history recorded before the patch access-request:sod-recheck-before-provision', async () => {
    const history = JSON.parse(fs.readFileSync(PRE_PATCH_HISTORY, 'utf8'));
    await expect(
      Worker.runReplayHistory({ workflowsPath: WORKFLOWS_PATH }, history),
    ).resolves.toBeUndefined();
  }, 60_000);

  const fixtureWorkflow = process.env.SOD_RECHECK_FIXTURE_WORKFLOW;
  (fixtureWorkflow ? it : it.skip)(
    'records the pre-patch fixture (SOD_RECHECK_FIXTURE_WORKFLOW = the pre-patch workflow file)',
    async () => {
      const pre = await createWorkflowTestHarness({
        workflowsPath: path.resolve(process.cwd(), fixtureWorkflow ?? ''),
        ...workers(),
      });
      try {
        // The pre-patch workflow drops a decision that arrives before its step waits: approve
        // once the approver was asked
        const handle = await pre.env.client.workflow.start(accessRequestApprovalWorkflow, {
          args: [input],
          taskQueue: pre.taskQueue,
          workflowId: 'access-request-e2e-pre-sod-recheck',
        });
        for (let i = 0; i < 100 && notifyApprover.mock.calls.length === 0; i++) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        await handle.signal(approvalDecisionSignal, approval);
        await handle.result();
        expect(recheckSodBeforeProvisioning).not.toHaveBeenCalled();
        expect(statuses()).toEqual(['PROVISIONING', 'ACTIVE']);
        fs.writeFileSync(PRE_PATCH_HISTORY, historyJSON(await handle.fetchHistory()));
      } finally {
        await pre.shutdown();
      }
    },
    120_000,
  );
});
