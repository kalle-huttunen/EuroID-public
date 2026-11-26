/**
 * Intelligence Module
 *
 * AI access intelligence: rubber-stamp detection, peer group modeling,
 * and smart access request recommendations.
 */

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { intelligenceConfig } from '@infrastructure/config/intelligence.config';
import { IntelligenceService } from './intelligence.service';
import { HeldAccessService } from './held-access.service';
import { IntelligenceController } from './intelligence.controller';
import {
  ReviewerQualityScore,
  ReviewerQualityScoreSchema,
} from './schemas/reviewer-quality-score.schema';
import { PeerGroup, PeerGroupSchema } from './schemas/peer-group.schema';
import { ReviewItem, ReviewItemSchema } from '../access-review/schemas/review-item.schema';
import {
  ReviewCampaign,
  ReviewCampaignSchema,
} from '../access-review/schemas/review-campaign.schema';
import { Identity, IdentitySchema } from '../identity/schemas/identity.schema';
import {
  EntitlementCatalog,
  EntitlementCatalogSchema,
} from '../entitlement-catalog/schemas/entitlement-catalog.schema';
import {
  AccessRequest,
  AccessRequestSchema,
} from '../access-requests/schemas/access-request.schema';
import { IdentityModule } from '../identity/identity.module';
import { PolicyModule } from '../policy/policy.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ReviewerQualityScore.name, schema: ReviewerQualityScoreSchema },
      { name: PeerGroup.name, schema: PeerGroupSchema },
      { name: ReviewItem.name, schema: ReviewItemSchema },
      { name: ReviewCampaign.name, schema: ReviewCampaignSchema },
      { name: Identity.name, schema: IdentitySchema },
      { name: EntitlementCatalog.name, schema: EntitlementCatalogSchema },
      { name: AccessRequest.name, schema: AccessRequestSchema },
    ]),
    ConfigModule.forFeature(intelligenceConfig),
    IdentityModule,
    PolicyModule,
  ],
  controllers: [IntelligenceController],
  providers: [IntelligenceService, HeldAccessService],
  exports: [IntelligenceService],
})
export class IntelligenceModule {}
