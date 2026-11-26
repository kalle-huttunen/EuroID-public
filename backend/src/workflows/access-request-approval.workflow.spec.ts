/**
 * Access Request Approval Workflow Tests
 *
 * Tests single-step approval, multi-step approval, rejection, timeout, cancellation, delegation
 * (the delegate is asked once) and a time-bound request whose end date passed before approval
 * completed. Uses pure Jest mocks instead of TestWorkflowEnvironment; the Temporal e2e and the
 * replay of histories from before each patch are in test/workflows/.
 */

const mockActivities: Record<string, jest.Mock> = {};
const stableRefs: Record<string, (...args: unknown[]) => unknown> = {};

let conditionMock: jest.Mock;
let setHandlerMock: jest.Mock;
let patchedMock: jest.Mock;

jest.mock('@temporalio/workflow', () => {
  conditionMock = jest.fn().mockResolvedValue(true);
  setHandlerMock = jest.fn();
  patchedMock = jest.fn(() => true);
  return {
    patched: (...args: unknown[]) => patchedMock(...args),
    deprecatePatch: jest.fn(),
    proxyActivities: jest.fn(
      () =>
        new Proxy(
          {},
          {
            get: (_target: unknown, prop: string) => {
              if (!stableRefs[prop]) {
                if (!mockActivities[prop]) mockActivities[prop] = jest.fn();
                stableRefs[prop] = (...args: unknown[]) => mockActivities[prop](...args);
              }
              return stableRefs[prop];
            },
          },
        ),
    ),
    defineQuery: jest.fn(() => Symbol('query')),
    defineSignal: jest.fn((name: string) => Symbol(name)),
    setHandler: setHandlerMock,
    sleep: jest.fn().mockResolvedValue(undefined),
    condition: (...args: unknown[]) => conditionMock(...args),
    log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    ApplicationFailure: {
      nonRetryable: (msg: string, type?: string) => {
        const err = new Error(msg);
        (err as any).type = type;
        return err;
      },
    },
    workflowInfo: jest.fn(() => ({ workflowId: 'test-workflow-id' })),
    executeChild: jest.fn().mockResolvedValue(undefined),
    ParentClosePolicy: {
      PARENT_CLOSE_POLICY_TERMINATE: 1,
      PARENT_CLOSE_POLICY_ABANDON: 2,
    },
  };
});

jest.mock('../infrastructure/config/retry-policies', () => ({
  RECONCILIATION_RETRY: { maximumAttempts: 2 },
  CONNECTOR_RETRY: { maximumAttempts: 5 },
  HEALTH_CHECK_RETRY: { maximumAttempts: 3 },
  QUERY_RETRY: { maximumAttempts: 2 },
  BATCH_OPERATION_RETRY: { maximumAttempts: 3 },
  ACCESS_REVIEW_RETRY: { maximumAttempts: 3 },
  ARCHIVAL_RETRY: { maximumAttempts: 3 },
  SCHEDULED_SYNC_RETRY: { maximumAttempts: 2 },
}));

import { accessRequestApprovalWorkflow } from './access-request-approval.workflow';

beforeEach(() => {
  Object.keys(mockActivities).forEach((key) => delete mockActivities[key]);
  jest.clearAllMocks();
  patchedMock.mockReturnValue(true);
  // The SoD re-check before fulfilment passes unless a test says otherwise
  mockActivities.recheckSodBeforeProvisioning = jest.fn().mockResolvedValue({ passed: true });
});

/**
 * Helper: simulate signal by calling the registered signal handler.
 * The workflow registers handlers via setHandler; we find the right one
 * and invoke it with the payload.
 */
function findSignalHandler(signalSymbol: symbol): Function | undefined {
  const call = setHandlerMock.mock.calls.find((c: unknown[]) => c[0] === signalSymbol);
  return call ? call[1] : undefined;
}

