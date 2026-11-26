/**
 * Intelligence Activities
 *
 * Temporal activities for nightly intelligence batch:
 * - Peer group building (F-13)
 * - Reviewer quality scoring (F-12)
 */

import { Injectable, Logger } from '@nestjs/common';
import { IntelligenceService } from '../modules/intelligence/intelligence.service';
import { TenantService } from '../infrastructure/multi-tenancy/tenant.service';
import { DomainEventEmitterService } from '../infrastructure/events/event-emitter.service';
import { DomainEventType } from '../infrastructure/events/event-types';
import { withTenantContext } from '../infrastructure/multi-tenancy/tenant-context.helper';

export interface IntelligenceBatchResult {
  groupsBuilt: number;
  campaignsScored: number;
  errors: number;
}

@Injectable()
export class IntelligenceActivities {
  private readonly logger = new Logger(IntelligenceActivities.name);

  constructor(
    private readonly intelligenceService: IntelligenceService,
    private readonly tenantService: TenantService,
    private readonly eventEmitter: DomainEventEmitterService,
  ) {}

  /**
   * Build/refresh peer groups for a tenant (or all tenants).
   */
  async runPeerGroupBuild(tenantId: string): Promise<{ groupsBuilt: number; errors: number }> {
    const tenants = tenantId
      ? [{ tenantId }]
      : (await this.tenantService.findAll())
          .filter((t) => t.status === 'active')
          .map((t) => ({ tenantId: t.tenantId }));

    let totalGroupsBuilt = 0;
    let totalErrors = 0;

    for (const { tenantId: tid } of tenants) {
      try {
        const result = await withTenantContext(tid, () =>
          this.intelligenceService.buildPeerGroups(tid),
        );
        totalGroupsBuilt += result.groupsBuilt;

        this.eventEmitter.emit(DomainEventType.PEER_GROUP_UPDATED, tid, {
          tenantId: tid,
          groupKey: 'batch',
          memberCount: 0,
          outlierCount: 0,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`[Intelligence] Peer group build failed for tenant ${tid}: ${msg}`);
        totalErrors += 1;
      }
    }

    return { groupsBuilt: totalGroupsBuilt, errors: totalErrors };
  }

  /**
   * Score reviewer quality for recently completed campaigns.
   */
  async runReviewerQualityScoring(
    tenantId: string,
  ): Promise<{ campaignsScored: number; errors: number }> {
    const tenants = tenantId
      ? [{ tenantId }]
      : (await this.tenantService.findAll())
          .filter((t) => t.status === 'active')
          .map((t) => ({ tenantId: t.tenantId }));

    let totalCampaignsScored = 0;
    let totalErrors = 0;

    for (const { tenantId: tid } of tenants) {
      try {
        const unscoredCampaigns = await withTenantContext(tid, () =>
          this.intelligenceService.getUnscoredCampaigns(tid),
        );

        // What this tenant got scored: the campaigns and the distinct reviewers.
        const campaignIds: string[] = [];
        const reviewers = new Set<string>();
        for (const campaignId of unscoredCampaigns) {
          try {
            const scores = await withTenantContext(tid, () =>
              this.intelligenceService.scoreCampaign(tid, campaignId),
            );
            campaignIds.push(campaignId);
            for (const score of scores) reviewers.add(score.reviewerId);
            totalCampaignsScored++;
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            this.logger.error(
              `[Intelligence] Reviewer quality scoring failed for campaign ${campaignId}: ${msg}`,
            );
            totalErrors++;
          }
        }

        if (campaignIds.length > 0) {
          this.eventEmitter.emit(DomainEventType.REVIEWER_QUALITY_SCORED, tid, {
            tenantId: tid,
            campaignId: campaignIds[0],
            campaignIds,
            reviewersScoredCount: reviewers.size,
          });
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`[Intelligence] Reviewer quality failed for tenant ${tid}: ${msg}`);
        totalErrors += 1;
      }
    }

    return { campaignsScored: totalCampaignsScored, errors: totalErrors };
  }
}
