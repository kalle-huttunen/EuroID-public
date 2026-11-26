/**
 * Intelligence Service
 *
 * Core service for AI access intelligence features:
 * - F-12: Rubber-stamp detection (reviewer quality scoring)
 * - F-13: Peer group deviation scoring
 * - F-14: Smart access request recommendations
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { createHash } from 'crypto';

import {
  ReviewerQualityScore,
  type ReviewerQualityDocument,
} from './schemas/reviewer-quality-score.schema';
import {
  PeerGroup,
  type PeerGroupDocument,
  type EntitlementBaseline,
  type PeerGroupOutlier,
} from './schemas/peer-group.schema';
import { HeldAccessService, type GrantedBy } from './held-access.service';
import { ReviewItem, type ReviewItemDocument } from '../access-review/schemas/review-item.schema';
import {
  ReviewCampaign,
  type ReviewCampaignDocument,
  CampaignStatus,
} from '../access-review/schemas/review-campaign.schema';
import { Identity, type IdentityDocument } from '../identity/schemas/identity.schema';
import {
  EntitlementCatalog,
  type EntitlementCatalogDocument,
} from '../entitlement-catalog/schemas/entitlement-catalog.schema';
import {
  type IntelligenceConfig,
  intelligenceConfig,
} from '@infrastructure/config/intelligence.config';
import { getCurrentTenantId } from '@infrastructure/multi-tenancy/tenant-context.helper';

// ── F-12: Rubber-Stamp Detection ──────────────────────────────────────

/** Bulk approving: INTELLIGENCE_BULK_APPROVE_WINDOW_COUNT approvals within this many minutes. */
const BULK_WINDOW_MINUTES = 5;
const BULK_WINDOW_MS = BULK_WINDOW_MINUTES * 60 * 1000;

/** An entitlement recommended to an identity (GET /intelligence/recommendations/:identityId). */
export interface AccessRecommendation {
  entitlementId: string;
  system: string;
  name: string;
  /** Share of the peer group holding it, 0 to 1. */
  holdRate: number;
  /** How the peers hold it: role-based rules (policy), access requests, or both. */
  grantedBy: GrantedBy[];
  /** The catalog has an entry for it that is requestable. */
  requestable: boolean;
  /** The catalog entry's risk level; absent when the catalog has none. */
  riskLevel?: string;
}

@Injectable()
export class IntelligenceService {
  private readonly logger = new Logger(IntelligenceService.name);

  constructor(
    @InjectModel(ReviewerQualityScore.name)
    private readonly qualityModel: Model<ReviewerQualityDocument>,
    @InjectModel(PeerGroup.name)
    private readonly peerGroupModel: Model<PeerGroupDocument>,
    @InjectModel(ReviewItem.name)
    private readonly reviewItemModel: Model<ReviewItemDocument>,
    @InjectModel(ReviewCampaign.name)
    private readonly campaignModel: Model<ReviewCampaignDocument>,
    @InjectModel(Identity.name)
    private readonly identityModel: Model<IdentityDocument>,
    @InjectModel(EntitlementCatalog.name)
    private readonly catalogModel: Model<EntitlementCatalogDocument>,
    private readonly heldAccess: HeldAccessService,
    @Inject(intelligenceConfig.KEY) private readonly conf: IntelligenceConfig,
  ) {}

  // ── F-12: Rubber-Stamp Detection ────────────────────────────────────

