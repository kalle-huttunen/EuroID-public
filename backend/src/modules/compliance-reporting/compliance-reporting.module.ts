/**
 * Compliance Reporting Module
 *
 * Generates SOX and ISO 27001 compliance reports from audit, SoD,
 * access review, risk scoring, anomaly, and privileged access data.
 * Also hosts GDPR services: erasure, DSAR export, consent (Articles 6, 15, 17, 20).
 */

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { ComplianceReportingController } from './compliance-reporting.controller';
import { ComplianceReportingService } from './compliance-reporting.service';
import { GdprComplianceController } from './gdpr-compliance.controller';
import { GdprErasureService } from './gdpr-erasure.service';
import { GdprExternalStores } from './gdpr-erasure-external-stores';
import { DsarExportService } from './dsar-export.service';
import { ConsentService } from './consent.service';
import { ReportMetadata, ReportMetadataSchema } from './schemas/report-metadata.schema';
import { Consent, ConsentSchema } from './schemas/consent.schema';
import { SodPolicy, SodPolicySchema } from '../policy/schemas/sod-policy.schema';
import { IdentityRiskScore, RiskScoreSchema } from '../risk-scoring/schemas/risk-score.schema';
import { AuditEvent, AuditEventSchema } from '../audit/schemas/audit-event.schema';
import { Identity, IdentitySchema } from '../identity/schemas/identity.schema';
import { UserEvent, UserEventSchema } from '../identity/schemas/user-event.schema';
import {
  EntitlementCatalog,
  EntitlementCatalogSchema,
} from '../entitlement-catalog/schemas/entitlement-catalog.schema';
import { ReviewItem, ReviewItemSchema } from '../access-review/schemas/review-item.schema';
import {
  ReviewCampaign,
  ReviewCampaignSchema,
} from '../access-review/schemas/review-campaign.schema';
import { ReviewExclusion, ReviewExclusionSchema } from '../policy/schemas/review-exclusion.schema';
import { OutboxEvent, OutboxEventSchema } from '@infrastructure/events/schemas/outbox-event.schema';
import { AuditModule } from '../audit/audit.module';
import { AccessReviewModule } from '../access-review/access-review.module';
import { RiskScoringModule } from '../risk-scoring/risk-scoring.module';
import { AnomalyModule } from '../anomaly/anomaly.module';
import { PrivilegedAccessModule } from '../privileged-access/privileged-access.module';
import { NhiModule } from '../nhi/nhi.module';
import { IdentityModule } from '../identity/identity.module';
import { EntitlementCatalogModule } from '../entitlement-catalog/entitlement-catalog.module';
import { complianceConfig } from '@infrastructure/config/compliance.config';

@Module({
  imports: [
    ConfigModule.forFeature(complianceConfig),
    MongooseModule.forFeature([
      { name: ReportMetadata.name, schema: ReportMetadataSchema },
      { name: SodPolicy.name, schema: SodPolicySchema },
      { name: IdentityRiskScore.name, schema: RiskScoreSchema },
      { name: AuditEvent.name, schema: AuditEventSchema },
      { name: Identity.name, schema: IdentitySchema },
      { name: UserEvent.name, schema: UserEventSchema },
      { name: EntitlementCatalog.name, schema: EntitlementCatalogSchema },
      { name: ReviewItem.name, schema: ReviewItemSchema },
      { name: ReviewCampaign.name, schema: ReviewCampaignSchema },
      { name: ReviewExclusion.name, schema: ReviewExclusionSchema },
      { name: OutboxEvent.name, schema: OutboxEventSchema },
      { name: Consent.name, schema: ConsentSchema },
    ]),
    AuditModule,
    AccessReviewModule,
    RiskScoringModule,
    AnomalyModule,
    PrivilegedAccessModule,
    NhiModule, // NhiOwnershipService: the erased owner's agents become ownerless, audited
    IdentityModule,
    EntitlementCatalogModule,
  ],
  controllers: [ComplianceReportingController, GdprComplianceController],
  providers: [
    ComplianceReportingService,
    GdprErasureService,
    GdprExternalStores,
    DsarExportService,
    ConsentService,
  ],
  exports: [ComplianceReportingService, GdprErasureService, DsarExportService, ConsentService],
})
export class ComplianceReportingModule {}
