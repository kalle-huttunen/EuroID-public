import { OnboardingEventHandler } from './onboarding.handler';
import { DomainEventType } from '../event-types';
import type { DomainEvent } from '../domain-event.interface';
import type { IdentityCreatedPayload, IdentityUpdatedPayload } from '../event-payloads';
import type { IdentityService } from '../../../modules/identity/identity.service';
import type { OnboardingService } from '../../../modules/onboarding/onboarding.service';
import { requestContext } from '../../middleware/correlation.middleware';

function created(payload: Partial<IdentityCreatedPayload>): DomainEvent<IdentityCreatedPayload> {
  return {
    eventId: 'e1',
    type: DomainEventType.IDENTITY_CREATED,
    aggregateId: 'id-1',
    timestamp: new Date().toISOString(),
    payload: { identityId: 'id-1', sourceSystem: 'manual-ui', status: 'ACTIVE', ...payload },
    metadata: { correlationId: 'c', depth: 0, emittedBy: 'test', actor: 'admin', tenantId: 't-a' },
  } as DomainEvent<IdentityCreatedPayload>;
}

/** joiner_events (read only): no identity is an open HR joiner. */
const noOpenJoiner = {
  exists: () => ({ exec: async () => null }),
} as unknown as ConstructorParameters<typeof OnboardingEventHandler>[2];

describe('OnboardingEventHandler: identity.created (POST /identity?triggerWorkflow=true)', () => {
  const tenants: string[] = [];
  const findIdentityById = jest.fn(async () => {
    tenants.push(requestContext.getStore()?.tenantId ?? '');
    return { profile: { email: 'ada@example.com' } };
  });
  const triggerOnboarding = jest.fn().mockResolvedValue('wf-1');
  const handler = new OnboardingEventHandler(
    { findIdentityById } as unknown as IdentityService,
    { triggerOnboarding } as unknown as OnboardingService,
    noOpenJoiner,
  );

  beforeEach(() => {
    findIdentityById.mockClear();
    triggerOnboarding.mockClear();
    tenants.length = 0;
  });

  it('starts onboarding with the email it reads from the identity (the event carries none)', async () => {
    await handler.handleIdentityCreated(created({ triggerWorkflow: true }));

    expect(findIdentityById).toHaveBeenCalledWith('id-1');
    expect(tenants).toEqual(['t-a']);
    expect(triggerOnboarding).toHaveBeenCalledWith({
      identityId: 'id-1',
      email: 'ada@example.com',
    });
  });

  it('starts nothing without triggerWorkflow (an HR sync onboards its joiners itself)', async () => {
    await handler.handleIdentityCreated(created({ sourceSystem: 'csv-hr' }));

    expect(findIdentityById).not.toHaveBeenCalled();
    expect(triggerOnboarding).not.toHaveBeenCalled();
  });

  it('starts nothing for an identity without an email', async () => {
    findIdentityById.mockResolvedValueOnce({ profile: {} } as never);

    await handler.handleIdentityCreated(created({ triggerWorkflow: true }));

    expect(triggerOnboarding).not.toHaveBeenCalled();
  });
});

function updated(): DomainEvent<IdentityUpdatedPayload> {
  return {
    eventId: 'e2',
    type: DomainEventType.IDENTITY_UPDATED,
    aggregateId: 'id-1',
    timestamp: new Date().toISOString(),
    payload: {
      identityId: 'id-1',
      changedFields: ['departmentName'],
      source: 'manual',
      previousAttributes: { departmentName: 'Sales' },
    },
    metadata: { correlationId: 'c', depth: 0, emittedBy: 'test', actor: 'admin', tenantId: 't-a' },
  } as DomainEvent<IdentityUpdatedPayload>;
}

/**
 * An edit of a trigger attribute of an identity not provisioned yet starts onboarding, unless the
 * identity is an HR joiner the joiner flow still owns (an open joiner event: its start date is
 * ahead, or it waits in a mass-joiner batch). Starting it here skipped those joiner rules.
 */
describe('OnboardingEventHandler: identity.updated of an identity not provisioned yet', () => {
  const findIdentityById = jest.fn(async () => ({ profile: { email: 'ada@example.com' } }));
  const triggerOnboarding = jest.fn().mockResolvedValue('wf-1');
  const openJoiners = jest.fn();
  const handler = new OnboardingEventHandler(
    { findIdentityById } as unknown as IdentityService,
    { triggerOnboarding } as unknown as OnboardingService,
    {
      exists: (filter: unknown) => ({ exec: async () => openJoiners(filter) }),
    } as unknown as ConstructorParameters<typeof OnboardingEventHandler>[2],
  );

  beforeEach(() => {
    triggerOnboarding.mockClear();
    openJoiners.mockReset().mockReturnValue(null);
  });

  it('starts onboarding for an identity that is no open HR joiner', async () => {
    await handler.handleIdentityUpdated(updated());

    expect(openJoiners).toHaveBeenCalledWith({ tenantId: 't-a', identityId: 'id-1', open: true });
    expect(triggerOnboarding).toHaveBeenCalledWith({
      identityId: 'id-1',
      email: 'ada@example.com',
    });
  });

  it('leaves an open HR joiner to the joiner flow', async () => {
    openJoiners.mockReturnValue({ _id: 'joiner-1' });

    await handler.handleIdentityUpdated(updated());

    expect(triggerOnboarding).not.toHaveBeenCalled();
  });
});
