import { Module, OnModuleInit } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ConfigModule } from '@nestjs/config';
import { accessReviewConfig } from '@infrastructure/config/access-review.config';
import { MetricsService } from '@infrastructure/observability/metrics.service';
import { AccessReviewController } from './access-review.controller';
import { AccessReviewService } from './access-review.service';
import { AccessReviewCampaignService } from './access-review-campaign.service';
import { AccessReviewItemService } from './access-review-item.service';
import { AccessReviewActivities } from '../../activities/access-review.activities';
import { AccessReviewRevocationActivities } from '../../activities/access-review-revocation.activities';
import { ReviewAccountRevocation } from '../../activities/access-review-account-revocation';
import { EntitlementExpiryActivitiesModule } from '../../activities/entitlement-expiry-activities.module';
import { AccessReviewTimelineHandler } from '../../infrastructure/events/handlers/access-review-timeline.handler';
import { ConfigActivities } from '../../activities/config.activities';
import { ReviewTargetAccessService } from './review-target-access.service';
import { ReviewCampaign, ReviewCampaignSchema } from './schemas/review-campaign.schema';
import { ReviewItem, ReviewItemSchema } from './schemas/review-item.schema';
import { IdentityModule } from '../identity/identity.module';
import { EntitlementCatalogModule } from '../entitlement-catalog/entitlement-catalog.module';
import { EntraConnectorModule } from '../connectors/entra-connector/entra.module';
import { AdConnectorModule } from '../connectors/ad-connector/ad.module';
import { OktaConnectorModule } from '../connectors/okta-connector/okta.module';
import { ScimConnectorModule } from '../connectors/scim-connector/scim.module';
import { BlueprintsModule } from '../blueprints/blueprints.module';
import { PolicyModule } from '../policy/policy.module';
import { ScimToken, ScimTokenSchema } from '../scim-inbound/schemas/scim-token.schema';
import { AdminUser, AdminUserSchema } from '../auth/schemas/admin-user.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ReviewCampaign.name, schema: ReviewCampaignSchema },
      { name: ReviewItem.name, schema: ReviewItemSchema },
      { name: ScimToken.name, schema: ScimTokenSchema },
      { name: AdminUser.name, schema: AdminUserSchema },
    ]),
    ConfigModule.forFeature(accessReviewConfig),
    IdentityModule,
    EntitlementCatalogModule,
    EntraConnectorModule,
    // Review targets beyond Entra ID: gathering at activation and revocation at campaign close
    AdConnectorModule,
    OktaConnectorModule,
    ScimConnectorModule,
    BlueprintsModule, // ConfigActivities reads AD and SCIM connector configs from the canvas
    // Account items (targets without readable memberships): offboarding's per-target deprovision
    EntitlementExpiryActivitiesModule,
    // ReviewExclusionRecorder: a revoke at campaign close becomes an access review exclusion
    PolicyModule,
  ],
  controllers: [AccessReviewController],
  providers: [
    AccessReviewCampaignService,
    AccessReviewItemService,
    AccessReviewService,
    AccessReviewActivities,
    ReviewTargetAccessService,
    AccessReviewRevocationActivities,
    ReviewAccountRevocation,
    AccessReviewTimelineHandler,
    ConfigActivities,
  ],
  exports: [AccessReviewService, AccessReviewActivities, AccessReviewRevocationActivities],
})
export class AccessReviewModule implements OnModuleInit {
  constructor(
    private readonly metrics: MetricsService,
    private readonly items: AccessReviewItemService,
  ) {}

  /** euroid_access_review_campaigns_active counts the active campaigns at each scrape. */
  onModuleInit(): void {
    this.metrics.countAtScrape('euroid_access_review_campaigns_active', () =>
      this.items.countActiveCampaignsInAllTenants(),
    );
  }
}
