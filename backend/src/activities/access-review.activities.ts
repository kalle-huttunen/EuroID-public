import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { validateActivityContext } from '@shared/utils/activity-context';
import { Model } from 'mongoose';
import {
  ReviewItem,
  ReviewItemDocument,
} from '../modules/access-review/schemas/review-item.schema';
import {
  ReviewCampaign,
  ReviewCampaignDocument,
  CampaignStatus,
  type RecurrenceFrequency,
} from '../modules/access-review/schemas/review-campaign.schema';
import { EntraService } from '../modules/connectors/entra-connector/entra.service';
import { IdentityService } from '../modules/identity/identity.service';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import { safeLog } from '@infrastructure/observability/pii-redact.format';
import { summarizeRevocations } from '../modules/access-review/review-revocation';
import { maskEmail } from '../modules/identity/identity-pii';
import { maskEmails } from './deprovision-failure';
import { sameEmail } from '@shared/utils/email';

/**
 * Temporal Activities for Access Review workflow.
 * All DB reads/writes go here — workflow must NOT query MongoDB directly. (Determinism)
 */
@Injectable()
export class AccessReviewActivities {
  private readonly logger = new Logger(AccessReviewActivities.name);

  constructor(
    @InjectModel(ReviewItem.name)
    private readonly reviewItemModel: Model<ReviewItemDocument>,
    @InjectModel(ReviewCampaign.name)
    private readonly campaignModel: Model<ReviewCampaignDocument>,
    private readonly entraService: EntraService,
    private readonly identityService: IdentityService,
    private readonly eventEmitter: DomainEventEmitterService,
  ) {}

  /** True when the campaign was cancelled: its workflow's activities then change nothing. */
  private async isCancelled(campaignId: string): Promise<boolean> {
    const campaign = await this.campaignModel
      .findOne({ campaignId })
      .select('status')
      .lean()
      .exec();
    return campaign?.status === CampaignStatus.CANCELLED;
  }

