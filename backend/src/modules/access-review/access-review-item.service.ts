/**
 * Manages review items: listing, retrieval, decisions, and per-reviewer queues.
 * Decisions update campaign stats and signal the Temporal campaign workflow. Only an active
 * campaign's items are open to reviewers: a cancelled or draft campaign's give 409 on a decision
 * and are not in My Reviews.
 */

import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Client } from '@temporalio/client';
import {
  CampaignStatus,
  ReviewCampaign,
  ReviewCampaignDocument,
} from './schemas/review-campaign.schema';
import { ReviewItem, ReviewItemDocument, ReviewDecision } from './schemas/review-item.schema';
import { getCurrentTenantId } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { normalizeEmail } from '@shared/utils/email';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import { TemporalClientProvider } from '@infrastructure/temporal/temporal-client.provider';

/** 503 while the API has no Temporal connection (it reconnects in the background). */
export const TEMPORAL_UNREACHABLE_MESSAGE =
  'Temporal cannot be reached right now. The API reconnects on its own; try again in a moment.';

export interface ItemFilter {
  decision?: ReviewDecision | ReviewDecision[];
  reviewerId?: string;
  page?: number;
  limit?: number;
}

@Injectable()
export class AccessReviewItemService {
  private readonly logger = new Logger(AccessReviewItemService.name);

  constructor(
    @InjectModel(ReviewCampaign.name)
    private readonly campaignModel: Model<ReviewCampaignDocument>,
    @InjectModel(ReviewItem.name)
    private readonly reviewItemModel: Model<ReviewItemDocument>,
    private readonly eventEmitter: DomainEventEmitterService,
    private readonly temporalClientProvider: TemporalClientProvider,
  ) {}

  /**
   * Campaigns in status ACTIVE in every tenant (the euroid_access_review_campaigns_active gauge,
   * read when Prometheus scrapes, outside any tenant context).
   */
  countActiveCampaignsInAllTenants(): Promise<number> {
    return this.campaignModel
      .countDocuments({ status: CampaignStatus.ACTIVE })
      .setOptions({ skipTenantScope: true })
      .exec();
  }

  private getClient(): Client {
    try {
      return this.temporalClientProvider.getClient();
    } catch {
      // The client reconnects on its own (TemporalClientProvider): a retry is all it takes
      throw new ServiceUnavailableException(TEMPORAL_UNREACHABLE_MESSAGE);
    }
  }

  async listItems(
    campaignId: string,
    filter: ItemFilter,
  ): Promise<{ data: ReviewItemDocument[]; total: number }> {
    const tenantId = getCurrentTenantId();
    const campaignExists = await this.campaignModel.exists({ campaignId, tenantId });
    if (!campaignExists) throw new NotFoundException(`Campaign ${campaignId} not found`);

    const q: Record<string, unknown> = { campaignId, tenantId };
    if (filter.decision) {
      q.decision = Array.isArray(filter.decision) ? { $in: filter.decision } : filter.decision;
    }
    // Stored lower-cased (review-item.schema.ts), so the filter asks for that form
    if (filter.reviewerId) q.reviewerId = normalizeEmail(filter.reviewerId);

    const total = await this.reviewItemModel.countDocuments(q).exec();
    const page = filter.page ?? 0;
    const limit = Math.min(filter.limit ?? 50, 100);
    const skip = page * limit;

    const data = await this.reviewItemModel
      .find(q)
      .sort({ createdAt: 1 })
      .skip(skip)
      .limit(limit)
      .exec();

    return { data, total };
  }

  async getItem(itemId: string): Promise<ReviewItemDocument> {
    const tenantId = getCurrentTenantId();
    const doc = await this.reviewItemModel.findOne({ itemId, tenantId }).exec();
    if (!doc) throw new NotFoundException(`Review item ${itemId} not found`);
    return doc;
  }

