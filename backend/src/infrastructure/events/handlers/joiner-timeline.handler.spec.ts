import { JoinerTimelineHandler } from './joiner-timeline.handler';
import { DomainEventType } from '../event-types';
import type { DomainEvent } from '../domain-event.interface';
import type {
  JoinerOnboardingStartedPayload,
  JoinerOnboardingWaitingPayload,
} from '../event-payloads';
import type { UserEventService } from '../../../modules/identity/user-event.service';
import { requestContext } from '../../middleware/correlation.middleware';

function started(
  payload: Partial<JoinerOnboardingStartedPayload>,
  actor = 'system:hr-sync',
  tenantId: string | null = 'tenant-a',
): DomainEvent<JoinerOnboardingStartedPayload> {
  return {
    eventId: 'e1',
    type: DomainEventType.JOINER_ONBOARDING_STARTED,
    aggregateId: 'id-1',
    timestamp: new Date().toISOString(),
    payload: {
      identityId: 'id-1',
      joinerEventId: 'je-1',
      sourceName: 'csv-hr',
      workflowId: 't-tenant-a-onboard-id-1',
      ...payload,
    },
    metadata: {
      correlationId: 'c',
      depth: 0,
      emittedBy: 'test',
      actor,
      tenantId: tenantId ?? undefined,
    },
  } as DomainEvent<JoinerOnboardingStartedPayload>;
}

describe('JoinerTimelineHandler', () => {
  const tenants: string[] = [];
  const recordEvent = jest.fn(async () => {
    tenants.push(requestContext.getStore()?.tenantId ?? '');
    return {};
  });
  const handler = new JoinerTimelineHandler({ recordEvent } as unknown as UserEventService);

  beforeEach(() => {
    recordEvent.mockClear();
    tenants.length = 0;
  });

  it('says the HR sync started the onboarding, with the system actor, in the event tenant', async () => {
    await handler.handleOnboardingStarted(started({}));

    expect(recordEvent).toHaveBeenCalledWith({
      userId: 'id-1',
      actor: 'system:hr-sync',
      type: 'WORKFLOW_STARTED',
      severity: 'info',
      title: 'Onboarding started by HR sync',
      description: 'New in the csv-hr sync.',
      targetSystem: 'csv-hr',
      metadata: {
        workflow: 'onboarding',
        workflowId: 't-tenant-a-onboard-id-1',
        sourceName: 'csv-hr',
        joinerEventId: 'je-1',
        batchId: undefined,
      },
    });
    expect(tenants).toEqual(['tenant-a']);
  });

  it('names the approved batch and the approving admin for a batch member', async () => {
    await handler.handleOnboardingStarted(started({ batchId: 'jb-1' }, 'admin@acme.test'));

    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: 'admin@acme.test',
        title: 'Onboarding started by HR sync',
        description: 'New in the csv-hr sync (mass-joiner batch approved).',
        metadata: expect.objectContaining({ batchId: 'jb-1' }),
      }),
    );
  });

  it('says a rehire was rehired, not new', async () => {
    await handler.handleOnboardingStarted(started({ rehire: true }));

    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'Rehired in the csv-hr sync.' }),
    );
  });

  it('writes nothing without a tenant, and survives a failed write', async () => {
    await handler.handleOnboardingStarted(started({}, 'system:hr-sync', null));
    expect(recordEvent).not.toHaveBeenCalled();

    recordEvent.mockRejectedValueOnce(new Error('mongo down'));
    await expect(handler.handleOnboardingStarted(started({}))).resolves.toBeUndefined();
  });

  it('shows why the HR sync does not onboard a joiner whose start date is unreadable', async () => {
    const waiting = {
      ...started({}),
      type: DomainEventType.JOINER_ONBOARDING_WAITING,
      payload: {
        identityId: 'id-1',
        joinerEventId: 'je-1',
        sourceName: 'csv-hr',
        reason: 'start-date-unreadable',
      },
    } as DomainEvent<JoinerOnboardingWaitingPayload>;

    await handler.handleOnboardingWaiting(waiting);

    expect(recordEvent).toHaveBeenCalledWith({
      userId: 'id-1',
      actor: 'system:hr-sync',
      type: 'USER_PROVISIONED',
      severity: 'warning',
      title: 'Onboarding waits: start date unreadable',
      description:
        'The start date in the csv-hr record is not a date, so the HR sync does not onboard ' +
        'this person. Correct it in HR (the next full sync then onboards on that date), or ' +
        'provision by hand.',
      targetSystem: 'csv-hr',
      metadata: {
        workflow: 'onboarding',
        sourceName: 'csv-hr',
        joinerEventId: 'je-1',
        reason: 'start-date-unreadable',
      },
    });
    expect(tenants).toEqual(['tenant-a']);
  });
});
