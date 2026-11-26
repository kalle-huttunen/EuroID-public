import {
  SourcesChangedHandler,
  type IdentitySourcesChangedPayload,
} from './sources-changed.handler';
import { DomainEventType } from '../event-types';
import type { DomainEvent } from '../domain-event.interface';
import type { IdentityService } from '../../../modules/identity/identity.service';
import type { OnboardingService } from '../../../modules/onboarding/onboarding.service';

function sourcesChanged(depth = 0): DomainEvent<IdentitySourcesChangedPayload> {
  return {
    eventId: 'e1',
    type: DomainEventType.IDENTITY_SOURCES_CHANGED,
    aggregateId: 'id-1',
    timestamp: new Date().toISOString(),
    payload: {
      identityId: 'id-1',
      newSourceName: 'json-api-hr',
      totalSourceCount: 2,
      contractType: 'PRIMARY',
    },
    metadata: { correlationId: 'c', depth, emittedBy: 'test', actor: 'system', tenantId: 't-a' },
  } as DomainEvent<IdentitySourcesChangedPayload>;
}

/**
 * A new source on an identity starts onboarding, unless the identity is an HR joiner the joiner
 * flow still owns (an open joiner event: its start date is ahead, or it waits in a mass-joiner
 * batch). Starting it here skipped those joiner rules.
 */
describe('SourcesChangedHandler', () => {
  const findIdentityById = jest.fn(async () => ({ profile: { email: 'ada@example.com' } }));
  const triggerOnboarding = jest.fn().mockResolvedValue('wf-1');
  const openJoiners = jest.fn();
  const handler = new SourcesChangedHandler(
    { findIdentityById } as unknown as IdentityService,
    { triggerOnboarding } as unknown as OnboardingService,
    {
      exists: (filter: unknown) => ({ exec: async () => openJoiners(filter) }),
    } as unknown as ConstructorParameters<typeof SourcesChangedHandler>[2],
  );

  beforeEach(() => {
    triggerOnboarding.mockClear();
    openJoiners.mockReset().mockReturnValue(null);
  });

  it('starts onboarding for an identity that is no open HR joiner', async () => {
    await handler.handleSourcesChanged(sourcesChanged());

    expect(openJoiners).toHaveBeenCalledWith({ tenantId: 't-a', identityId: 'id-1', open: true });
    expect(triggerOnboarding).toHaveBeenCalledWith({
      identityId: 'id-1',
      email: 'ada@example.com',
    });
  });

  it('leaves an open HR joiner to the joiner flow', async () => {
    openJoiners.mockReturnValue({ _id: 'joiner-1' });

    await handler.handleSourcesChanged(sourcesChanged());

    expect(triggerOnboarding).not.toHaveBeenCalled();
  });

  it('starts nothing for a change a workflow made (depth above 0)', async () => {
    await handler.handleSourcesChanged(sourcesChanged(1));

    expect(triggerOnboarding).not.toHaveBeenCalled();
  });
});
