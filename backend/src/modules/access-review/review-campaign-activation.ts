/**
 * One activation of a campaign at a time, and nothing left behind by one that fails
 * (AccessReviewCampaignService.activate). The activation claims the DRAFT campaign by stamping
 * `activationStartedAt` and its own `activationId`, then clears the items an earlier attempt
 * left; a failure deletes the items and puts the campaign back to DRAFT. A claim older than
 * `activationClaimMs` (ACCESS_REVIEW_ACTIVATION_CLAIM_MS: the process that made it stopped) can
 * be taken over, so a live activation refreshes its claim while it generates items
 * (refreshActivationClaim). Every later write of the activation names its `activationId`: one
 * that lost its claim to another activation never changes that activation's campaign or items.
 */
import { randomUUID } from 'crypto';
import { ConflictException } from '@nestjs/common';
import type { Model } from 'mongoose';
import { CampaignStatus, type ReviewCampaignDocument } from './schemas/review-campaign.schema';
import type { ReviewItemDocument } from './schemas/review-item.schema';

/**
 * Claims the DRAFT campaign for an activation; its `activationId`, or null while another
 * activation holds it.
 */
export async function claimActivation(
  campaignModel: Model<ReviewCampaignDocument>,
  itemModel: Model<ReviewItemDocument>,
  tenantId: string,
  campaignId: string,
  activationClaimMs: number,
): Promise<string | null> {
  const now = new Date();
  const activationId = randomUUID();
  const claimed = await campaignModel
    .updateOne(
      {
        tenantId,
        campaignId,
        status: CampaignStatus.DRAFT,
        $or: [
          { activationStartedAt: null },
          { activationStartedAt: { $lt: new Date(now.getTime() - activationClaimMs) } },
        ],
      },
      { $set: { activationStartedAt: now, activationId } },
    )
    .exec();
  if (claimed.modifiedCount === 0) return null;
  // What an earlier attempt left (a process that stopped partway, or an older build)
  await itemModel.deleteMany({ tenantId, campaignId }).exec();
  return activationId;
}

/**
 * Renews the claim of activation `activationId` (activationStartedAt = now), before it writes
 * the next items. Throws ConflictException when the campaign is no longer its DRAFT: another
 * activation took it over, or it was cancelled.
 */
export async function refreshActivationClaim(
  campaignModel: Model<ReviewCampaignDocument>,
  tenantId: string,
  campaignId: string,
  activationId: string,
): Promise<void> {
  const held = await campaignModel
    .updateOne(
      { tenantId, campaignId, activationId, status: CampaignStatus.DRAFT },
      { $set: { activationStartedAt: new Date() } },
    )
    .exec();
  if (held.matchedCount === 0) {
    throw new ConflictException(
      `Campaign ${campaignId} was cancelled, or taken over by another activation, during activation`,
    );
  }
}

/**
 * After a failed activation `activationId`: its items are deleted and the campaign is DRAFT again
 * without a claim. A campaign cancelled meanwhile stays CANCELLED (its items are deleted too). A
 * campaign another activation has claimed since is left as it is, items included. The claim is
 * renewed while the items are deleted, so no activation takes the campaign over halfway.
 */
export async function releaseFailedActivation(
  campaignModel: Model<ReviewCampaignDocument>,
  itemModel: Model<ReviewItemDocument>,
  tenantId: string,
  campaignId: string,
  activationId: string,
): Promise<void> {
  const mine = { tenantId, campaignId, activationId };
  const reset = await campaignModel
    .updateOne(
      { ...mine, status: { $in: [CampaignStatus.DRAFT, CampaignStatus.ACTIVE] } },
      {
        $set: { status: CampaignStatus.DRAFT, activationStartedAt: new Date() },
        $unset: { workflowId: '' },
      },
    )
    .exec();
  if (reset.matchedCount === 0 && !(await campaignModel.exists(mine).exec())) return;
  await itemModel.deleteMany({ tenantId, campaignId }).exec();
  await campaignModel
    .updateOne(mine, { $unset: { activationStartedAt: '', activationId: '' } })
    .exec();
}