  /**
   * Score all reviewers in a campaign for rubber-stamping behavior.
   */
  async scoreCampaign(tenantId: string, campaignId: string): Promise<ReviewerQualityDocument[]> {
    const items = await this.reviewItemModel
      .find({ tenantId, campaignId, decision: { $in: ['approved', 'revoked'] } })
      .lean()
      .exec();

    if (items.length === 0) return [];

    // Group items by reviewer
    const byReviewer = new Map<string, typeof items>();
    for (const item of items) {
      const reviewerId = item.decidedBy ?? item.reviewerId;
      const list = byReviewer.get(reviewerId) ?? [];
      list.push(item);
      byReviewer.set(reviewerId, list);
    }

    const now = new Date();
    const results: ReviewerQualityDocument[] = [];

    for (const [reviewerId, reviewerItems] of byReviewer) {
      const totalDecisions = reviewerItems.length;
      const approvedItems = reviewerItems.filter((i) => i.decision === 'approved');
      const approvalRate = totalDecisions > 0 ? approvedItems.length / totalDecisions : 0;

      // Calculate average decision time (decidedAt - createdAt)
      const decisionTimes: number[] = [];
      for (const item of reviewerItems) {
        if (item.decidedAt && (item as unknown as Record<string, unknown>).createdAt) {
          const createdAt = (item as unknown as Record<string, unknown>).createdAt as Date;
          const ms = new Date(item.decidedAt).getTime() - new Date(createdAt).getTime();
          if (ms >= 0) decisionTimes.push(ms);
        }
      }
      const avgDecisionTimeMs =
        decisionTimes.length > 0
          ? decisionTimes.reduce((a, b) => a + b, 0) / decisionTimes.length
          : 0;
      const avgDecisionTimeSeconds = avgDecisionTimeMs / 1000;

      // Bulk approvals: INTELLIGENCE_BULK_APPROVE_WINDOW_COUNT (10) approvals within 5 minutes
      const bulkApproveCount = this.countBulkApprovals(
        approvedItems,
        this.conf.bulkApproveWindowCount,
      );

      // No-justification rate (for approved items only)
      const noJustApproved = approvedItems.filter(
        (i) => !i.justification || i.justification.trim() === '',
      );
      const noJustificationRate =
        approvedItems.length > 0 ? noJustApproved.length / approvedItems.length : 0;

      // Quality score formula (from task spec)
      const qualityScore = Math.max(
        0,
        100 -
          (approvalRate > 0.95 ? 30 : 0) -
          (avgDecisionTimeMs < this.conf.rubberStampThresholdMs ? 25 : 0) -
          (bulkApproveCount > 0 ? 20 : 0) -
          (noJustificationRate > 0.5 ? 25 : 0),
      );

      // Flag decisions: approved + no justification + decision time < 15s
      const flaggedDecisions: string[] = [];
      for (const item of approvedItems) {
        const hasNoJustification = !item.justification || item.justification.trim() === '';
        if (
          hasNoJustification &&
          item.decidedAt &&
          (item as unknown as Record<string, unknown>).createdAt
        ) {
          const createdAt = (item as unknown as Record<string, unknown>).createdAt as Date;
          const decisionMs = new Date(item.decidedAt).getTime() - new Date(createdAt).getTime();
          if (decisionMs < 15_000) {
            flaggedDecisions.push(item.itemId);
          }
        }
      }

      const doc = await this.qualityModel.findOneAndUpdate(
        { tenantId, reviewerId, campaignId },
        {
          $set: {
            qualityScore,
            signals: {
              approvalRate,
              avgDecisionTimeSeconds,
              bulkApproveCount,
              noJustificationRate,
            },
            flaggedDecisions,
            decisionTimeThresholdSeconds: this.conf.rubberStampThresholdMs / 1000,
            bulkApproveWindowCount: this.conf.bulkApproveWindowCount,
            bulkApproveWindowMinutes: BULK_WINDOW_MINUTES,
            calculatedAt: now,
          },
        },
        { upsert: true, new: true },
      );
      results.push(doc);
    }

    return results;
  }

