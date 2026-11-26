/**
 * Recertification Scheduler Workflow Tests
 *
 * Uses pure Jest mocks instead of TestWorkflowEnvironment.
 */

const mockActivities: Record<string, jest.Mock> = {};
const stableRefs: Record<string, (...args: unknown[]) => unknown> = {};

jest.mock('@temporalio/workflow', () => ({
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
  setHandler: jest.fn(),
  sleep: jest.fn().mockResolvedValue(undefined),
  condition: jest.fn().mockResolvedValue(true),
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
}));

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

import { recertificationSchedulerWorkflow } from './recertification-scheduler.workflow';

beforeEach(() => {
  Object.keys(mockActivities).forEach((key) => delete mockActivities[key]);
  jest.clearAllMocks();
});

describe('Recertification Scheduler Workflow', () => {
  it('asks the activity for the campaigns due at the workflow time, as an ISO date', async () => {
    // workflowNow() is the ordinary clock outside a Temporal workflow
    jest.useFakeTimers({ now: new Date('2026-11-24T02:00:00.000Z') });
    mockActivities.runRecertificationScheduler = jest.fn().mockResolvedValue({
      campaignsCreated: 2,
      errors: 1,
    });

    try {
      const result = await recertificationSchedulerWorkflow({ tenantId: 'test-tenant' });

      expect(result).toEqual({ campaignsCreated: 2, errors: 1 });
      expect(mockActivities.runRecertificationScheduler).toHaveBeenCalledWith(
        'test-tenant',
        '2026-11-24T02:00:00.000Z',
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('throws when runRecertificationScheduler activity fails', async () => {
    mockActivities.runRecertificationScheduler = jest
      .fn()
      .mockRejectedValue(new Error('Scheduler failed'));

    await expect(recertificationSchedulerWorkflow({ tenantId: 'test-tenant' })).rejects.toThrow(
      /Scheduler failed/,
    );

    expect(mockActivities.runRecertificationScheduler).toHaveBeenCalledWith(
      'test-tenant',
      expect.any(String),
    );
  });

  it('handles undefined input gracefully', async () => {
    mockActivities.runRecertificationScheduler = jest.fn().mockResolvedValue({
      campaignsCreated: 0,
      errors: 0,
    });

    const result = await recertificationSchedulerWorkflow(undefined);

    expect(result.campaignsCreated).toBe(0);
    // When input is undefined, tenantId defaults to ''
    expect(mockActivities.runRecertificationScheduler).toHaveBeenCalledWith('', expect.any(String));
  });
});
