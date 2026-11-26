/**
 * runRevocations: each revocation runs on its connector's own queue (where worker.ts registers
 * revokeReviewAccess), a failure is recorded as `failed` with the activity's reason while the
 * others still run, and batches continue until none is left or the run's budget is spent. A
 * cancel stops the batch after recording what it removed (patch
 * access-review-revocation:rethrow-cancellation). Temporal's workflow APIs are mocked; the e2e
 * spec runs it on the test server.
 */
const mockCalls: Array<{ queue?: string; name: string; args: unknown[] }> = [];
const mockImpl: Record<string, jest.Mock> = {};
const mockPatch = { applied: true, nonCancellable: false };

jest.mock('@temporalio/workflow', () => {
  class ActivityFailure extends Error {
    constructor(
      message: string,
      public readonly cause?: Error,
    ) {
      super(message);
    }
  }
  class CancelledFailure extends Error {}
  return {
    ActivityFailure,
    CancelledFailure,
    isCancellation: (err: unknown) =>
      err instanceof CancelledFailure ||
      (err instanceof ActivityFailure && err.cause instanceof CancelledFailure),
    patched: jest.fn(() => mockPatch.applied),
    CancellationScope: {
      nonCancellable: async <T>(fn: () => Promise<T>): Promise<T> => {
        mockPatch.nonCancellable = true;
        try {
          return await fn();
        } finally {
          mockPatch.nonCancellable = false;
        }
      },
    },
    proxyActivities: jest.fn(
      (options: { taskQueue?: string }) =>
        new Proxy(
          {},
          {
            get:
              (_target, name: string) =>
              (...args: unknown[]) => {
                mockCalls.push({ queue: options.taskQueue, name, args });
                return mockImpl[name](...args);
              },
          },
        ),
    ),
  };
});

import { runRevocations, MAX_REVOCATION_BATCHES_PER_RUN } from './access-review-revocation';
import type { RevocationTask } from '../shared/types/access-review-revocation';

const { ActivityFailure, CancelledFailure } = jest.requireMock('@temporalio/workflow') as {
  ActivityFailure: new (message: string, cause?: Error) => Error;
  CancelledFailure: new (message: string) => Error;
};

const TENANT = 'tenant-a';
const WF = 'wf-1';
const task = (itemId: string, connector: RevocationTask['connector']): RevocationTask => ({
  itemId,
  entitlementIndex: 0,
  connector,
});

beforeEach(() => {
  mockCalls.length = 0;
  mockPatch.applied = true;
  mockImpl.listRevocationTasks = jest.fn().mockResolvedValue({ tasks: [], more: false });
  mockImpl.recordRevocationResults = jest.fn().mockResolvedValue(undefined);
  mockImpl.revokeReviewAccess = jest
    .fn()
    .mockResolvedValue({ outcome: 'removed', detail: 'removed from group' });
});

