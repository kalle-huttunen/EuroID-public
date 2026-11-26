/**
 * runOperation's Golden Record write: with the hub-compensation patch it keeps what the write
 * overwrote by reference (result.hubWrite), under a key that stays the same for every attempt;
 * older histories replay the plain saveToHub.
 */
const mockActivities: Record<string, jest.Mock> = {};
const mockPatched = jest.fn<boolean, [string]>();

jest.mock('@temporalio/workflow', () => ({
  proxyActivities: jest.fn(
    () =>
      new Proxy(
        {},
        {
          get:
            (_target: unknown, prop: string) =>
            (...args: unknown[]) =>
              mockActivities[prop](...args),
        },
      ),
  ),
  patched: (id: string) => mockPatched(id),
  workflowInfo: () => ({ workflowId: 'bulk-1', runId: 'run-7' }),
  isCancellation: () => false,
  ActivityFailure: class extends Error {
    constructor(
      message: string,
      _activityType: string,
      _activityId: string | undefined,
      _retryState: unknown,
      _identity: string | undefined,
      public readonly cause?: Error,
    ) {
      super(message);
    }
  },
  ApplicationFailure: class extends Error {},
}));

jest.mock('../infrastructure/config/retry-policies', () => ({
  BATCH_OPERATION_RETRY: { maximumAttempts: 3 },
}));

import { ActivityFailure } from '@temporalio/workflow';
import { RetryState } from '@temporalio/common';
import { runOperation } from './bulk-provisioning-operation';
import { BulkOperationType, OperationPriority, type BulkOperation } from './workflow-types';

const op: BulkOperation = {
  id: 'op-1',
  type: BulkOperationType.UPDATE,
  priority: OperationPriority.NORMAL,
  targetSystems: ['entra-id'],
  user: { email: 'ada@example.com', firstName: 'Ada', lastName: 'Lovelace' },
} as BulkOperation;

beforeEach(() => {
  Object.keys(mockActivities).forEach((key) => delete mockActivities[key]);
  mockPatched.mockReset().mockReturnValue(true);
  mockActivities.executeSystemOperation = jest.fn().mockResolvedValue({
    result: { system: 'entra-id', success: true, apiCallsUsed: 1, durationMs: 1 },
    rateLimitHits: 0,
  });
  mockActivities.saveToHub = jest.fn().mockResolvedValue('identity-1');
  mockActivities.saveToHubWithSnapshot = jest
    .fn()
    .mockResolvedValue({ identityId: 'identity-1', snapshotRef: 'snap-1' });
});

describe('runOperation Golden Record write', () => {
  it('keeps the write by reference, keyed by run and operation', async () => {
    const result = await runOperation(op, 'tenant-a');

    expect(mockPatched).toHaveBeenCalledWith('bulk-provisioning:hub-compensation');
    expect(mockActivities.saveToHubWithSnapshot).toHaveBeenCalledWith(
      op.user,
      'tenant-a',
      'run-7/op-1',
    );
    expect(mockActivities.saveToHub).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: true,
      hubWrite: { identityId: 'identity-1', snapshotRef: 'snap-1' },
    });
  });

  it('has no Hub write to undo when the save failed', async () => {
    mockActivities.saveToHubWithSnapshot.mockRejectedValue(
      new ActivityFailure(
        'Activity task failed',
        'saveToHubWithSnapshot',
        '1',
        RetryState.MAXIMUM_ATTEMPTS_REACHED,
        'worker',
        new Error('Hub down'),
      ),
    );

    const result = await runOperation(op, 'tenant-a');

    expect(result).toMatchObject({
      success: false,
      error: 'Golden Record save failed: Hub down',
      systemResults: [],
    });
    expect(result.hubWrite).toBeUndefined();
    expect(mockActivities.executeSystemOperation).not.toHaveBeenCalled();
  });

  it('replays saveToHub for histories from before the patch', async () => {
    mockPatched.mockImplementation((id) => id !== 'bulk-provisioning:hub-compensation');

    const result = await runOperation(op, 'tenant-a');

    expect(mockActivities.saveToHub).toHaveBeenCalledWith(op.user, 'tenant-a');
    expect(mockActivities.saveToHubWithSnapshot).not.toHaveBeenCalled();
    expect(result.hubWrite).toBeUndefined();
  });
});

describe('runOperation system activities', () => {
  // A trailing argument (no patch): the id of the identity the Hub write saved, so the target's
  // provisioning events go under it (identity timeline), never under the email
  it('passes each system a snapshot key that is the same for every attempt, and the identity id', async () => {
    await runOperation({ ...op, targetSystems: ['entra-id', 'github'] }, 'tenant-a');

    expect(mockPatched).toHaveBeenCalledWith('bulk-provisioning:entra-snapshot-key');
    expect(mockActivities.executeSystemOperation.mock.calls).toEqual([
      [
        expect.objectContaining({ id: 'op-1' }),
        'entra-id',
        'tenant-a',
        undefined,
        'run-7/op-1/entra-id',
        'identity-1',
      ],
      [
        expect.objectContaining({ id: 'op-1' }),
        'github',
        'tenant-a',
        undefined,
        'run-7/op-1/github',
        'identity-1',
      ],
    ]);
  });

  it('has no identity id to pass for histories that saved with saveToHub', async () => {
    mockPatched.mockImplementation((id) => id !== 'bulk-provisioning:hub-compensation');

    await runOperation(op, 'tenant-a');

    expect(mockActivities.executeSystemOperation).toHaveBeenCalledWith(
      op,
      'entra-id',
      'tenant-a',
      undefined,
      'run-7/op-1/entra-id',
      undefined,
    );
  });

  it('calls the activity without a key for histories from before the patch', async () => {
    mockPatched.mockImplementation((id) => id !== 'bulk-provisioning:entra-snapshot-key');

    await runOperation(op, 'tenant-a');

    expect(mockActivities.executeSystemOperation).toHaveBeenCalledWith(op, 'entra-id', 'tenant-a');
  });
});
