/**
 * Access Review Workflow Tests
 *
 * Tests campaign deadline handling, progress query, early completion, and revocation through
 * the connectors (patch access-review:connector-revocation) next to the pre-patch flow that
 * older histories replay. Uses pure Jest mocks instead of TestWorkflowEnvironment.
 */

const mockActivities: Record<string, jest.Mock> = {};
const stableRefs: Record<string, (...args: unknown[]) => unknown> = {};
const mockPatch = { applied: true };

let setHandlerMock: jest.Mock;
let sleepMock: jest.Mock;
let continueAsNewMock: jest.Mock;

jest.mock('@temporalio/workflow', () => {
  setHandlerMock = jest.fn();
  sleepMock = jest.fn().mockResolvedValue(undefined);
  continueAsNewMock = jest.fn().mockResolvedValue(undefined);
  return {
    patched: jest.fn(() => mockPatch.applied),
    ActivityFailure: class ActivityFailure extends Error {},
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
    defineSignal: jest.fn(() => Symbol('signal')),
    setHandler: setHandlerMock,
    sleep: sleepMock,
    condition: jest.fn().mockResolvedValue(true),
    continueAsNew: continueAsNewMock,
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

import {
  accessReviewWorkflow,
  getCampaignProgressQuery,
  signalItemDecidedSignal,
} from './access-review.workflow';
import { MAX_REVOCATION_BATCHES_PER_RUN } from './access-review-revocation';

beforeEach(() => {
  Object.keys(mockActivities).forEach((key) => delete mockActivities[key]);
  jest.clearAllMocks();
  sleepMock.mockResolvedValue(undefined);
  mockPatch.applied = true;
  mockActivities.listRevocationTasks = jest.fn().mockResolvedValue({ tasks: [], more: false });
  mockActivities.recordRevocationResults = jest.fn().mockResolvedValue(undefined);
  mockActivities.revokeReviewAccess = jest.fn().mockResolvedValue({ outcome: 'removed' });
});

/** The handler registered for the decision signal. */
const decisionSignalHandler = (): (() => void) =>
  setHandlerMock.mock.calls.find((call: unknown[]) => call[0] === signalItemDecidedSignal)[1];

describe('Access Review Workflow', () => {
  it('completes when deadline reached and pending items expired', async () => {
    const deadline = new Date(Date.now() + 1000);
    mockActivities.getCampaignProgress = jest
      .fn()
      .mockResolvedValueOnce({ total: 10, pending: 5, decided: 5 })
      .mockResolvedValueOnce({ total: 10, pending: 5, decided: 5 })
      .mockResolvedValue({ total: 10, pending: 5, decided: 5 });
    mockActivities.getRemainingMsUntilDeadline = jest.fn().mockResolvedValue(100);
    mockActivities.expirePendingItems = jest.fn().mockResolvedValue(undefined);
    mockActivities.executeRevocations = jest.fn().mockResolvedValue(undefined);
    mockActivities.completeCampaign = jest.fn().mockResolvedValue(undefined);
    mockActivities.checkAndEscalateOverdue = jest.fn().mockResolvedValue(undefined);

    await accessReviewWorkflow({ campaignId: 'camp-1', deadline, tenantId: 'test-tenant' });

    expect(mockActivities.getCampaignProgress).toHaveBeenCalled();
    expect(mockActivities.expirePendingItems).toHaveBeenCalledWith('camp-1', 'test-tenant');
    // Revocation goes through the connectors, not the Entra-only executeRevocations
    expect(mockActivities.executeRevocations).not.toHaveBeenCalled();
    // Patched runs ask for account items too (access-review:account-revocation)
    expect(mockActivities.listRevocationTasks).toHaveBeenCalledWith(
      'camp-1',
      'test-tenant',
      'test-workflow-id',
      true,
    );
    expect(mockActivities.completeCampaign).toHaveBeenCalledWith('camp-1', 'test-tenant');
  });

  it('pre-patch histories keep the old end: expire, executeRevocations, complete', async () => {
    mockPatch.applied = false;
    mockActivities.getCampaignProgress = jest
      .fn()
      .mockResolvedValue({ total: 10, pending: 5, decided: 5 });
    mockActivities.getRemainingMsUntilDeadline = jest.fn().mockResolvedValue(100);
    mockActivities.expirePendingItems = jest.fn().mockResolvedValue(undefined);
    mockActivities.executeRevocations = jest.fn().mockResolvedValue(undefined);
    mockActivities.completeCampaign = jest.fn().mockResolvedValue(undefined);
    mockActivities.checkAndEscalateOverdue = jest.fn().mockResolvedValue(undefined);

    await accessReviewWorkflow({
      campaignId: 'camp-1',
      deadline: new Date(Date.now() + 1000),
      tenantId: 'test-tenant',
    });

    expect(mockActivities.executeRevocations).toHaveBeenCalledWith('camp-1', 'test-tenant');
    expect(mockActivities.listRevocationTasks).not.toHaveBeenCalled();
    expect(mockActivities.completeCampaign).toHaveBeenCalledWith('camp-1', 'test-tenant');
  });

  it('getCampaignProgressQuery answers the latest progress the run read', async () => {
    const progress = () =>
      setHandlerMock.mock.calls.find(
        (call: unknown[]) => call[0] === getCampaignProgressQuery,
      )[1]();
    let whileWaiting: unknown;
    // One minute to the deadline: the run reads the progress, waits, reads it again
    sleepMock.mockImplementationOnce(async () => {
      whileWaiting = progress();
    });
    mockActivities.getCampaignProgress = jest
      .fn()
      .mockResolvedValueOnce({ total: 5, pending: 2, decided: 3 })
      .mockResolvedValue({ total: 5, pending: 0, decided: 5 });
    mockActivities.getRemainingMsUntilDeadline = jest.fn().mockResolvedValue(60_000);
    mockActivities.expirePendingItems = jest.fn().mockResolvedValue(undefined);
    mockActivities.completeCampaign = jest.fn().mockResolvedValue(undefined);
    mockActivities.checkAndEscalateOverdue = jest.fn().mockResolvedValue(undefined);

    await accessReviewWorkflow({
      campaignId: 'camp-2',
      deadline: new Date(Date.now() + 60_000),
      tenantId: 'test-tenant',
    });

    expect(whileWaiting).toEqual({ total: 5, pending: 2, decided: 3 });
    expect(progress()).toEqual({ total: 5, pending: 0, decided: 5 });
  });

  it('completes early when signalItemDecidedSignal fires (all items decided)', async () => {
    const deadline = new Date(Date.now() + 600_000);
    // All calls return pending=0 (all decided) so the loop breaks early
    mockActivities.getCampaignProgress = jest
      .fn()
      .mockResolvedValue({ total: 10, pending: 0, decided: 10 });
    mockActivities.getRemainingMsUntilDeadline = jest.fn().mockResolvedValue(600_000);
    mockActivities.expirePendingItems = jest.fn().mockResolvedValue(undefined);
    mockActivities.executeRevocations = jest.fn().mockResolvedValue(undefined);
    mockActivities.completeCampaign = jest.fn().mockResolvedValue(undefined);
    mockActivities.checkAndEscalateOverdue = jest.fn().mockResolvedValue(undefined);

    await accessReviewWorkflow({ campaignId: 'camp-3', deadline, tenantId: 'test-tenant' });

    // Early exit: expirePendingItems should NOT be called since pending=0
    expect(mockActivities.expirePendingItems).not.toHaveBeenCalled();
    // ...but the revoked decisions are still removed (the pre-patch flow skipped them)
    expect(mockActivities.listRevocationTasks).toHaveBeenCalledWith(
      'camp-3',
      'test-tenant',
      'test-workflow-id',
      true,
    );
    expect(mockActivities.completeCampaign).toHaveBeenCalledWith('camp-3', 'test-tenant');
  });

  describe('a decision signal while items are still pending', () => {
    function campaignWithOneEarlyDecision() {
      // The first decision arrives during the first minute; items stay pending until the 3rd check
      sleepMock.mockImplementationOnce(async () => decisionSignalHandler()());
      mockActivities.getCampaignProgress = jest
        .fn()
        .mockResolvedValueOnce({ total: 3, pending: 3, decided: 0 })
        .mockResolvedValueOnce({ total: 3, pending: 2, decided: 1 })
        .mockResolvedValueOnce({ total: 3, pending: 1, decided: 2 })
        .mockResolvedValue({ total: 3, pending: 0, decided: 3 });
      mockActivities.getRemainingMsUntilDeadline = jest.fn().mockResolvedValue(600_000);
      mockActivities.expirePendingItems = jest.fn().mockResolvedValue(undefined);
      mockActivities.executeRevocations = jest.fn().mockResolvedValue(undefined);
      mockActivities.completeCampaign = jest.fn().mockResolvedValue(undefined);
      mockActivities.checkAndEscalateOverdue = jest.fn().mockResolvedValue(undefined);
    }

    it('pre-patch: ended the loop after that minute and expired the others (kept for replay)', async () => {
      mockPatch.applied = false;
      campaignWithOneEarlyDecision();
      await accessReviewWorkflow({ campaignId: 'c', deadline: new Date(), tenantId: 't' });

      expect(sleepMock).toHaveBeenCalledTimes(1);
      expect(mockActivities.expirePendingItems).toHaveBeenCalledWith('c', 't');
    });
  });

  it('continues as new with resumeRevocations when revocation batches remain', async () => {
    let n = 0;
    mockActivities.listRevocationTasks = jest.fn(async () => ({
      tasks: [{ itemId: `i${n++}`, entitlementIndex: 0, connector: 'okta' }],
      more: true,
    }));
    mockActivities.getCampaignProgress = jest
      .fn()
      .mockResolvedValue({ total: 1, pending: 0, decided: 1 });
    mockActivities.getRemainingMsUntilDeadline = jest.fn().mockResolvedValue(0);
    mockActivities.completeCampaign = jest.fn().mockResolvedValue(undefined);
    const deadline = new Date();

    await accessReviewWorkflow({ campaignId: 'c', deadline, tenantId: 't' });

    expect(mockActivities.listRevocationTasks).toHaveBeenCalledTimes(
      MAX_REVOCATION_BATCHES_PER_RUN,
    );
    expect(continueAsNewMock).toHaveBeenCalledWith({
      campaignId: 'c',
      deadline,
      tenantId: 't',
      resumeRevocations: true,
    });
    expect(mockActivities.completeCampaign).not.toHaveBeenCalled();
  });

  it('a resumed run goes straight to the remaining revocations, then completes', async () => {
    mockActivities.getCampaignProgress = jest.fn();
    mockActivities.getRemainingMsUntilDeadline = jest.fn();
    mockActivities.completeCampaign = jest.fn().mockResolvedValue(undefined);

    await accessReviewWorkflow({
      campaignId: 'c',
      deadline: new Date(),
      tenantId: 't',
      resumeRevocations: true,
    });

    expect(mockActivities.getRemainingMsUntilDeadline).not.toHaveBeenCalled();
    expect(mockActivities.listRevocationTasks).toHaveBeenCalledWith(
      'c',
      't',
      'test-workflow-id',
      true,
    );
    expect(mockActivities.completeCampaign).toHaveBeenCalledWith('c', 't');
  });
});