describe('runRevocations', () => {
  it('records a failed removal with its reason and still runs the others', async () => {
    mockImpl.listRevocationTasks.mockResolvedValueOnce({
      tasks: [task('i1', 'ad'), task('i2', 'okta')],
      more: false,
    });
    mockImpl.revokeReviewAccess
      .mockRejectedValueOnce(
        new ActivityFailure(
          'Activity task failed',
          new Error('ad: invalid credentials (HTTP 400)'),
        ),
      )
      .mockResolvedValueOnce({ outcome: 'already-gone', detail: 'not a member any more' });

    await runRevocations('c1', TENANT, WF);

    expect(mockImpl.recordRevocationResults.mock.calls[0][1]).toEqual([
      {
        itemId: 'i1',
        entitlementIndex: 0,
        outcome: 'failed',
        reason: 'ad: invalid credentials (HTTP 400)',
      },
      {
        itemId: 'i2',
        entitlementIndex: 0,
        outcome: 'already-gone',
        detail: 'not a member any more',
      },
    ]);
  });

  it('keeps taking batches while the last one was full, then finishes', async () => {
    mockImpl.listRevocationTasks
      .mockResolvedValueOnce({ tasks: [task('i1', 'scim')], more: true })
      .mockResolvedValueOnce({ tasks: [], more: true }) // only manual-action entitlements
      .mockResolvedValueOnce({ tasks: [task('i2', 'scim')], more: false });

    await expect(runRevocations('c1', TENANT, WF)).resolves.toEqual({ finished: true });
    expect(mockImpl.listRevocationTasks).toHaveBeenCalledTimes(3);
    expect(mockImpl.recordRevocationResults).toHaveBeenCalledTimes(2);
  });

  it("stops at the run's batch budget so the workflow can continue as new", async () => {
    let n = 0;
    mockImpl.listRevocationTasks.mockImplementation(async () => ({
      tasks: [task(`i${n++}`, 'okta')],
      more: true,
    }));

    await expect(runRevocations('c1', TENANT, WF)).resolves.toEqual({ finished: false });
    expect(mockImpl.listRevocationTasks).toHaveBeenCalledTimes(MAX_REVOCATION_BATCHES_PER_RUN);
  });

  it('stops instead of revoking again when a recorded task comes back', async () => {
    mockImpl.listRevocationTasks.mockResolvedValue({ tasks: [task('i1', 'okta')], more: true });

    await expect(runRevocations('c1', TENANT, WF)).resolves.toEqual({ finished: true });
    expect(mockImpl.revokeReviewAccess).toHaveBeenCalledTimes(1);
  });

  it('records nothing when there is nothing to revoke', async () => {
    await expect(runRevocations('c1', TENANT, WF)).resolves.toEqual({ finished: true });
    expect(mockImpl.recordRevocationResults).not.toHaveBeenCalled();
  });

  it('asks for account items only when told to, and removes them on the default queue', async () => {
    mockImpl.revokeReviewAccount = jest
      .fn()
      .mockRejectedValueOnce(
        new ActivityFailure('Activity task failed', new Error('github: forbidden (HTTP 403)')),
      );
    mockImpl.listRevocationTasks.mockResolvedValueOnce({
      tasks: [task('i1', 'account'), task('i2', 'okta')],
      more: false,
    });

    await runRevocations('c1', TENANT, WF, true);

    expect(mockImpl.listRevocationTasks).toHaveBeenCalledWith('c1', TENANT, WF, true);
    expect(
      mockCalls.filter((c) => c.name.startsWith('revoke')).map((c) => [c.name, c.queue]),
    ).toEqual([
      ['revokeReviewAccount', undefined],
      ['revokeReviewAccess', 'provisioning-okta'],
    ]);
    expect(mockImpl.recordRevocationResults.mock.calls[0][1][0]).toEqual({
      itemId: 'i1',
      entitlementIndex: 0,
      outcome: 'failed',
      reason: 'github: forbidden (HTTP 403)',
    });

    await runRevocations('c2', TENANT, WF);
    expect(mockImpl.listRevocationTasks).toHaveBeenLastCalledWith('c2', TENANT, WF, false);
  });

  describe('a cancel during a batch', () => {
    /** Three tasks; the second removal is cancelled while it runs. */
    function cancelSecond(): void {
      mockImpl.listRevocationTasks.mockResolvedValueOnce({
        tasks: [task('i1', 'entra'), task('i2', 'ad'), task('i3', 'okta')],
        more: false,
      });
      mockImpl.revokeReviewAccess
        .mockResolvedValueOnce({ outcome: 'removed', detail: 'removed from group' })
        .mockRejectedValueOnce(
          new ActivityFailure('Activity task cancelled', new CancelledFailure('cancelled')),
        );
    }

    it('stops the batch and records the removals already made out of the cancelled scope', async () => {
      cancelSecond();
      const recordedOutOfScope: boolean[] = [];
      mockImpl.recordRevocationResults.mockImplementation(async () => {
        recordedOutOfScope.push(mockPatch.nonCancellable);
      });

      await expect(runRevocations('c1', TENANT, WF)).rejects.toThrow('Activity task cancelled');

      expect(mockImpl.revokeReviewAccess).toHaveBeenCalledTimes(2);
      expect(mockImpl.recordRevocationResults).toHaveBeenCalledWith(
        'c1',
        [{ itemId: 'i1', entitlementIndex: 0, outcome: 'removed', detail: 'removed from group' }],
        TENANT,
        WF,
      );
      expect(recordedOutOfScope).toEqual([true]);
    });

    it('records nothing when the first removal is cancelled', async () => {
      mockImpl.listRevocationTasks.mockResolvedValueOnce({
        tasks: [task('i1', 'ad')],
        more: false,
      });
      mockImpl.revokeReviewAccess.mockRejectedValueOnce(new CancelledFailure('cancelled'));

      await expect(runRevocations('c1', TENANT, WF)).rejects.toThrow('cancelled');
      expect(mockImpl.recordRevocationResults).not.toHaveBeenCalled();
    });

    it('in a history from before the patch, is a failed result and the batch goes on', async () => {
      mockPatch.applied = false;
      cancelSecond();

      await expect(runRevocations('c1', TENANT, WF)).resolves.toEqual({ finished: true });

      expect(mockImpl.recordRevocationResults.mock.calls[0][1]).toEqual([
        { itemId: 'i1', entitlementIndex: 0, outcome: 'removed', detail: 'removed from group' },
        { itemId: 'i2', entitlementIndex: 0, outcome: 'failed', reason: 'cancelled' },
        { itemId: 'i3', entitlementIndex: 0, outcome: 'removed', detail: 'removed from group' },
      ]);
    });
  });
});
