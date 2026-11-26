/**
 * Recertification Activities Module
 *
 * Provides Temporal activities for recurring access review campaigns.
 * Runs daily via Schedule, clones completed recurring campaigns and activates them.
 */
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { RecertificationActivities } from './recertification.activities';
import { AccessReviewModule } from '../modules/access-review/access-review.module';
import {
  ReviewCampaign,
  ReviewCampaignSchema,
} from '../modules/access-review/schemas/review-campaign.schema';
import { TenantModule } from '@infrastructure/multi-tenancy/tenant.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ReviewCampaign.name, schema: ReviewCampaignSchema },
    ]),
    AccessReviewModule,
    TenantModule,
  ],
  providers: [RecertificationActivities],
  exports: [RecertificationActivities],
})
export class RecertificationActivitiesModule {}