describe('Access Request Approval Workflow', () => {
  it('provisions directly when no approval steps', async () => {
    mockActivities.getAccessRequest = jest.fn().mockResolvedValue({
      _id: 'req-1',
      requestId: 'req-1',
      approvalSteps: [],
      sodCheckResult: { passed: true },
      timeConstraint: undefined,
    });
    mockActivities.updateRequestStatus = jest.fn().mockResolvedValue(undefined);
    mockActivities.provisionAccessRequest = jest.fn().mockResolvedValue(true);

    await accessRequestApprovalWorkflow({ requestId: 'req-1', tenantId: 'test-tenant' });

    expect(mockActivities.getAccessRequest).toHaveBeenCalledWith('req-1', 'test-tenant');
    // The SoD re-check claims the request (PROVISIONING) before fulfilment
    expect(mockActivities.recheckSodBeforeProvisioning).toHaveBeenCalledWith(
      'req-1',
      'test-tenant',
    );
    expect(mockActivities.updateRequestStatus).not.toHaveBeenCalledWith(
      'req-1',
      'PROVISIONING',
      undefined,
      'test-tenant',
    );
    expect(mockActivities.provisionAccessRequest).toHaveBeenCalledWith('req-1', 'test-tenant');
    expect(mockActivities.updateRequestStatus).toHaveBeenCalledWith(
      'req-1',
      'ACTIVE',
      expect.anything(),
      'test-tenant',
    );
  });

  it('returns when request not found', async () => {
    mockActivities.getAccessRequest = jest.fn().mockResolvedValue(null);
    mockActivities.updateRequestStatus = jest.fn();

    await accessRequestApprovalWorkflow({ requestId: 'nonexistent', tenantId: 'test-tenant' });

    expect(mockActivities.getAccessRequest).toHaveBeenCalledWith('nonexistent', 'test-tenant');
    expect(mockActivities.updateRequestStatus).not.toHaveBeenCalled();
  });

  it('a run started before the SoD re-check patch marks PROVISIONING itself and fulfils', async () => {
    patchedMock.mockReturnValue(false);
    mockActivities.getAccessRequest = jest.fn().mockResolvedValue({
      _id: 'req-1',
      requestId: 'req-1',
      approvalSteps: [],
      sodCheckResult: { passed: true },
    });
    mockActivities.updateRequestStatus = jest.fn().mockResolvedValue(undefined);
    mockActivities.provisionAccessRequest = jest.fn().mockResolvedValue(true);

    await accessRequestApprovalWorkflow({ requestId: 'req-1', tenantId: 'test-tenant' });

    expect(patchedMock).toHaveBeenCalledWith('access-request:sod-recheck-before-provision');
    expect(mockActivities.recheckSodBeforeProvisioning).not.toHaveBeenCalled();
    expect(mockActivities.updateRequestStatus).toHaveBeenCalledWith(
      'req-1',
      'PROVISIONING',
      undefined,
      'test-tenant',
    );
    expect(mockActivities.provisionAccessRequest).toHaveBeenCalledWith('req-1', 'test-tenant');
  });

  // Replaces 'rejects when SoD has critical blockers': createRequest never stores a result with
  // passed false, so that check at the start of the run could not act. The SoD decision of an
  // approved request is the re-check before fulfilment.
  it('fulfils nothing when the SoD re-check before fulfilment finds a Block conflict', async () => {
    mockActivities.getAccessRequest = jest.fn().mockResolvedValue({
      _id: 'req-2',
      requestId: 'req-2',
      approvalSteps: [],
      sodCheckResult: { passed: true },
    });
    mockActivities.updateRequestStatus = jest.fn().mockResolvedValue(undefined);
    mockActivities.provisionAccessRequest = jest.fn();
    mockActivities.recheckSodBeforeProvisioning = jest.fn().mockResolvedValue({ passed: false });

    await accessRequestApprovalWorkflow({ requestId: 'req-2', tenantId: 'test-tenant' });

    expect(mockActivities.recheckSodBeforeProvisioning).toHaveBeenCalledWith(
      'req-2',
      'test-tenant',
    );
    expect(mockActivities.provisionAccessRequest).not.toHaveBeenCalled();
    // The re-check stored REJECTED and the conflict; the workflow writes no status of its own
    expect(mockActivities.updateRequestStatus).not.toHaveBeenCalled();
  });

  it('does not re-check a request whose approval was rejected', async () => {
    mockActivities.getAccessRequest = jest.fn().mockResolvedValue({
      _id: 'req-8',
      requestId: 'req-8',
      approvalSteps: [{ approverId: 'a1' }],
      sodCheckResult: { passed: true },
    });
    mockActivities.updateRequestStatus = jest.fn().mockResolvedValue(undefined);
    mockActivities.notifyApprover = jest.fn().mockResolvedValue(undefined);
    conditionMock.mockImplementation(async () => {
      const handler = setHandlerMock.mock.calls.find(
        (c: unknown[]) => typeof c[1] === 'function' && c[1].length === 1,
      );
      if (handler) handler[1]({ stepIndex: 0, decision: 'reject' });
      return true;
    });

    await accessRequestApprovalWorkflow({ requestId: 'req-8', tenantId: 'test-tenant' });

    expect(mockActivities.recheckSodBeforeProvisioning).not.toHaveBeenCalled();
  });

  it('provisions after multi-step approval when both steps approved', async () => {
    mockActivities.getAccessRequest = jest.fn().mockResolvedValue({
      _id: 'req-3',
      requestId: 'req-3',
      approvalSteps: [{ approverId: 'a1' }, { approverId: 'a2' }],
      sodCheckResult: { passed: true },
      timeConstraint: undefined,
    });
    mockActivities.updateRequestStatus = jest.fn().mockResolvedValue(undefined);
    mockActivities.provisionAccessRequest = jest.fn().mockResolvedValue(true);
    mockActivities.notifyApprover = jest.fn().mockResolvedValue(undefined);

    // When condition is called, simulate the approval signal arriving.
    // The workflow calls condition() to wait for a signal. We simulate the signal
    // by calling the registered signal handler before resolving condition.
    let conditionCallCount = 0;
    conditionMock.mockImplementation(async (predicate: () => boolean) => {
      conditionCallCount++;
      // Find the approval signal handler (has 1 param, not the cancel handler which has 0)
      const handler = setHandlerMock.mock.calls.find(
        (c: unknown[]) => typeof c[1] === 'function' && c[1].length === 1,
      );
      if (handler) {
        // Simulate approval for the current step
        handler[1]({ stepIndex: conditionCallCount - 1, decision: 'approve' });
      }
      return true; // condition met
    });

    await accessRequestApprovalWorkflow({
      requestId: 'req-3',
      tenantId: 'test-tenant',
      approvalTimeoutDays: 30,
    });

    expect(mockActivities.notifyApprover).toHaveBeenCalledWith('req-3', 0, 'test-tenant');
    expect(mockActivities.provisionAccessRequest).toHaveBeenCalledWith('req-3', 'test-tenant');
    expect(mockActivities.updateRequestStatus).toHaveBeenCalledWith(
      'req-3',
      'ACTIVE',
      expect.anything(),
      'test-tenant',
    );
  });

  it('rejects when approvalDecisionSignal sends reject at step', async () => {
    mockActivities.getAccessRequest = jest.fn().mockResolvedValue({
      _id: 'req-4',
      requestId: 'req-4',
      approvalSteps: [{ approverId: 'a1' }],
      sodCheckResult: { passed: true },
      timeConstraint: undefined,
    });
    mockActivities.updateRequestStatus = jest.fn().mockResolvedValue(undefined);
    mockActivities.provisionAccessRequest = jest.fn();
    mockActivities.notifyApprover = jest.fn().mockResolvedValue(undefined);

    // Simulate rejection signal — find the approval handler (1 param), not cancel (0 params)
    conditionMock.mockImplementation(async () => {
      const handler = setHandlerMock.mock.calls.find(
        (c: unknown[]) => typeof c[1] === 'function' && c[1].length === 1,
      );
      if (handler) {
        handler[1]({ stepIndex: 0, decision: 'reject' });
      }
      return true;
    });

    await accessRequestApprovalWorkflow({ requestId: 'req-4', tenantId: 'test-tenant' });

    expect(mockActivities.updateRequestStatus).toHaveBeenCalledWith(
      'req-4',
      'REJECTED',
      undefined,
      'test-tenant',
    );
    expect(mockActivities.provisionAccessRequest).not.toHaveBeenCalled();
  });

  it('rejects when approval step times out with no signal', async () => {
    mockActivities.getAccessRequest = jest.fn().mockResolvedValue({
      _id: 'req-5',
      requestId: 'req-5',
      approvalSteps: [{ approverId: 'a1' }],
      sodCheckResult: { passed: true },
      timeConstraint: undefined,
    });
    mockActivities.updateRequestStatus = jest.fn().mockResolvedValue(undefined);
    mockActivities.provisionAccessRequest = jest.fn();
    mockActivities.notifyApprover = jest.fn().mockResolvedValue(undefined);

    // Simulate timeout: condition returns false (timed out)
    conditionMock.mockResolvedValue(false);

    await accessRequestApprovalWorkflow({
      requestId: 'req-5',
      tenantId: 'test-tenant',
      approvalTimeoutDays: 0,
    });

    expect(mockActivities.updateRequestStatus).toHaveBeenCalledWith(
      'req-5',
      'REJECTED',
      undefined,
      'test-tenant',
    );
    expect(mockActivities.provisionAccessRequest).not.toHaveBeenCalled();
  });

  it('cancels request when cancelRequestSignal received during approval', async () => {
    mockActivities.getAccessRequest = jest.fn().mockResolvedValue({
      _id: 'req-6',
      requestId: 'req-6',
      approvalSteps: [{ approverId: 'a1' }],
      sodCheckResult: { passed: true },
      timeConstraint: undefined,
    });
    mockActivities.updateRequestStatus = jest.fn().mockResolvedValue(undefined);
    mockActivities.provisionAccessRequest = jest.fn();
    mockActivities.notifyApprover = jest.fn().mockResolvedValue(undefined);

    // Simulate cancel signal: trigger the cancel handler, then condition resolves true
    conditionMock.mockImplementation(async (predicate: () => boolean) => {
      // Find the cancelRequestSignal handler (it has no payload arg — sets cancelled = true)
      // The cancel handler is the first setHandler call that sets cancelled = true
      const cancelHandlerCall = setHandlerMock.mock.calls.find((c: unknown[]) => {
        // The cancel handler is the one that takes no arguments (other than the signal symbol)
        // and sets cancelled = true
        if (typeof c[1] !== 'function') return false;
        // Cancel handler has 0 params, approval handler has 1 param
        return c[1].length === 0;
      });
      if (cancelHandlerCall) {
        cancelHandlerCall[1]();
      }
      return true;
    });

    await accessRequestApprovalWorkflow({
      requestId: 'req-6',
      tenantId: 'test-tenant',
      approvalTimeoutDays: 30,
    });

    expect(mockActivities.updateRequestStatus).toHaveBeenCalledWith(
      'req-6',
      'CANCELLED',
      undefined,
      'test-tenant',
    );
    expect(mockActivities.provisionAccessRequest).not.toHaveBeenCalled();
  });

  it('a run from before notify-delegate-once still asks the delegate twice (replay)', async () => {
    patchedMock.mockImplementation(
      (id: string) => id !== 'access-request-approval:notify-delegate-once',
    );
    mockActivities.getAccessRequest = jest.fn().mockResolvedValue({
      requestId: 'req-7',
      approvalSteps: [{ approverId: 'a1' }],
    });
    mockActivities.updateRequestStatus = jest.fn().mockResolvedValue(undefined);
    mockActivities.provisionAccessRequest = jest.fn().mockResolvedValue(true);
    mockActivities.notifyApprover = jest.fn().mockResolvedValue(undefined);
    let conditionCallCount = 0;
    conditionMock.mockImplementation(async () => {
      conditionCallCount++;
      const approvalHandler = setHandlerMock.mock.calls.find(
        (c: unknown[]) => typeof c[1] === 'function' && c[1].length === 1,
      );
      approvalHandler?.[1](
        conditionCallCount === 1
          ? { stepIndex: 0, decision: 'delegate', delegateTo: 'a2' }
          : { stepIndex: 0, decision: 'approve' },
      );
      return true;
    });

    await accessRequestApprovalWorkflow({ requestId: 'req-7', tenantId: 'test-tenant' });

    // The start, the delegate branch, the top of the loop: what the old history recorded
    expect(mockActivities.notifyApprover).toHaveBeenCalledTimes(3);
    expect(mockActivities.getAccessRequest).toHaveBeenCalledTimes(2);
  });
});

