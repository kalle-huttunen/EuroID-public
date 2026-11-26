import { OffboardingActivities } from './offboarding.activities';
import type { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import type { OffboardingResult } from '@shared/types/deprovision';
import { TEST_TENANT_ID } from '@testing/test-helpers';

describe('OffboardingActivities.recordOffboardingOutcome', () => {
  const emit = jest.fn();
  const activities = new OffboardingActivities({ emit } as unknown as DomainEventEmitterService);

  beforeEach(() => emit.mockReset());

  it('publishes the per-system result for the timeline and the Leavers history, emails masked', async () => {
    const result: OffboardingResult = {
      identityId: 'id-1',
      workflowId: 'wf-1',
      status: 'partial-failure',
      hubStatus: 'suspended',
      systems: [
        { system: 'okta', outcome: 'deprovisioned', detail: 'deactivated' },
        { system: 'github', outcome: 'failed', reason: 'no invitation for ada@acme.test' },
        { system: 'file-outbound', outcome: 'not-applicable', reason: 'keeps no account' },
      ],
    };

    await activities.recordOffboardingOutcome(result, TEST_TENANT_ID);

    expect(emit).toHaveBeenCalledWith(
      DomainEventType.IDENTITY_OFFBOARDING_COMPLETED,
      'id-1',
      {
        ...result,
        systems: [
          result.systems[0],
          { system: 'github', outcome: 'failed', reason: 'no invitation for a•••@acme.test' },
          result.systems[2],
        ],
      },
      { tenantId: TEST_TENANT_ID, actor: 'offboarding-workflow' },
    );
  });

  it('keeps long failure reasons short', async () => {
    await activities.recordOffboardingOutcome(
      {
        identityId: 'id-1',
        workflowId: 'wf-1',
        status: 'partial-failure',
        hubStatus: 'suspended',
        systems: [{ system: 'scim', outcome: 'failed', reason: 'x'.repeat(2000) }],
      },
      TEST_TENANT_ID,
    );

    expect(emit.mock.calls[0][2].systems[0].reason).toHaveLength(500);
  });

  it('refuses to run without a tenant', async () => {
    await expect(
      activities.recordOffboardingOutcome(
        {
          identityId: 'id-1',
          workflowId: 'wf',
          status: 'completed',
          hubStatus: 'deleted',
          systems: [],
        },
        '',
      ),
    ).rejects.toThrow('[SECURITY]');
  });
});
