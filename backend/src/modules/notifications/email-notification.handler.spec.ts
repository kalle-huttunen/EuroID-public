import type { Model } from 'mongoose';
import { DomainEventType } from '@infrastructure/events/event-types';
import type { DomainEvent } from '@infrastructure/events/domain-event.interface';
import { requestContext } from '@infrastructure/middleware/correlation.middleware';
import type { ReviewItemDocument } from '../access-review/schemas/review-item.schema';
import type { ReviewCampaignDocument } from '../access-review/schemas/review-campaign.schema';
import { EmailNotificationHandler } from './email-notification.handler';
import type { EmailNotificationService } from './email-notification.service';
import type { EmailDeliveryService } from './email-delivery.service';

function event<T>(type: DomainEventType, payload: T, tenantId = 'tenant-a'): DomainEvent<T> {
  return {
    eventId: 'e1',
    type,
    aggregateId: 'agg-1',
    timestamp: new Date().toISOString(),
    payload,
    metadata: { correlationId: 'c', depth: 0, emittedBy: 'test', actor: 'system', tenantId },
  };
}

describe('EmailNotificationHandler', () => {
  const tenantsSeen: string[] = [];
  const notifications = {
    isEnabled: jest.fn(() => true),
    notifyReviewer: jest.fn(async () => {
      tenantsSeen.push(requestContext.getStore()?.tenantId ?? '');
      return 'sent';
    }),
    notifyEscalatedReviewer: jest.fn(async () => 'sent'),
    notifyAccessExpiring: jest.fn(async () => 'sent'),
  };
  const delivery = { redeliver: jest.fn(async () => 'sent') };
  const aggregateExec = jest.fn();
  const itemExec = jest.fn();
  const reviewItems = {
    aggregate: jest.fn(() => ({ exec: aggregateExec })),
    findOne: jest.fn(() => ({ select: () => ({ lean: () => ({ exec: itemExec }) }) })),
  };
  const campaignExec = jest.fn();
  const campaigns = {
    findOne: jest.fn(() => ({ select: () => ({ lean: () => ({ exec: campaignExec }) }) })),
  };
  const handler = new EmailNotificationHandler(
    notifications as unknown as EmailNotificationService,
    delivery as unknown as EmailDeliveryService,
    reviewItems as unknown as Model<ReviewItemDocument>,
    campaigns as unknown as Model<ReviewCampaignDocument>,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    tenantsSeen.length = 0;
    notifications.isEnabled.mockReturnValue(true);
  });

  describe('campaign activated', () => {
    const activated = (tenantId?: string) =>
      event(
        DomainEventType.ACCESS_REVIEW_CAMPAIGN_ACTIVATED,
        {
          campaignId: 'c1',
          name: 'Q4 review',
          itemCount: 3,
          deadline: new Date('2026-12-01T00:00:00Z'),
        },
        tenantId,
      );

    it('mails each reviewer once with their pending count, in the event tenant', async () => {
      aggregateExec.mockResolvedValue([
        { _id: 'manager@a.example', count: 2 },
        { _id: 'owner@a.example', count: 1 },
      ]);

      await handler.handleCampaignActivated(activated());

      const pipeline = (reviewItems.aggregate.mock.calls[0] as unknown[])[0] as Array<
        Record<string, unknown>
      >;
      expect(pipeline[0]).toEqual({
        $match: { tenantId: 'tenant-a', campaignId: 'c1', decision: 'pending' },
      });
      expect(notifications.notifyReviewer).toHaveBeenCalledTimes(2);
      expect(notifications.notifyReviewer).toHaveBeenCalledWith('tenant-a', {
        campaignId: 'c1',
        campaignName: 'Q4 review',
        deadline: new Date('2026-12-01T00:00:00Z'),
        reviewerKey: 'manager@a.example',
        itemCount: 2,
      });
      expect(tenantsSeen).toEqual(['tenant-a', 'tenant-a']);
    });

    it('does no work when email is off', async () => {
      notifications.isEnabled.mockReturnValue(false);
      await handler.handleCampaignActivated(activated());
      expect(reviewItems.aggregate).not.toHaveBeenCalled();
    });

    it('skips an event without a tenant', async () => {
      await handler.handleCampaignActivated(activated(''));
      expect(reviewItems.aggregate).not.toHaveBeenCalled();
    });

    it('never lets a failure reach the event bus', async () => {
      aggregateExec.mockRejectedValue(new Error('db down for reviewer@a.example'));
      await expect(handler.handleCampaignActivated(activated())).resolves.toBeUndefined();
    });
  });

  describe('escalation', () => {
    // The event names no reviewer (it reaches the audit log and the websocket)
    const escalated = () =>
      event(DomainEventType.ACCESS_REVIEW_ESCALATED, {
        itemId: 'i1',
        campaignId: 'c1',
        daysOverdue: 7,
      });

    it("mails the item's new reviewer, read from the item, with the campaign name", async () => {
      itemExec.mockResolvedValue({ reviewerId: 'director@a.example' });
      campaignExec.mockResolvedValue({ name: 'Q4 review' });

      await handler.handleReviewEscalated(escalated());

      expect(reviewItems.findOne).toHaveBeenCalledWith({ itemId: 'i1', tenantId: 'tenant-a' });
      expect(campaigns.findOne).toHaveBeenCalledWith({ campaignId: 'c1', tenantId: 'tenant-a' });
      expect(notifications.notifyEscalatedReviewer).toHaveBeenCalledWith('tenant-a', {
        campaignId: 'c1',
        campaignName: 'Q4 review',
        reviewerKey: 'director@a.example',
        daysOverdue: 7,
      });
    });

    it('mails nobody for an item that is gone', async () => {
      itemExec.mockResolvedValue(null);

      await handler.handleReviewEscalated(escalated());

      expect(notifications.notifyEscalatedReviewer).not.toHaveBeenCalled();
    });
  });

  it('expiring access: 7-day and last-day warnings go to the access owner', async () => {
    const payload = {
      identityId: '64b000000000000000000001',
      targetSystem: 'entra-id',
      expiresAt: new Date('2026-11-29T10:00:00Z'),
      email: 'owner@a.example',
    };

    await handler.handleExpiringSoon(event(DomainEventType.ENTITLEMENT_EXPIRING_SOON, payload));
    await handler.handleExpiringTomorrow(
      event(DomainEventType.ENTITLEMENT_EXPIRING_TOMORROW, payload),
    );

    expect(notifications.notifyAccessExpiring).toHaveBeenNthCalledWith(1, 'tenant-a', {
      identityId: payload.identityId,
      targetSystem: 'entra-id',
      expiresAt: payload.expiresAt,
      window: 'soon',
    });
    expect(notifications.notifyAccessExpiring).toHaveBeenNthCalledWith(2, 'tenant-a', {
      identityId: payload.identityId,
      targetSystem: 'entra-id',
      expiresAt: payload.expiresAt,
      window: 'tomorrow',
    });
  });

  describe('dead-letter retry', () => {
    const retry = (tenantId?: string) =>
      event(
        DomainEventType.EMAIL_NOTIFICATION_RETRY,
        { notificationId: 'n1', kind: 'approval-requested' },
        tenantId,
      );

    it('redelivers the stored notification of the event tenant', async () => {
      await handler.handleRetry(retry());
      expect(delivery.redeliver).toHaveBeenCalledWith('tenant-a', 'n1');
    });

    it('throws when the send fails again, so the dead letter counts the retry', async () => {
      delivery.redeliver.mockRejectedValueOnce(new Error('not sent: 421'));
      await expect(handler.handleRetry(retry())).rejects.toThrow('not sent: 421');
    });

    it('throws for an entry without a tenant instead of reporting it sent', async () => {
      await expect(handler.handleRetry(retry(''))).rejects.toThrow(/without a tenant/);
      expect(delivery.redeliver).not.toHaveBeenCalled();
    });
  });
});
