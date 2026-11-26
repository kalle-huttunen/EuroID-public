import { ApplicationFailure } from '@temporalio/common';
import { PolicyActivities } from './policy.activities';
import type { PolicyEngineService } from '../modules/policy/policy-engine.service';
import type { ReviewExclusionService } from '../modules/policy/review-exclusion.service';
import type { UserEventService } from '../modules/identity/user-event.service';
import { SOD_VIOLATION_FAILURE } from '@shared/types/sod-violation';
import { createMockUser } from '@testing/mock-factories';
import { TEST_TENANT_ID } from '@testing/test-helpers';

const blocker = {
  policyName: 'Payments vs approvals',
  severity: 'HIGH',
  action: 'BLOCK' as const,
  conflictingEntitlements: [
    { system: 'entra-id', type: 'group', targetId: 'Payables' },
    { system: 'entra-id', type: 'group', targetId: 'Approvers' },
  ],
};

describe('PolicyActivities.evaluateUser', () => {
  const evaluate = jest.fn();
  const activities = new PolicyActivities(
    { evaluate } as unknown as PolicyEngineService,
    {} as ReviewExclusionService,
    {} as UserEventService,
  );
  const user = createMockUser({ email: 'ada@example.com' });

  beforeEach(() => evaluate.mockReset());

  it('returns the intent when no BLOCK policy matches', async () => {
    const intent = {
      operations: [],
      sodValidation: { passed: true, blockers: [], warnings: [] },
    };
    evaluate.mockResolvedValue(intent);

    await expect(activities.evaluateUser(user, TEST_TENANT_ID)).resolves.toBe(intent);
    // The workflow provisions from it: policy.evaluated says so, for the identity timeline
    expect(evaluate).toHaveBeenCalledWith(user, TEST_TENANT_ID, { forProvisioning: true });
  });

  it('fails without retry on a BLOCK SoD conflict, naming the policy', async () => {
    evaluate.mockResolvedValue({
      operations: [],
      sodValidation: { passed: false, blockers: [blocker], warnings: [] },
    });

    const error = await activities.evaluateUser(user, TEST_TENANT_ID).catch((e: unknown) => e);

    // Temporal retries any other failure without limit: the onboarding run would wait forever.
    expect(error).toBeInstanceOf(ApplicationFailure);
    expect((error as ApplicationFailure).nonRetryable).toBe(true);
    expect((error as ApplicationFailure).type).toBe(SOD_VIOLATION_FAILURE);
    expect((error as ApplicationFailure).message).toBe(
      'Segregation of Duties conflict: Payments vs approvals',
    );
  });

  it("passes the mover's before-side option to the engine", async () => {
    const since = new Date('2026-11-20T08:00:00.000Z');
    evaluate.mockResolvedValue({ operations: [] });

    await activities.evaluateUser(user, TEST_TENANT_ID, 'wf-1', {
      reviewExclusionsLiftedSince: since,
    });

    expect(evaluate).toHaveBeenCalledWith(user, TEST_TENANT_ID, {
      forProvisioning: true,
      reviewExclusionsLiftedSince: since,
    });
  });

  it('lets other evaluation failures be retried', async () => {
    evaluate.mockRejectedValue(new Error('db down'));

    const error = await activities.evaluateUser(user, TEST_TENANT_ID).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApplicationFailure);
    expect((error as ApplicationFailure).nonRetryable).toBe(false);
    expect((error as ApplicationFailure).message).toBe('Policy evaluation failed: db down');
  });
});

/**
 * Onboarding (patch onboarding:review-exclusions) leaves out the targets an access review
 * excluded for the identity as a whole (a revoked account item), and says so on its timeline.
 */
describe('PolicyActivities.getReviewExcludedTargets', () => {
  const accountExcludedSystems = jest.fn();
  const recordEvent = jest.fn();
  const activities = new PolicyActivities(
    {} as PolicyEngineService,
    { accountExcludedSystems } as unknown as ReviewExclusionService,
    { recordEvent } as unknown as UserEventService,
  );

  beforeEach(() => {
    accountExcludedSystems.mockReset().mockResolvedValue(['github', 'entraid']);
    recordEvent.mockReset().mockResolvedValue({});
  });

  it('returns the run targets with an account exclusion, compared as systemKeys', async () => {
    await expect(
      activities.getReviewExcludedTargets(
        'id-1',
        ['entra', 'github', 'file-outbound'],
        TEST_TENANT_ID,
        'wf-1',
      ),
    ).resolves.toEqual(['entra', 'github']);
    expect(accountExcludedSystems).toHaveBeenCalledWith('id-1', TEST_TENANT_ID);
  });

  it('puts each one on the identity timeline, no address', async () => {
    await activities.getReviewExcludedTargets('id-1', ['github'], TEST_TENANT_ID, 'wf-1');

    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'id-1',
        title: 'Not provisioned to github: excluded by an access review',
        targetSystem: 'github',
        actor: 'system:onboarding',
        metadata: {
          workflow: 'onboarding',
          workflowId: 'wf-1',
          reason: 'access-review-exclusion',
        },
      }),
    );
  });

  it('still answers when the timeline write fails', async () => {
    recordEvent.mockRejectedValue(new Error('timeline down'));
    await expect(
      activities.getReviewExcludedTargets('id-1', ['github'], TEST_TENANT_ID),
    ).resolves.toEqual(['github']);
  });

  it('refuses to run without a tenant', async () => {
    await expect(activities.getReviewExcludedTargets('id-1', ['github'], '')).rejects.toThrow(
      '[SECURITY]',
    );
  });
});
