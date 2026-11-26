/**
 * Predictive Analytics Module
 *
 * Offboarding blast radius pre-computation, license consumption forecasting,
 * and seasonal onboarding pattern detection.
 */

import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ConfigModule } from '@nestjs/config';
import {
  UpcomingOffboarding,
  UpcomingOffboardingSchema,
} from './schemas/upcoming-offboarding.schema';
import {
  EntitlementCatalog,
  EntitlementCatalogSchema,
} from '../entitlement-catalog/schemas/entitlement-catalog.schema';
import { AuditEvent, AuditEventSchema } from '../audit/schemas/audit-event.schema';
import { Identity, IdentitySchema } from '../identity/schemas/identity.schema';
import { AnalyticsController } from './analytics.controller';
import { PredictiveAnalyticsService } from './analytics.service';
import { AnalyticsEventHandler } from './analytics-event.handler';
import { AnalyticsIndexerService } from './analytics-indexer.service';
import { AnalyticsSearchService } from './analytics-search.service';
import { IdentityModule } from '../identity/identity.module';
import { PolicyModule } from '../policy/policy.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: UpcomingOffboarding.name, schema: UpcomingOffboardingSchema },
      { name: EntitlementCatalog.name, schema: EntitlementCatalogSchema },
      { name: AuditEvent.name, schema: AuditEventSchema },
      { name: Identity.name, schema: IdentitySchema },
    ]),
    ConfigModule,
    IdentityModule,
    PolicyModule,
  ],
  controllers: [AnalyticsController],
  providers: [
    PredictiveAnalyticsService,
    AnalyticsEventHandler,
    AnalyticsIndexerService,
    AnalyticsSearchService,
  ],
  exports: [PredictiveAnalyticsService, AnalyticsSearchService],
})
export class AnalyticsModule {}
