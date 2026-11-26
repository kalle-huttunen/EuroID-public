/**
 * Scheduled Sync Workflow Tests
 *
 * Tests the simple proxy workflow that delegates to the runScheduledSync activity.
 * Covers happy path, error result passthrough, and activity-level failure.
 *
 * Uses pure Jest mocks (no TestWorkflowEnvironment) for Windows compatibility.
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
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('../infrastructure/config/retry-policies', () => ({
  SCHEDULED_SYNC_RETRY: { maximumAttempts: 2 },
}));

import { scheduledSyncWorkflow } from './scheduled-sync.workflow';
import type { ScheduledSyncInput, ScheduledSyncResult } from './scheduled-sync.workflow';

describe('Scheduled Sync Workflow', () => {
  const defaultInput: ScheduledSyncInput = {
    tenantId: 'test-tenant',
    connectorName: 'entra',
    correlationId: 'corr-123',
  };

  beforeEach(() => {
    Object.keys(mockActivities).forEach((key) => delete mockActivities[key]);
  });

  it('completes happy path and returns activity result', async () => {
    const expectedResult: ScheduledSyncResult = {
      success: true,
      connectorName: 'entra',
      tenantId: 'test-tenant',
      type: 'ingest',
      count: 42,
    };

    mockActivities.runScheduledSync = jest.fn().mockResolvedValue(expectedResult);

    const result = await scheduledSyncWorkflow(defaultInput);

    expect(result).toEqual(expectedResult);
    // The activity gets the whole input: tenant, connector and correlation id
    expect(mockActivities.runScheduledSync).toHaveBeenCalledWith(defaultInput);
  });

  it('returns error result without throwing when activity reports failure', async () => {
    const errorResult: ScheduledSyncResult = {
      success: false,
      connectorName: 'entra',
      tenantId: 'test-tenant',
      type: 'discover',
      error: 'Connection refused',
    };

    mockActivities.runScheduledSync = jest.fn().mockResolvedValue(errorResult);

    const result = await scheduledSyncWorkflow(defaultInput);

    expect(result).toEqual(errorResult);
    expect(result.success).toBe(false);
    expect(result.type).toBe('discover');
    expect(result.error).toBe('Connection refused');
    expect(result.count).toBeUndefined();
    expect(mockActivities.runScheduledSync).toHaveBeenCalledWith(defaultInput);
  });

  it('propagates error when activity throws', async () => {
    mockActivities.runScheduledSync = jest
      .fn()
      .mockRejectedValue(new Error('Unrecoverable failure'));

    await expect(scheduledSyncWorkflow(defaultInput)).rejects.toThrow('Unrecoverable failure');

    expect(mockActivities.runScheduledSync).toHaveBeenCalledWith(defaultInput);
  });
});