  async decide(
    itemId: string,
    decision: 'approved' | 'revoked',
    decidedBy: string,
    justification?: string,
  ): Promise<ReviewItemDocument> {
    const item = await this.getItem(itemId);

    if (
      item.reviewerId !== decidedBy &&
      item.reviewerId?.toLowerCase() !== String(decidedBy || '').toLowerCase()
    ) {
      throw new ForbiddenException('You are not the assigned reviewer for this item');
    }

    const isSelfMatch =
      String(item.identityId) === String(decidedBy) ||
      (item.identityEmail &&
        item.identityEmail.toLowerCase() === String(decidedBy || '').toLowerCase());

    if (isSelfMatch && !item.isSelfReview) {
      this.logger.warn(
        `Self-approval attempt blocked: reviewer=${decidedBy}, item=${itemId}, identityId=${item.identityId}`,
      );
      throw new ForbiddenException(
        'Segregation of Duties: You cannot approve or revoke your own access request.',
      );
    }

    if (item.decision !== 'pending') {
      throw new BadRequestException(`Item ${itemId} is already decided (${item.decision})`);
    }
    if (decision === 'revoked' && !justification?.trim()) {
      throw new BadRequestException('Justification is required when revoking');
    }
    // Only an active campaign's workflow acts on decisions: nothing acts on a cancelled one's, and
    // a draft has no workflow (items a failed activation left, r2-04 N6)
    const tenantId = getCurrentTenantId();
    const campaign = await this.campaignModel
      .findOne({ campaignId: item.campaignId, tenantId })
      .exec();
    if (campaign?.status === CampaignStatus.CANCELLED) {
      throw new ConflictException(
        `Campaign "${campaign.name}" was cancelled: its items can no longer be decided`,
      );
    }
    if (campaign && campaign.status !== CampaignStatus.ACTIVE) {
      throw new ConflictException(
        `Campaign "${campaign.name}" is not active (${campaign.status}): its items cannot be decided`,
      );
    }

    // The decision is a claim on a pending item: of two decisions at once, one is recorded
    const decided = await this.reviewItemModel
      .findOneAndUpdate(
        { itemId, tenantId, decision: 'pending' },
        { $set: { decision, decidedBy, decidedAt: new Date(), justification } },
        { new: true },
      )
      .exec();
    if (!decided) {
      throw new BadRequestException(`Item ${itemId} is already decided`);
    }

    if (decision === 'approved') {
      this.eventEmitter.emit(DomainEventType.ACCESS_REVIEW_ITEM_APPROVED, itemId, {
        itemId,
        campaignId: item.campaignId,
        identityId: item.identityId,
        decidedBy,
      });
    } else {
      this.eventEmitter.emit(DomainEventType.ACCESS_REVIEW_ITEM_REVOKED, itemId, {
        itemId,
        campaignId: item.campaignId,
        identityId: item.identityId,
        decidedBy,
        justification,
      });
    }

    await this.countDecision(item.campaignId, decision);

    if (campaign?.workflowId) {
      try {
        const handle = this.getClient().workflow.getHandle(campaign.workflowId);
        await handle.signal('signalItemDecided');
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        this.logger.warn(`Could not signal workflow for item ${itemId}: ${message}`);
      }
    }

    return decided;
  }

  /**
   * The reviewer's items, without those of cancelled campaigns (closed to reviewers) and of
   * draft ones (no workflow acts on them: items a failed activation left). `reviewerId` (the
   * signed-in email) is matched without case, as decide matches it: reviewer ids are stored
   * lower-cased (review-item.schema.ts, migration 20261126000005), so it is asked for lower-cased.
   */
  async getMyReviews(
    reviewerId: string,
    filter?: { decision?: ReviewDecision; page?: number; limit?: number },
  ): Promise<{ data: ReviewItemDocument[]; total: number }> {
    const tenantId = getCurrentTenantId();
    const closed = await this.campaignModel
      .distinct('campaignId', {
        tenantId,
        status: { $in: [CampaignStatus.CANCELLED, CampaignStatus.DRAFT] },
      })
      .exec();
    const q: Record<string, unknown> = {
      reviewerId: normalizeEmail(reviewerId),
      tenantId,
      campaignId: { $nin: closed },
    };
    if (filter?.decision) q.decision = filter.decision;

    const total = await this.reviewItemModel.countDocuments(q).exec();
    const page = filter?.page ?? 0;
    const limit = Math.min(filter?.limit ?? 50, 100);
    const skip = page * limit;

    const data = await this.reviewItemModel
      .find(q)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .exec();

    return { data, total };
  }

  /**
   * The campaign stats after one item went from pending to `decision`: moved by that one step,
   * so concurrent decisions never leave a stale snapshot. The campaign's completion recounts.
   */
  private async countDecision(campaignId: string, decision: 'approved' | 'revoked'): Promise<void> {
    await this.campaignModel
      .updateOne(
        { campaignId, tenantId: getCurrentTenantId() },
        { $inc: { 'stats.pending': -1, [`stats.${decision}`]: 1 } },
      )
      .exec();
  }
}
