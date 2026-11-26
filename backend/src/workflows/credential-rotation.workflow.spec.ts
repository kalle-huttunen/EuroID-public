/**
 * Credential Rotation Workflow Tests
 *
 * The nightly run (patch credential-rotation:per-tenant) lists the active tenants when the
 * schedule names none and runs runCredentialRotationBatch once per tenant with the workflow time
 * and the batch size, adding up the counts. A tenant whose call fails does not stop the others;
 * the run then fails, naming it and the reason, so the schedule shows it. A run from before the
 * patch makes one call with tenant '' (every active tenant inside the activity). Nothing is reset
 * either way. On the Temporal test server, with the replay of a pre-patch history:
 * test/workflows/credential-rotation.workflow.e2e-spec.ts. The activity's own behaviour is in
 * src/activities/credential-rotation.activities.integration.spec.ts.
 *
 * Uses pure Jest mocks (no TestWorkflowEnvironment).
 */

const mockActivities: Record<string, jest.Mock> = {};
const stableRefs: Record<string, (...args: unknown[]) => unknown> = {};
const mockPatched = jest.fn();

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
  ActivityFailure: jest.requireActual('@temporalio/common').ActivityFailure,
  ApplicationFailure: jest.requireActual('@temporalio/common').ApplicationFailure,
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('../infrastructure/config/retry-policies', () => ({
  SCHEDULED_SYNC_RETRY: { maximumAttempts: 2 },
}));

import { ActivityFailure, ApplicationFailure, RetryState } from '@temporalio/common';
import {
  credentialRotationWorkflow,
  ROTATION_TENANTS_FAILED,
} from './credential-rotation.workflow';
import type { CredentialRotationResult } from './credential-rotation.workflow';

const NOW = '2026-11-24T03:00:00.000Z';

const counts = (over: Partial<CredentialRotationResult> = {}): CredentialRotationResult => ({
  rotated: 0,
  failed: 0,
  notified: 0,
  statusesUpdated: 0,
  observed: 0,
  unknown: 0,
  removed: 0,
  overdue: 0,
  ...over,
});

/** How Temporal hands the workflow an activity that failed after its retries. */
const activityFailed = (message: string) =>
  new ActivityFailure(
    'Activity task failed',
    'runCredentialRotationBatch',
    '2',
    RetryState.MAXIMUM_ATTEMPTS_REACHED,
    'worker',
    new ApplicationFailure(message),
  );

describe('Credential Rotation Workflow', () => {
  beforeEach(() => {
    Object.keys(mockActivities).forEach((key) => delete mockActivities[key]);
    mockActivities.listCredentialRotationTenants = jest.fn();
    mockActivities.runCredentialRotationBatch = jest.fn();
    mockPatched.mockReset().mockReturnValue(true);
    // workflowNow() is the ordinary clock outside a Temporal workflow
    jest.useFakeTimers({ now: new Date(NOW) });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const runCalls = () => mockActivities.runCredentialRotationBatch.mock.calls;

  describe('per tenant (credential-rotation:per-tenant)', () => {
    it('runs each active tenant in its own call, in batches of 50 at the workflow time, and adds up the counts', async () => {
      mockActivities.listCredentialRotationTenants.mockResolvedValue(['tenant-a', 'tenant-b']);
      mockActivities.runCredentialRotationBatch
        .mockResolvedValueOnce(
          counts({ notified: 3, statusesUpdated: 7, observed: 12, unknown: 1 }),
        )
        // a result without the later fields counts them as 0
        .mockResolvedValueOnce({ rotated: 0, failed: 0, notified: 1, statusesUpdated: 2 });

      await expect(credentialRotationWorkflow()).resolves.toEqual(
        counts({ notified: 4, statusesUpdated: 9, observed: 12, unknown: 1 }),
      );

      expect(mockPatched).toHaveBeenCalledWith('credential-rotation:per-tenant');
      expect(runCalls()).toEqual([
        ['tenant-a', NOW, 50],
        ['tenant-b', NOW, 50],
      ]);
    });

    it('goes on past a failing tenant, then fails naming it and the reason', async () => {
      mockActivities.listCredentialRotationTenants.mockResolvedValue([
        'tenant-a',
        'tenant-b',
        'tenant-c',
      ]);
      mockActivities.runCredentialRotationBatch
        .mockRejectedValueOnce(activityFailed('credential_inventory unavailable'))
        .mockResolvedValueOnce(counts({ observed: 2 }))
        .mockRejectedValueOnce(activityFailed('activity StartToClose timeout'));

      const error = await credentialRotationWorkflow().catch((e: unknown) => e);

      expect(runCalls().map(([tenantId]) => tenantId)).toEqual([
        'tenant-a',
        'tenant-b',
        'tenant-c',
      ]);
      expect(error).toBeInstanceOf(ApplicationFailure);
      expect((error as ApplicationFailure).type).toBe(ROTATION_TENANTS_FAILED);
      expect((error as ApplicationFailure).nonRetryable).toBe(true);
      expect((error as ApplicationFailure).message).toBe(
        'The credential run failed for 2 of 3 tenant(s): tenant-a (credential_inventory ' +
          'unavailable); tenant-c (activity StartToClose timeout)',
      );
    });

    it('runs a tenant the input names alone, with its batch size, without listing the tenants', async () => {
      mockActivities.runCredentialRotationBatch.mockResolvedValue(counts({ observed: 1 }));

      await expect(
        credentialRotationWorkflow({ tenantId: 'tenant-a', batchSize: 10 }),
      ).resolves.toEqual(counts({ observed: 1 }));

      expect(mockActivities.listCredentialRotationTenants).not.toHaveBeenCalled();
      expect(runCalls()).toEqual([['tenant-a', NOW, 10]]);
    });

    it('runs nothing when no tenant is active', async () => {
      mockActivities.listCredentialRotationTenants.mockResolvedValue([]);

      await expect(credentialRotationWorkflow()).resolves.toEqual(counts());
      expect(mockActivities.runCredentialRotationBatch).not.toHaveBeenCalled();
    });
  });

  describe('runs from before the patch', () => {
    beforeEach(() => mockPatched.mockReturnValue(false));

    it('run every tenant in one call with tenant "" and return its counts', async () => {
      const result = counts({ notified: 3, statusesUpdated: 7, observed: 12, overdue: 1 });
      mockActivities.runCredentialRotationBatch.mockResolvedValue(result);

      await expect(credentialRotationWorkflow()).resolves.toEqual(result);

      expect(mockActivities.listCredentialRotationTenants).not.toHaveBeenCalled();
      expect(runCalls()).toEqual([['', NOW, 50]]);
    });

    it('fail the run when that call fails, so the schedule shows it', async () => {
      mockActivities.runCredentialRotationBatch.mockRejectedValue(
        new Error('credential_inventory unavailable'),
      );

      await expect(credentialRotationWorkflow({ tenantId: 'tenant-a' })).rejects.toThrow(
        'credential_inventory unavailable',
      );
      expect(mockActivities.runCredentialRotationBatch).toHaveBeenCalledTimes(1);
    });
  });
});