  /**
   * Mark all pending items in a campaign as expired (not in a cancelled campaign).
   */
  async expirePendingItems(
    campaignId: string,
    tenantId?: string,
    correlationId?: string,
  ): Promise<number> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      async () => {
        if (await this.isCancelled(campaignId)) {
          this.logger.log(`[AccessReview] Campaign ${campaignId} cancelled, nothing expired`);
          return 0;
        }
        this.logger.log(`[AccessReview] Expiring pending items for campaign ${campaignId}`);
        const result = await this.reviewItemModel
          .updateMany(
            { campaignId, decision: 'pending' },
            { $set: { decision: 'expired', autoExpired: true } },
          )
          .exec();

        const count = result.modifiedCount;
        if (count > 0) {
          const items = await this.reviewItemModel
            .find({ campaignId, decision: 'expired', autoExpired: true })
            .exec();
          for (const item of items) {
            this.eventEmitter.emit(DomainEventType.ACCESS_REVIEW_ITEM_EXPIRED, item.itemId, {
              itemId: item.itemId,
              campaignId,
              identityId: item.identityId,
              reviewerId: item.reviewerId,
            });
          }
        }
        this.logger.log(`[AccessReview] Expired ${count} items for campaign ${campaignId}`);
        return count;
      },
      { correlationId },
    );
  }

  /**
   * Legacy: only workflow histories from before the patch `access-review:connector-revocation`
   * call this (new executions use AccessReviewRevocationActivities). Removes Entra ID group
   * memberships of revoked/expired items when autoRevokeOnExpiry is true; records no result.
   */
  async executeRevocations(
    campaignId: string,
    tenantId?: string,
    correlationId?: string,
  ): Promise<number> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      async () => {
        const campaign = await this.campaignModel.findOne({ campaignId }).exec();
        if (campaign?.status === CampaignStatus.CANCELLED) return 0;
        if (!campaign || !campaign.autoRevokeOnExpiry) {
          this.logger.log(
            `[AccessReview] Campaign ${campaignId} has autoRevokeOnExpiry=false, skipping revocations`,
          );
          return 0;
        }

        const items = await this.reviewItemModel
          .find({ campaignId, decision: { $in: ['revoked', 'expired'] } })
          .exec();

        let revocationsExecuted = 0;
        if (!(await this.entraService.isConfiguredForTenant())) {
          this.logger.warn(
            `[AccessReview] Entra not configured, cannot execute revocations for ${items.length} items`,
          );
          return 0;
        }

        for (const item of items) {
          for (const ent of item.entitlements || []) {
            if (ent.system !== 'entra-id' && ent.system !== 'entra') continue;
            if (ent.type !== 'group' && ent.type !== 'Group') continue;

            try {
              const userId = await this.entraService.checkUserExists(item.identityEmail);
              if (!userId) {
                this.logger.warn(
                  `[AccessReview] User ${maskEmail(item.identityEmail)} not found in Entra, skipping revocation`,
                );
                continue;
              }
              const groupId = ent.nativeId || ent.name;
              if (!groupId) continue;

              const success = await this.entraService.removeFromGroup(userId, groupId);
              if (success) revocationsExecuted++;
            } catch (e: unknown) {
              const message = e instanceof Error ? e.message : String(e);
              this.logger.error(
                `[AccessReview] Failed to revoke ${ent.name} for ${maskEmail(item.identityEmail)}: ${maskEmails(message)}`,
              );
            }
          }
        }

        this.logger.log(
          `[AccessReview] Executed ${revocationsExecuted} revocations for campaign ${campaignId}`,
        );
        return revocationsExecuted;
      },
      { correlationId },
    );
  }

  /**
   * Update campaign status to COMPLETED and recalculate stats.
   * For recurring campaigns, sets recurrence.nextRunAt = completedAt + frequency.
   * A cancelled campaign stays CANCELLED.
   */
  async completeCampaign(
    campaignId: string,
    tenantId?: string,
    correlationId?: string,
  ): Promise<void> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      async () => {
        this.logger.log(`[AccessReview] Completing campaign ${campaignId}`);

        const campaign = await this.campaignModel.findOne({ campaignId }).exec();
        if (!campaign) return;
        if (campaign.status === CampaignStatus.CANCELLED) {
          this.logger.log(`[AccessReview] Campaign ${campaignId} cancelled, not completed`);
          return;
        }

        const items = await this.reviewItemModel.find({ campaignId }).exec();
        const stats = {
          totalItems: items.length,
          approved: items.filter((i) => i.decision === 'approved').length,
          revoked: items.filter((i) => i.decision === 'revoked').length,
          pending: items.filter((i) => i.decision === 'pending').length,
          expired: items.filter((i) => i.decision === 'expired').length,
        };

        const completedAt = new Date();
        const update: Record<string, unknown> = {
          status: CampaignStatus.COMPLETED,
          stats,
          completedAt,
        };
        const revocationSummary = summarizeRevocations(items);
        if (revocationSummary) update.revocationSummary = revocationSummary;

        if (campaign.recurrence?.enabled && campaign.recurrence.frequency) {
          const months = { MONTHLY: 1, QUARTERLY: 3, SEMI_ANNUAL: 6, ANNUAL: 12 }[
            campaign.recurrence.frequency as RecurrenceFrequency
          ];
          const nextRunAt = new Date(completedAt);
          nextRunAt.setMonth(nextRunAt.getMonth() + months);
          update['recurrence.nextRunAt'] = nextRunAt;
        }

        const written = await this.campaignModel
          .updateOne({ campaignId, status: { $ne: CampaignStatus.CANCELLED } }, { $set: update })
          .exec();
        if (written.matchedCount === 0) return; // cancelled meanwhile

        this.eventEmitter.emit(DomainEventType.ACCESS_REVIEW_CAMPAIGN_COMPLETED, campaignId, {
          campaignId,
          stats,
        });
        this.logger.log(
          `[AccessReview] Campaign ${campaignId} completed with stats: ${safeLog(stats)}`,
        );
      },
      { correlationId },
    );
  }

  /**
   * Get remaining milliseconds until deadline. Used by workflow for deterministic sleep.
   */
  async getRemainingMsUntilDeadline(deadline: Date): Promise<number> {
    const now = Date.now();
    const deadlineMs = new Date(deadline).getTime();
    return Math.max(0, Math.floor(deadlineMs - now));
  }

  /**
   * Query: get current campaign progress (for workflow query handler).
   */
  async getCampaignProgress(
    campaignId: string,
    tenantId?: string,
    correlationId?: string,
  ): Promise<{ total: number; pending: number; decided: number }> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      async () => {
        const [total, pending] = await Promise.all([
          this.reviewItemModel.countDocuments({ campaignId }).exec(),
          this.reviewItemModel.countDocuments({ campaignId, decision: 'pending' }).exec(),
        ]);
        return { total, pending, decided: total - pending };
      },
      { correlationId },
    );
  }

  /**
   * Escalate overdue pending items to manager or admin.
   * Items pending longer than escalateAfterDays are reassigned.
   */
  async checkAndEscalateOverdue(
    campaignId: string,
    tenantId?: string,
    correlationId?: string,
  ): Promise<number> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      async () => {
        const campaign = await this.campaignModel.findOne({ campaignId }).exec();
        if (!campaign?.escalation?.enabled) return 0;
        if (campaign.status === CampaignStatus.CANCELLED) return 0;

        const { escalateAfterDays, escalateTo } = campaign.escalation;
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - escalateAfterDays);

        const overdueItems = await this.reviewItemModel
          .find({
            campaignId,
            decision: 'pending',
            createdAt: { $lt: cutoff },
            escalatedFrom: { $exists: false },
          })
          .exec();

        let escalated = 0;
        for (const item of overdueItems) {
          let targetEmail: string | null = null;
          if (escalateTo === 'MANAGER') {
            const identity = await this.identityService
              .findByEmail(item.reviewerId)
              .catch(() => null);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- identity is a dynamic lean document from identity service
            const id = identity as any;
            targetEmail = id?.profile?.managerEmail ?? id?.managerEmail ?? null;
          } else if (escalateTo === 'ADMIN') {
            targetEmail = campaign.createdBy;
          }
          // Reviewer ids are stored lower-cased: the same person in another case is no move
          if (!targetEmail || sameEmail(targetEmail, item.reviewerId)) continue;

          await this.reviewItemModel
            .updateOne(
              { itemId: item.itemId },
              {
                $set: {
                  reviewerId: targetEmail,
                  escalatedFrom: item.reviewerId,
                  escalatedAt: new Date(),
                },
              },
            )
            .exec();

          // No reviewer address (audit log, websocket): the mail handler reads it from the item
          this.eventEmitter.emit(DomainEventType.ACCESS_REVIEW_ESCALATED, item.itemId, {
            itemId: item.itemId,
            campaignId,
            daysOverdue: escalateAfterDays,
          });
          this.logger.log(
            `[AccessReview] Escalated item ${item.itemId} from ${maskEmail(item.reviewerId)} to ${maskEmail(targetEmail)}`,
          );
          escalated++;
        }
        return escalated;
      },
      { correlationId },
    );
  }
}
