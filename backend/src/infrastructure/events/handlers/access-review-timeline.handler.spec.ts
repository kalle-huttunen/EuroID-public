import { AccessReviewTimelineHandler } from './access-review-timeline.handler';
import { DomainEventType } from '../event-types';
import type { DomainEvent } from '../domain-event.interface';
import type {
  AccessReviewAccountRevokedPayload,
  AccessReviewMembershipRevokedPayload,
} from '../event-payloads';
import type { UserEventService } from '../../../modules/identity/user-event.service';
import { requestContext } from '../../middleware/correlation.middleware';

function revoked(
  over: Partial<AccessReviewAccountRevokedPayload> = {},
  tenantId = 'tenant-a',
): DomainEvent<AccessReviewAccountRevokedPayload> {
  return {
    eventId: 'e1',
    type: DomainEventType.ACCESS_REVIEW_ACCOUNT_REVOKED,
    aggregateId: 'id-1',
    timestamp: new Date().toISOString(),
    payload: {
      identityId: 'id-1',
      campaignId: 'camp-1',
      itemId: 'item-1',
      targetSystem: 'github',
      outcome: 'removed',
      detail: 'removed from organization',
      ...over,
    },
    metadata: {
      correlationId: 'c',
      depth: 0,
      emittedBy: 'test',
      actor: 'reviewer@acme.test',
      tenantId,
    },
  };
}

describe('AccessReviewTimelineHandler', () => {
  const tenants: string[] = [];
  const recordEvent = jest.fn(async () => {
    tenants.push(requestContext.getStore()?.tenantId ?? '');
    return {};
  });
  const handler = new AccessReviewTimelineHandler({ recordEvent } as unknown as UserEventService);
  const entries = () => recordEvent.mock.calls.map((c) => (c as unknown[])[0]);

  beforeEach(() => {
    recordEvent.mockClear();
    tenants.length = 0;
  });

  it('records a removed account on the identity, by the reviewer, in the event tenant', async () => {
    await handler.handleAccountRevoked(revoked());
    expect(entries()).toEqual([
      {
        userId: 'id-1',
        actor: 'reviewer@acme.test',
        type: 'USER_DEPROVISIONED',
        severity: 'success',
        title: 'Account removed after access review: github',
        description: 'removed from organization',
        targetSystem: 'github',
        metadata: { campaignId: 'camp-1', itemId: 'item-1', outcome: 'removed' },
      },
    ]);
    expect(tenants).toEqual(['tenant-a']);
  });

  it.each([
    ['already-gone', 'info', 'No account left after access review: github'],
    ['manual-action-needed', 'warning', 'Account to remove by hand after access review: github'],
    ['failed', 'error', 'Account removal after access review failed: github'],
  ] as const)('records %s as %s with what happened', async (outcome, severity, title) => {
    await handler.handleAccountRevoked(
      revoked({ outcome, detail: undefined, reason: 'github: what to do' }),
    );
    expect(entries()[0]).toEqual(
      expect.objectContaining({ severity, title, description: 'github: what to do' }),
    );
  });

  it('skips an event without a tenant', async () => {
    await handler.handleAccountRevoked(revoked({}, ''));
    expect(recordEvent).not.toHaveBeenCalled();
  });

  describe('group memberships (access_review.membership_revoked)', () => {
    const membership = (
      over: Partial<AccessReviewMembershipRevokedPayload> = {},
      tenantId = 'tenant-a',
    ): DomainEvent<AccessReviewMembershipRevokedPayload> => {
      const event = revoked({ targetSystem: 'entra-id', detail: 'removed from group' }, tenantId);
      return {
        ...event,
        type: DomainEventType.ACCESS_REVIEW_MEMBERSHIP_REVOKED,
        payload: { ...event.payload, groupId: 'g-1', ...over },
      };
    };

    it('records a removed membership on the identity, by the reviewer, in the event tenant', async () => {
      await handler.handleMembershipRevoked(membership());
      expect(entries()).toEqual([
        {
          userId: 'id-1',
          actor: 'reviewer@acme.test',
          type: 'GROUP_REMOVED',
          severity: 'success',
          title: 'Group membership removed after access review: entra-id',
          description: 'removed from group',
          targetSystem: 'entra-id',
          metadata: { campaignId: 'camp-1', itemId: 'item-1', groupId: 'g-1', outcome: 'removed' },
        },
      ]);
      expect(tenants).toEqual(['tenant-a']);
    });

    it.each([
      ['already-gone', 'info', 'No group membership left after access review: entra-id'],
      [
        'manual-action-needed',
        'warning',
        'Group membership to remove by hand after access review: entra-id',
      ],
      ['failed', 'error', 'Group membership removal after access review failed: entra-id'],
    ] as const)('records %s as %s with what happened', async (outcome, severity, title) => {
      await handler.handleMembershipRevoked(
        membership({ outcome, detail: undefined, reason: 'entra: what to do' }),
      );
      expect(entries()[0]).toEqual(
        expect.objectContaining({ severity, title, description: 'entra: what to do' }),
      );
    });

    it('skips an event without a tenant', async () => {
      await handler.handleMembershipRevoked(membership({}, ''));
      expect(recordEvent).not.toHaveBeenCalled();
    });
  });
});
