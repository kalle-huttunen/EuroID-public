import { OffboardingTimelineHandler } from './offboarding-timeline.handler';
import { DomainEventType } from '../event-types';
import type { DomainEvent } from '../domain-event.interface';
import type {
  OffboardingCompletedPayload,
  OffboardingTargetRemovedManuallyPayload,
} from '../event-payloads';
import type { UserEventService } from '../../../modules/identity/user-event.service';
import { requestContext } from '../../middleware/correlation.middleware';

function event(
  payload: OffboardingCompletedPayload,
  tenantId = 'tenant-a',
): DomainEvent<OffboardingCompletedPayload> {
  return {
    eventId: 'e1',
    type: DomainEventType.IDENTITY_OFFBOARDING_COMPLETED,
    aggregateId: payload.identityId,
    timestamp: new Date().toISOString(),
    payload,
    metadata: {
      correlationId: 'c',
      depth: 0,
      emittedBy: 'test',
      actor: 'offboarding-workflow',
      tenantId,
    },
  };
}

describe('OffboardingTimelineHandler', () => {
  const tenants: string[] = [];
  const recordEvent = jest.fn(async () => {
    tenants.push(requestContext.getStore()?.tenantId ?? '');
    return {};
  });
  const handler = new OffboardingTimelineHandler({ recordEvent } as unknown as UserEventService);

  beforeEach(() => {
    recordEvent.mockClear();
    tenants.length = 0;
  });

  it('records one entry per target system and a summary, in the event tenant', async () => {
    await handler.handleOffboardingCompleted(
      event({
        identityId: 'id-1',
        workflowId: 'wf-1',
        status: 'partial-failure',
        hubStatus: 'suspended',
        systems: [
          { system: 'okta', outcome: 'deprovisioned', detail: 'deactivated' },
          { system: 'scim', outcome: 'already-gone', detail: 'no such user' },
          { system: 'file-outbound', outcome: 'not-applicable', reason: 'keeps no account' },
          { system: 'github', outcome: 'failed', reason: 'github: no invitation' },
        ],
      }),
    );

    const entries = recordEvent.mock.calls.map((c) => (c as unknown[])[0]);
    expect(entries).toEqual([
      expect.objectContaining({
        userId: 'id-1',
        type: 'USER_DEPROVISIONED',
        severity: 'success',
        title: 'Access removed: okta',
        description: 'deactivated',
        targetSystem: 'okta',
        actor: 'offboarding-workflow',
      }),
      expect.objectContaining({ severity: 'info', title: 'No account left: scim' }),
      expect.objectContaining({ severity: 'info', title: 'Not applicable: file-outbound' }),
      expect.objectContaining({
        severity: 'error',
        title: 'Access removal failed: github',
        description: 'github: no invitation',
      }),
      expect.objectContaining({
        type: 'WORKFLOW_COMPLETED',
        severity: 'error',
        title: 'Offboarding incomplete',
        description: expect.stringMatching(
          /1 removed, 1 already gone, 1 not applicable, 1 failed\. Golden Record suspended/,
        ),
      }),
    ]);
    expect(tenants).toEqual(Array(5).fill('tenant-a'));
  });

  it("says in the summary what became of the person's linked admin accounts", async () => {
    await handler.handleOffboardingCompleted(
      event({
        identityId: 'id-3',
        workflowId: 'wf-3',
        status: 'partial-failure',
        hubStatus: 'suspended',
        systems: [{ system: 'okta', outcome: 'deprovisioned', detail: 'deactivated' }],
        linkedAdmins: [
          { identityId: 'adm-1', workflowId: 'wf-adm-1', outcome: 'offboarded' },
          { identityId: 'adm-2', workflowId: 'wf-adm-2', outcome: 'failed', reason: 'entra: 403' },
          { identityId: 'adm-3', workflowId: 'wf-adm-3', outcome: 'running-elsewhere' },
        ],
      }),
    );

    expect(recordEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        title: 'Offboarding incomplete',
        description:
          'Targets: 1 removed. Linked admin accounts: 1 offboarded, 1 failed, ' +
          '1 offboarding elsewhere. Golden Record suspended (login disabled) until the failed ' +
          'targets and linked admin accounts are cleared.',
      }),
    );
  });

  it('summarizes a completed offboarding without target accounts', async () => {
    await handler.handleOffboardingCompleted(
      event({
        identityId: 'id-2',
        workflowId: 'wf-2',
        status: 'completed',
        hubStatus: 'deleted',
        systems: [],
      }),
    );

    expect(recordEvent).toHaveBeenCalledTimes(1);
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'WORKFLOW_COMPLETED',
        severity: 'success',
        title: 'Offboarding completed',
        description: 'No target accounts. Golden Record deleted.',
      }),
    );
  });

  it('skips an event without a tenant', async () => {
    await handler.handleOffboardingCompleted(
      event(
        {
          identityId: 'id-3',
          workflowId: 'wf',
          status: 'completed',
          hubStatus: 'deleted',
          systems: [],
        },
        '',
      ),
    );
    expect(recordEvent).not.toHaveBeenCalled();
  });
  describe('a failed target removed manually', () => {
    const removed = (offboardingComplete: boolean) =>
      ({
        ...event({} as OffboardingCompletedPayload),
        type: DomainEventType.IDENTITY_OFFBOARDING_TARGET_REMOVED_MANUALLY,
        aggregateId: 'id-4',
        payload: {
          identityId: 'id-4',
          leaverEventId: 'le-4',
          workflowId: 'wf-4',
          system: 'github',
          reason: 'Removed from the org by hand',
          offboardingComplete,
        },
        metadata: { ...event({} as OffboardingCompletedPayload).metadata, actor: 'admin@a' },
      }) as DomainEvent<OffboardingTargetRemovedManuallyPayload>;

    it('records who closed it and their note, never as removed by EuroID', async () => {
      await handler.handleTargetRemovedManually(removed(false));
      expect(recordEvent.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
        {
          userId: 'id-4',
          actor: 'admin@a',
          type: 'USER_DEPROVISIONED',
          severity: 'warning',
          title: 'Removed manually: github',
          description: 'Removed from the org by hand',
          targetSystem: 'github',
          metadata: { workflowId: 'wf-4', outcome: 'removed-manually' },
        },
      ]);
      expect(tenants).toEqual(['tenant-a']);
    });

    it('adds the completion when it was the last failed target', async () => {
      await handler.handleTargetRemovedManually(removed(true));
      expect(recordEvent).toHaveBeenCalledTimes(2);
      expect(recordEvent).toHaveBeenLastCalledWith(
        expect.objectContaining({
          type: 'WORKFLOW_COMPLETED',
          severity: 'success',
          title: 'Offboarding completed',
          actor: 'admin@a',
        }),
      );
    });
  });
});
