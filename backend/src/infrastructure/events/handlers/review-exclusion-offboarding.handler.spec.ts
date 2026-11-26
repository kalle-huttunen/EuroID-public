/**
 * An identity's access review exclusions end when its offboarding has run: they judged that
 * employment, and a rehire is evaluated afresh. The handler ends them in the event's tenant; a
 * failure is left to the dead-letter capture (thrown), never swallowed.
 */
import { requestContext } from '../../middleware/correlation.middleware';
import { DomainEventType } from '../event-types';
import type { DomainEvent } from '../domain-event.interface';
import type { OffboardingCompletedPayload } from '../event-payloads';
import type { ReviewExclusionService } from '../../../modules/policy/review-exclusion.service';
import { ReviewExclusionOffboardingHandler } from './review-exclusion-offboarding.handler';

const event = (
  status: OffboardingCompletedPayload['status'],
  tenantId = 'tenant-a',
): DomainEvent<OffboardingCompletedPayload> =>
  ({
    eventId: 'evt-1',
    type: DomainEventType.IDENTITY_OFFBOARDING_COMPLETED,
    aggregateId: 'id-1',
    timestamp: '2026-11-24T10:00:00.000Z',
    payload: {
      identityId: 'id-1',
      workflowId: 't-tenant-a-offboard-id-1',
      status,
      hubStatus: status === 'completed' ? 'deleted' : 'suspended',
      systems: [],
    },
    metadata: { correlationId: 'c-1', depth: 0, emittedBy: 'test', actor: 'system', tenantId },
  }) as DomainEvent<OffboardingCompletedPayload>;

describe('ReviewExclusionOffboardingHandler', () => {
  const tenantsSeen: string[] = [];
  const endForOffboarding = jest.fn(async () => {
    tenantsSeen.push(requestContext.getStore()?.tenantId ?? '');
    return 2;
  });
  const handler = new ReviewExclusionOffboardingHandler({
    endForOffboarding,
  } as unknown as ReviewExclusionService);

  beforeEach(() => {
    endForOffboarding.mockClear();
    tenantsSeen.length = 0;
  });

  it.each(['completed', 'partial-failure'] as const)(
    'ends the exclusions of an identity whose offboarding ran (%s)',
    async (status) => {
      await handler.handleOffboardingCompleted(event(status));

      expect(endForOffboarding).toHaveBeenCalledWith('id-1', 'tenant-a');
      expect(tenantsSeen).toEqual(['tenant-a']);
    },
  );

  it('ends nothing for an event without a tenant', async () => {
    await handler.handleOffboardingCompleted(event('completed', ''));
    expect(endForOffboarding).not.toHaveBeenCalled();
  });

  it('lets a failure reach the dead-letter capture', async () => {
    endForOffboarding.mockRejectedValueOnce(new Error('MongoDB unavailable'));
    await expect(handler.handleOffboardingCompleted(event('completed'))).rejects.toThrow(
      'MongoDB unavailable',
    );
  });
});
