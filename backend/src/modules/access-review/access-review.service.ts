/**
 * Facade over AccessReviewCampaignService and AccessReviewItemService.
 * Preserves the existing public API for the controller, activities, and compliance-reporting.
 */

import { Injectable } from '@nestjs/common';
import { ReviewCampaignDocument } from './schemas/review-campaign.schema';
import { ReviewItemDocument, ReviewDecision } from './schemas/review-item.schema';
import {
  AccessReviewCampaignService,
  CreateCampaignDto,
  CampaignFilter,
} from './access-review-campaign.service';
import { AccessReviewItemService, ItemFilter } from './access-review-item.service';

export type {
  CreateCampaignDto,
  CampaignFilter,
  CampaignRecurrenceDto,
  CampaignEscalationDto,
} from './access-review-campaign.service';
export type { ItemFilter } from './access-review-item.service';

@Injectable()
export class AccessReviewService {
  constructor(
    private readonly campaigns: AccessReviewCampaignService,
    private readonly items: AccessReviewItemService,
  ) {}

  createCampaign(dto: CreateCampaignDto, createdBy: string): Promise<ReviewCampaignDocument> {
    return this.campaigns.createCampaign(dto, createdBy);
  }

  findAll(filter: CampaignFilter): Promise<{ data: ReviewCampaignDocument[]; total: number }> {
    return this.campaigns.findAll(filter);
  }

  findOne(campaignId: string): Promise<ReviewCampaignDocument> {
    return this.campaigns.findOne(campaignId);
  }

  activate(campaignId: string): Promise<ReviewCampaignDocument> {
    return this.campaigns.activate(campaignId);
  }

  cancel(campaignId: string, reason?: string): Promise<ReviewCampaignDocument> {
    return this.campaigns.cancel(campaignId, reason);
  }

  listItems(
    campaignId: string,
    filter: ItemFilter,
  ): Promise<{ data: ReviewItemDocument[]; total: number }> {
    return this.items.listItems(campaignId, filter);
  }

  getItem(itemId: string): Promise<ReviewItemDocument> {
    return this.items.getItem(itemId);
  }

  decide(
    itemId: string,
    decision: 'approved' | 'revoked',
    decidedBy: string,
    justification?: string,
  ): Promise<ReviewItemDocument> {
    return this.items.decide(itemId, decision, decidedBy, justification);
  }

  getMyReviews(
    reviewerId: string,
    filter?: { decision?: ReviewDecision; page?: number; limit?: number },
  ): Promise<{ data: ReviewItemDocument[]; total: number }> {
    return this.items.getMyReviews(reviewerId, filter);
  }
}
