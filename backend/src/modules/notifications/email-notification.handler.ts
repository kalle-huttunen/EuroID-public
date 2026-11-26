import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model, type PipelineStage } from 'mongoose';
import { DomainEventType } from '@infrastructure/events/event-types';
import type { DomainEvent } from '@infrastructure/events/domain-event.interface';
import type {
  AccessReviewCampaignActivatedPayload,
  AccessReviewEscalatedPayload,
  EmailNotificationRetryPayload,
  EntitlementExpiringPayload,
} from '@infrastructure/events/event-payloads';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { ReviewItem, ReviewItemDocument } from '../access-review/schemas/review-item.schema';
import {
  ReviewCampaign,
  ReviewCampaignDocument,
} from '../access-review/schemas/review-campaign.schema';
import { EmailNotificationService } from './email-notification.service';
import { EmailDeliveryService } from './email-delivery.service';
import { describeError } from './email-log';

/**
 * Sends the email notifications that follow domain events, next to the in-app Socket.IO events
 * (RealTimeBridgeService): reviewers when a campaign starts or overdue items move to them, and
 * owners of time-bound access 7 days and 1 day before it ends. Approvers are notified by the
 * access request workflow's notifyApprover activity instead. Runs in the API and the worker
 * (both start AppModule). With email off every handler returns at once.
 */
@Injectable()
export class EmailNotificationHandler {
  private readonly logger = new Logger(EmailNotificationHandler.name);

  constructor(
    private readonly notifications: EmailNotificationService,
    private readonly delivery: EmailDeliveryService,
    @InjectModel(ReviewItem.name) private readonly reviewItems: Model<ReviewItemDocument>,
    @InjectModel(ReviewCampaign.name) private readonly campaigns: Model<ReviewCampaignDocument>,
  ) {}

  /** One mail per reviewer with their pending item count. */
  @OnEvent(DomainEventType.ACCESS_REVIEW_CAMPAIGN_ACTIVATED, { async: true })
  async handleCampaignActivated(
    event: DomainEvent<AccessReviewCampaignActivatedPayload>,
  ): Promise<void> {
    await this.run(event, async (tenantId) => {
      const { campaignId, name, deadline } = event.payload;
      const pipeline: PipelineStage[] = [
        { $match: { tenantId, campaignId, decision: 'pending' } },
        { $group: { _id: '$reviewerId', count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ];
      const reviewers = await this.reviewItems
        .aggregate<{ _id: string; count: number }>(pipeline)
        .exec();
      for (const reviewer of reviewers) {
        await this.notifications.notifyReviewer(tenantId, {
          campaignId,
          campaignName: name,
          deadline,
          reviewerKey: reviewer._id,
          itemCount: reviewer.count,
        });
      }
    });
  }

  @OnEvent(DomainEventType.ACCESS_REVIEW_ESCALATED, { async: true })
  async handleReviewEscalated(event: DomainEvent<AccessReviewEscalatedPayload>): Promise<void> {
    await this.run(event, async (tenantId) => {
      const { itemId, campaignId, daysOverdue } = event.payload;
      // The event names no reviewer (audit log, websocket): the item holds the new one
      const item = await this.reviewItems
        .findOne({ itemId, tenantId })
        .select('reviewerId')
        .lean()
        .exec();
      if (!item?.reviewerId) return;
      const campaign = await this.campaigns
        .findOne({ campaignId, tenantId })
        .select('name')
        .lean()
        .exec();
      await this.notifications.notifyEscalatedReviewer(tenantId, {
        campaignId,
        campaignName: campaign?.name ?? 'Access review',
        reviewerKey: item.reviewerId,
        daysOverdue,
      });
    });
  }

  @OnEvent(DomainEventType.ENTITLEMENT_EXPIRING_SOON, { async: true })
  async handleExpiringSoon(event: DomainEvent<EntitlementExpiringPayload>): Promise<void> {
    await this.expiring(event, 'soon');
  }

  @OnEvent(DomainEventType.ENTITLEMENT_EXPIRING_TOMORROW, { async: true })
  async handleExpiringTomorrow(event: DomainEvent<EntitlementExpiringPayload>): Promise<void> {
    await this.expiring(event, 'tomorrow');
  }

  /**
   * Dead-letter retry of one failed email. No `async: true` and suppressErrors: false: the DLQ
   * re-emits this event with emitAsync and counts a throw as a failed retry.
   */
  @OnEvent(DomainEventType.EMAIL_NOTIFICATION_RETRY, { suppressErrors: false })
  async handleRetry(event: DomainEvent<EmailNotificationRetryPayload>): Promise<void> {
    const tenantId = event.metadata?.tenantId;
    const notificationId = event.payload?.notificationId;
    if (!tenantId || !notificationId) {
      throw new Error(`${event.type} without a tenant or a notification id: nothing to retry`);
    }
    const result = await this.delivery.redeliver(tenantId, notificationId);
    this.logger.log(`Email notification ${notificationId} retry: ${result}`);
  }

  private async expiring(
    event: DomainEvent<EntitlementExpiringPayload>,
    window: 'soon' | 'tomorrow',
  ): Promise<void> {
    await this.run(event, async (tenantId) => {
      const { identityId, targetSystem, expiresAt } = event.payload;
      if (!identityId || !targetSystem || !expiresAt) return;
      await this.notifications.notifyAccessExpiring(tenantId, {
        identityId,
        targetSystem,
        expiresAt,
        window,
      });
    });
  }

  /** Tenant from the event, email on, errors logged (masked): a mail never breaks the event bus. */
  private async run(
    event: DomainEvent<unknown>,
    fn: (tenantId: string) => Promise<void>,
  ): Promise<void> {
    if (!this.notifications.isEnabled()) return;
    const tenantId = event.metadata?.tenantId;
    if (!tenantId) {
      this.logger.warn(`Event ${event.type} missing tenantId, no email sent`);
      return;
    }
    try {
      await withTenantContext(tenantId, () => fn(tenantId));
    } catch (err: unknown) {
      this.logger.error(`Email notifications for ${event.type} failed: ${describeError(err)}`);
    }
  }
}