describe('Access Request Approval Workflow: end date passed before approval completed', () => {
  const DAY_MS = 86_400_000;

  /** One step, approved when the step waits; the request ends at `expiresAt`. */
  function approvedRequestEnding(expiresAt: string) {
    mockActivities.getAccessRequest = jest.fn().mockResolvedValue({
      requestId: 'req-9',
      approvalSteps: [{ approverId: 'a1' }],
      timeConstraint: { requestedDurationDays: 1, expiresAt },
    });
    mockActivities.updateRequestStatus = jest.fn().mockResolvedValue(undefined);
    mockActivities.provisionAccessRequest = jest.fn().mockResolvedValue(true);
    mockActivities.revokeAccessRequest = jest.fn().mockResolvedValue({ success: true });
    mockActivities.notifyApprover = jest.fn().mockResolvedValue(undefined);
    mockActivities.expireBeforeFulfilment = jest.fn().mockResolvedValue(undefined);
    conditionMock.mockImplementation(async () => {
      const handler = setHandlerMock.mock.calls.find(
        (c: unknown[]) => typeof c[1] === 'function' && c[1].length === 1,
      );
      handler?.[1]({ stepIndex: 0, decision: 'approve' });
      return true;
    });
  }

  it('does not fulfil it: the request ends EXPIRED with the reason', async () => {
    approvedRequestEnding(new Date(Date.now() - DAY_MS).toISOString());

    await accessRequestApprovalWorkflow({ requestId: 'req-9', tenantId: 'test-tenant' });

    expect(patchedMock).toHaveBeenCalledWith(
      'access-request-approval:end-date-passed-before-approval',
    );
    expect(mockActivities.expireBeforeFulfilment).toHaveBeenCalledWith('req-9', 'test-tenant');
    expect(mockActivities.recheckSodBeforeProvisioning).not.toHaveBeenCalled();
    expect(mockActivities.provisionAccessRequest).not.toHaveBeenCalled();
    expect(mockActivities.updateRequestStatus).not.toHaveBeenCalled();
    expect(mockActivities.revokeAccessRequest).not.toHaveBeenCalled();
  });

  it('a run from before the patch fulfils it and never revokes it (replay)', async () => {
    patchedMock.mockImplementation(
      (id: string) => id !== 'access-request-approval:end-date-passed-before-approval',
    );
    approvedRequestEnding(new Date(Date.now() - DAY_MS).toISOString());

    await accessRequestApprovalWorkflow({ requestId: 'req-9', tenantId: 'test-tenant' });

    expect(mockActivities.expireBeforeFulfilment).not.toHaveBeenCalled();
    expect(mockActivities.provisionAccessRequest).toHaveBeenCalledWith('req-9', 'test-tenant');
    expect(mockActivities.updateRequestStatus.mock.calls.map(([, status]) => status)).toEqual([
      'ACTIVE',
    ]);
    expect(mockActivities.revokeAccessRequest).not.toHaveBeenCalled();
  });

  it('an unreadable end date never counts as passed', async () => {
    approvedRequestEnding('not a date');

    await accessRequestApprovalWorkflow({ requestId: 'req-9', tenantId: 'test-tenant' });

    expect(mockActivities.expireBeforeFulfilment).not.toHaveBeenCalled();
    expect(mockActivities.provisionAccessRequest).toHaveBeenCalledWith('req-9', 'test-tenant');
    expect(mockActivities.revokeAccessRequest).not.toHaveBeenCalled();
  });
});
