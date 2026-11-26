/**
 * Risk Score Calculation Workflow Tests
 *
 * Uses pure Jest mocks (no TestWorkflowEnvironment) for Windows compatibility. The time-skipping
 * server runs the per-tenant path end to end in test/workflows/risk-score-per-tenant.
 */

const mockActivities: Record<string, jest.Mock> = {};
const stableRefs: Record<string, (...args: unknown[]) => unknown> = {};
const mockPatched = jest.fn((_id: string) => true);
const mockContinueAsNew = jest.fn(async (..._args: unknown[]): Promise<never> => {
  throw new Error('continued as new');
});

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
  patched: (id: string) => mockPatched(id),
  continueAsNew: (...args: unknown[]) => mockContinueAsNew(...args),
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('../infrastructure/config/retry-policies', () => ({
  SCHEDULED_SYNC_RETRY: { maximumAttempts: 2 },
  QUERY_RETRY: { maximumAttempts: 2 },
  HEARTBEAT_BATCH_RETRY: { maximumAttempts: 5 },
}));

import { riskScoreCalculationWorkflow, TENANTS_PER_RUN } from './risk-score-calculation.workflow';

describe('Risk Score Calculation Workflow', () => {
  beforeEach(() => {
    Object.keys(mockActivities).forEach((key) => delete mockActivities[key]);
    mockPatched.mockReset().mockReturnValue(true);
    mockContinueAsNew.mockClear();
  });

  describe('a history from before the per-tenant patch', () => {
    beforeEach(() => mockPatched.mockReturnValue(false));

    it('handles batch errors', async () => {
      mockActivities.runRiskScoreBatch = jest.fn().mockResolvedValue({ processed: 45, errors: 5 });

      const result = await riskScoreCalculationWorkflow({ tenantId: 'test-tenant' });

      expect(result.processed).toBe(45);
      expect(result.errors).toBe(5);
    });

    it('propagates error when runRiskScoreBatch throws', async () => {
      mockActivities.runRiskScoreBatch = jest.fn().mockRejectedValue(new Error('Batch failed'));

      await expect(riskScoreCalculationWorkflow({ tenantId: 'test-tenant' })).rejects.toThrow(
        /Batch failed/,
      );
    });

    it('handles undefined input gracefully', async () => {
      mockActivities.runRiskScoreBatch = jest.fn().mockResolvedValue({ processed: 10, errors: 0 });

      const result = await riskScoreCalculationWorkflow(undefined);

      expect(result.processed).toBe(10);
      // When input is undefined, tenantId defaults to ''
      expect(mockActivities.runRiskScoreBatch).toHaveBeenCalledWith('', expect.any(String), 100);
    });
  });

  /** r2-05 N6: one 30-minute activity for every tenant kept nothing when it timed out. */
  describe('per tenant', () => {
    it('scores the named tenant in its own activity', async () => {
      mockActivities.listRiskScoreTenants = jest.fn().mockResolvedValue(['test-tenant']);
      mockActivities.runRiskScoreTenant = jest.fn().mockResolvedValue({ processed: 45, errors: 5 });

      const result = await riskScoreCalculationWorkflow({ tenantId: 'test-tenant' });

      expect(result).toEqual({ processed: 45, errors: 5 });
      expect(mockPatched).toHaveBeenCalledWith('risk-score-calculation:per-tenant');
      expect(mockActivities.listRiskScoreTenants).toHaveBeenCalledWith('test-tenant');
      expect(mockActivities.runRiskScoreTenant).toHaveBeenCalledWith(
        'test-tenant',
        expect.any(String),
        100,
      );
      expect(mockActivities.runRiskScoreBatch).toBeUndefined();
    });

    it('counts a tenant that fails for good as one error and scores the next one', async () => {
      mockActivities.listRiskScoreTenants = jest.fn().mockResolvedValue(['a', 'b', 'c']);
      mockActivities.runRiskScoreTenant = jest
        .fn()
        .mockResolvedValueOnce({ processed: 10, errors: 0 })
        .mockRejectedValueOnce(new Error('Activity task timed out'))
        .mockResolvedValueOnce({ processed: 5, errors: 1 });

      const result = await riskScoreCalculationWorkflow({});

      expect(result).toEqual({ processed: 15, errors: 2 });
      expect(mockActivities.runRiskScoreTenant).toHaveBeenCalledTimes(3);
    });

    it('continues as new with the rest after the tenants one run takes', async () => {
      const tenants = Array.from({ length: TENANTS_PER_RUN + 2 }, (_, i) => `t-${i}`);
      mockActivities.listRiskScoreTenants = jest.fn().mockResolvedValue(tenants);
      mockActivities.runRiskScoreTenant = jest.fn().mockResolvedValue({ processed: 2, errors: 0 });

      await expect(riskScoreCalculationWorkflow({ batchSize: 25 })).rejects.toThrow(
        'continued as new',
      );

      expect(mockActivities.runRiskScoreTenant).toHaveBeenCalledTimes(TENANTS_PER_RUN);
      const [next] = mockContinueAsNew.mock.calls[0] as [Record<string, unknown>];
      expect(next).toEqual({
        batchSize: 25,
        remainingTenants: tenants.slice(TENANTS_PER_RUN),
        nowIso: mockActivities.runRiskScoreTenant.mock.calls[0][1],
        carried: { processed: 2 * TENANTS_PER_RUN, errors: 0 },
      });
    });

    it('takes the tenants, the run time and the counts a run continued with', async () => {
      mockActivities.listRiskScoreTenants = jest.fn();
      mockActivities.runRiskScoreTenant = jest.fn().mockResolvedValue({ processed: 3, errors: 1 });

      const result = await riskScoreCalculationWorkflow({
        remainingTenants: ['x', 'y'],
        nowIso: '2026-11-26T02:00:00.000Z',
        carried: { processed: 100, errors: 2 },
      });

      expect(result).toEqual({ processed: 106, errors: 4 });
      expect(mockActivities.listRiskScoreTenants).not.toHaveBeenCalled();
      expect(mockActivities.runRiskScoreTenant.mock.calls).toEqual([
        ['x', '2026-11-26T02:00:00.000Z', 100],
        ['y', '2026-11-26T02:00:00.000Z', 100],
      ]);
    });
  });
});
