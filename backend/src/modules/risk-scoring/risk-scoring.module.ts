/**
 * Risk Scoring Module
 *
 * Computes composite risk score (0-100) per identity.
 * Used by Temporal CronWorkflow for nightly batch calculation.
 */
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { riskScoringConfig } from '@infrastructure/config/risk-scoring.config';
import { RiskScoringService } from './risk-scoring.service';
import { RiskScoringController } from './risk-scoring.controller';
import { IdentityRiskScore, RiskScoreSchema } from './schemas/risk-score.schema';
import { IdentityModule } from '../identity/identity.module';
import { PolicyModule } from '../policy/policy.module';
import { AuditModule } from '../audit/audit.module';
import { Anomaly, AnomalySchema } from '../anomaly/schemas/anomaly.schema';
import {
  EntitlementCatalog,
  EntitlementCatalogSchema,
} from '../entitlement-catalog/schemas/entitlement-catalog.schema';
import { Identity, IdentitySchema } from '../identity/schemas/identity.schema';
import { IntelligenceModule } from '../intelligence/intelligence.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: IdentityRiskScore.name, schema: RiskScoreSchema },
      { name: Anomaly.name, schema: AnomalySchema },
      { name: EntitlementCatalog.name, schema: EntitlementCatalogSchema },
      { name: Identity.name, schema: IdentitySchema },
    ]),
    ConfigModule.forFeature(riskScoringConfig),
    IdentityModule,
    PolicyModule,
    AuditModule,
    IntelligenceModule,
  ],
  controllers: [RiskScoringController],
  providers: [RiskScoringService],
  exports: [RiskScoringService],
})
export class RiskScoringModule {}