  /**
   * Get reviewer quality scores, optionally filtered by campaign.
   */
  async getReviewerScores(
    tenantId: string,
    campaignId?: string,
    page = 1,
    limit = 50,
  ): Promise<{ data: ReviewerQualityDocument[]; total: number }> {
    const filter: Record<string, unknown> = { tenantId };
    if (campaignId) filter.campaignId = campaignId;

    const [data, total] = await Promise.all([
      this.qualityModel
        .find(filter)
        .sort({ qualityScore: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean()
        .exec(),
      this.qualityModel.countDocuments(filter).exec(),
    ]);
    return { data: data as ReviewerQualityDocument[], total };
  }

  /**
   * 1 when `windowThreshold` approvals fell within the bulk window (5 minutes), else 0.
   */
  private countBulkApprovals(
    approvedItems: Array<{ decidedAt?: Date }>,
    windowThreshold: number,
  ): number {
    const sorted = approvedItems
      .filter((i) => i.decidedAt)
      .map((i) => new Date(i.decidedAt!).getTime())
      .sort((a, b) => a - b);

    let bulkCount = 0;
    for (let i = 0; i <= sorted.length - windowThreshold; i++) {
      if (sorted[i + windowThreshold - 1] - sorted[i] <= BULK_WINDOW_MS) {
        bulkCount++;
        break; // Count presence of bulk behavior, not every window
      }
    }
    return bulkCount;
  }

  // ── F-13: Peer Group Deviation Scoring ──────────────────────────────

  /**
   * Build or refresh peer groups for a tenant, and remove the tenant's groups this build did not
   * write (a group below the minimum size, or one no identity has the attributes of any more).
   * Groups identities by (department, jobTitle). A member's access is what they hold
   * (HeldAccessService, status Active); a member whose access cannot be resolved is left out.
   */
  async buildPeerGroups(tenantId: string): Promise<{ groupsBuilt: number }> {
    const identities = await this.identityModel
      .find({ tenantId, deletedAt: null, 'profile.status': { $ne: 'TERMINATED' } })
      .select('_id profile')
      .sort({ _id: 1 })
      .lean()
      .exec();

    // Group by (departmentName, jobTitle)
    const groupMap = new Map<
      string,
      { attrs: { department?: string; jobTitle?: string; location?: string }; members: string[] }
    >();

    for (const identity of identities) {
      const dept = (
        identity as unknown as Record<string, unknown> & { profile?: Record<string, unknown> }
      )?.profile?.departmentName as string | undefined;
      const title = (
        identity as unknown as Record<string, unknown> & { profile?: Record<string, unknown> }
      )?.profile?.jobTitle as string | undefined;
      if (!dept && !title) continue;

      const key = `dept:${dept ?? ''}|title:${title ?? ''}`;
      const existing = groupMap.get(key);
      if (existing) {
        existing.members.push(String(identity._id));
      } else {
        groupMap.set(key, {
          attrs: { department: dept, jobTitle: title },
          members: [String(identity._id)],
        });
      }
    }

    const minSize = this.conf.peerGroupMinSize;
    const calculatedAt = new Date();
    const builtKeys: string[] = [];

    for (const [, group] of groupMap) {
      if (group.members.length < minSize) continue;

      const groupKey = createHash('sha256')
        .update(JSON.stringify(group.attrs))
        .digest('hex')
        .slice(0, 16);

      // The access each member holds (Active), and how the members hold each entitlement
      const grants = await this.heldAccess.grantsByIdentity(tenantId, group.members);
      const memberEntitlements = new Map<string, Set<string>>();
      const allEntitlements = new Map<
        string,
        { system: string; name: string; grantedBy: Set<GrantedBy> }
      >();
      for (const memberId of group.members) {
        const memberGrants = grants.get(memberId);
        if (!memberGrants) continue;
        const entIds = new Set<string>();
        for (const grant of memberGrants) {
          if (grant.status !== 'Active') continue;
          entIds.add(grant.entitlementId);
          const info = allEntitlements.get(grant.entitlementId) ?? {
            system: grant.system,
            name: grant.name,
            grantedBy: new Set<GrantedBy>(),
          };
          info.grantedBy.add(grant.grantedBy);
          allEntitlements.set(grant.entitlementId, info);
        }
        memberEntitlements.set(memberId, entIds);
      }

      const effectiveMembers = group.members.filter((m) => memberEntitlements.has(m));
      if (effectiveMembers.length < minSize) continue;

      // Compute hold rate per entitlement
      const entitlementBaseline: EntitlementBaseline[] = [];
      for (const [entKey, info] of allEntitlements) {
        const holdCount = effectiveMembers.filter((m) =>
          memberEntitlements.get(m)?.has(entKey),
        ).length;
        const holdRate = holdCount / effectiveMembers.length;
        entitlementBaseline.push({
          entitlementId: entKey,
          system: info.system,
          name: info.name,
          holdRate,
          grantedBy: [...info.grantedBy].sort(),
        });
      }

      // Identify outliers
      const outliers: PeerGroupOutlier[] = [];

      for (const memberId of effectiveMembers) {
        const memberEnts = memberEntitlements.get(memberId) ?? new Set<string>();
        // Unique entitlements: held by < outlierHoldRate of peers
        const uniqueEntitlements = [...memberEnts].filter((entKey) => {
          const baseline = entitlementBaseline.find((b) => b.entitlementId === entKey);
          return baseline && baseline.holdRate < this.conf.outlierHoldRate;
        });
        // Missing baseline: baseline entitlements the member lacks (> missingBaselineRate)
        const missingBaseline = entitlementBaseline
          .filter(
            (b) => b.holdRate >= this.conf.missingBaselineRate && !memberEnts.has(b.entitlementId),
          )
          .map((b) => b.entitlementId);

        const deviationScore = Math.min(
          100,
          uniqueEntitlements.length * 10 + missingBaseline.length * 5,
        );

        if (deviationScore > 0) {
          outliers.push({
            identityId: memberId,
            uniqueEntitlements,
            missingBaseline,
            deviationScore,
          });
        }
      }

      outliers.sort((a, b) => b.deviationScore - a.deviationScore);

      await this.peerGroupModel.findOneAndUpdate(
        { tenantId, groupKey },
        {
          $set: {
            attributes: group.attrs,
            memberCount: effectiveMembers.length,
            memberIds: effectiveMembers,
            entitlementBaseline,
            outliers,
            calculatedAt,
          },
        },
        { upsert: true },
      );
      builtKeys.push(groupKey);
    }

    // A group this build did not write is no longer a group: remove it, so no lookup finds it.
    const removed = await this.peerGroupModel
      .deleteMany({ tenantId, groupKey: { $nin: builtKeys } })
      .exec();
    if (removed.deletedCount > 0) {
      this.logger.log(`Removed ${removed.deletedCount} peer group(s) of tenant ${tenantId}`);
    }

    return { groupsBuilt: builtKeys.length };
  }

  /**
   * Find the peer group for a given identity: after a build it is in at most one, and should a
   * stored group still name it (a build that stopped part way), the latest computed one wins.
   */
  async getGroupForIdentity(
    tenantId: string,
    identityId: string,
  ): Promise<PeerGroupDocument | null> {
    return this.peerGroupModel
      .findOne({ tenantId, memberIds: identityId })
      .sort({ calculatedAt: -1, groupKey: 1 })
      .lean()
      .exec() as Promise<PeerGroupDocument | null>;
  }

  /**
   * Get top outliers across all peer groups.
   */
  async getOutliers(
    tenantId: string,
    limit = 50,
  ): Promise<
    Array<{
      identityId: string;
      groupKey: string;
      deviationScore: number;
      uniqueEntitlements: string[];
      missingBaseline: string[];
    }>
  > {
    const groups = await this.peerGroupModel.find({ tenantId }).lean().exec();
    const allOutliers: Array<{
      identityId: string;
      groupKey: string;
      deviationScore: number;
      uniqueEntitlements: string[];
      missingBaseline: string[];
    }> = [];

    for (const group of groups) {
      for (const outlier of group.outliers) {
        allOutliers.push({
          identityId: outlier.identityId,
          groupKey: group.groupKey,
          deviationScore: outlier.deviationScore,
          uniqueEntitlements: outlier.uniqueEntitlements,
          missingBaseline: outlier.missingBaseline,
        });
      }
    }

    allOutliers.sort((a, b) => b.deviationScore - a.deviationScore);
    return allOutliers.slice(0, limit);
  }

  /**
   * Get outliers within a specific peer group.
   */
  async getGroupOutliers(tenantId: string, groupKey: string): Promise<PeerGroupOutlier[]> {
    const group = await this.peerGroupModel.findOne({ tenantId, groupKey }).lean().exec();
    if (!group) return [];
    return group.outliers;
  }

  /**
   * Get peer deviation score (0-100) for risk scoring integration.
   * Returns 0 if no peer group found.
   */
  async getPeerDeviationScore(tenantId: string, identityId: string): Promise<number> {
    const group = await this.getGroupForIdentity(tenantId, identityId);
    if (!group) return 0;
    const outlier = group.outliers.find((o) => o.identityId === identityId);
    return outlier?.deviationScore ?? 0;
  }

  /**
   * Get all peer groups for a tenant.
   */
  async getPeerGroups(
    tenantId: string,
    page = 1,
    limit = 50,
  ): Promise<{ data: PeerGroupDocument[]; total: number }> {
    const [data, total] = await Promise.all([
      this.peerGroupModel
        .find({ tenantId })
        .sort({ memberCount: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean()
        .exec(),
      this.peerGroupModel.countDocuments({ tenantId }).exec(),
    ]);
    return { data: data as PeerGroupDocument[], total };
  }

  // ── F-14: Smart Access Request Recommendations ──────────────────────

  /**
   * Entitlements most of the identity's peer group holds and the identity does not, most held
   * first: what the identity page lists for it as Active or Pending counts as had, so access on
   * its way is not recommended. Each says how the peers hold it and whether the catalog offers it
   * for request (requestable false: no catalog entry, or one not requestable). Empty when the
   * identity is in no group or its access cannot be resolved.
   */
  async getRecommendations(tenantId: string, identityId: string): Promise<AccessRecommendation[]> {
    const group = await this.getGroupForIdentity(tenantId, identityId);
    if (!group) return [];

    const grants = (await this.heldAccess.grantsByIdentity(tenantId, [identityId])).get(identityId);
    if (!grants) return [];
    const currentEnts = new Set(
      grants.filter((g) => g.status !== 'Revoked').map((g) => g.entitlementId),
    );

    // Find entitlements held by > recommendationHoldRate of peers but not by this identity
    const recommendations = group.entitlementBaseline
      .filter(
        (b) => b.holdRate >= this.conf.recommendationHoldRate && !currentEnts.has(b.entitlementId),
      )
      .sort((a, b) => b.holdRate - a.holdRate)
      .slice(0, this.conf.recommendationMax);

    // Enrich with the catalog's risk level and whether it can be requested
    const enriched: AccessRecommendation[] = [];
    for (const rec of recommendations) {
      // The id part of `system::id`: a native id, or the name a policy or a request uses
      const id = rec.entitlementId.slice(rec.system.length + 2);
      const catalogEntry = await this.catalogModel
        .findOne({
          tenantId,
          system: rec.system,
          $or: [{ nativeId: id }, { name: rec.name }],
        })
        .select('riskLevel requestable')
        .lean()
        .exec();

      enriched.push({
        entitlementId: rec.entitlementId,
        system: rec.system,
        name: rec.name,
        holdRate: rec.holdRate,
        grantedBy: rec.grantedBy ?? [],
        requestable: catalogEntry?.requestable === true,
        riskLevel: catalogEntry?.riskLevel,
      });
    }

    return enriched;
  }

  /**
   * Check if a requested entitlement is unusual for the identity's peer group.
   * Returns a warning message or null.
   */
  async getUnusualRequestWarning(
    tenantId: string,
    identityId: string,
    entitlementId: string,
  ): Promise<{ warning: string; severity: 'INFO' | 'WARNING' | 'CRITICAL' } | null> {
    const group = await this.getGroupForIdentity(tenantId, identityId);
    if (!group) return null;

    const baseline = group.entitlementBaseline.find((b) => b.entitlementId === entitlementId);

    if (!baseline) {
      return {
        warning: 'No peers in your group have this access.',
        severity: 'CRITICAL',
      };
    }

    if (baseline.holdRate < this.conf.unusualRequestThreshold) {
      return {
        warning: `Only ${Math.round(baseline.holdRate * 100)}% of your peers have this access.`,
        severity: 'CRITICAL',
      };
    }

    if (baseline.holdRate < this.conf.outlierHoldRate) {
      return {
        warning: `This access is uncommon in your peer group (${Math.round(baseline.holdRate * 100)}% hold rate).`,
        severity: 'WARNING',
      };
    }

    return null;
  }

  /**
   * Get all completed campaigns that have not been scored yet.
   */
  async getUnscoredCampaigns(tenantId: string): Promise<string[]> {
    const completedCampaigns = await this.campaignModel
      .find({ tenantId, status: CampaignStatus.COMPLETED })
      .select('campaignId')
      .lean()
      .exec();

    const unscoredIds: string[] = [];
    for (const campaign of completedCampaigns) {
      const hasScores = await this.qualityModel.exists({
        tenantId,
        campaignId: campaign.campaignId,
      });
      if (!hasScores) {
        unscoredIds.push(campaign.campaignId);
      }
    }

    return unscoredIds;
  }
}
