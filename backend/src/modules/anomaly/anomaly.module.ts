/**
 * Anomaly Detection Module
 *
 * Access anomaly detection using rule-based heuristics.
 * Uses audit logs, user events, policy engine, and entitlement catalog.
 */

import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ConfigModule } from '@nestjs/config';
import { anomalyConfig } from '@infrastructure/config/anomaly.config';
import { AnomalyController } from './anomaly.controller';
import { AccessAnomalyService } from './anomaly.service';
import { Anomaly, AnomalySchema } from './schemas/anomaly.schema';
import { RiskScore, RiskScoreSchema } from './schemas/risk-score.schema';
import { IdentityModule } from '../identity/identity.module';
import { PolicyModule } from '../policy/policy.module';
import { EntitlementCatalogModule } from '../entitlement-catalog/entitlement-catalog.module';
import { EntraConnectorModule } from '../connectors/entra-connector/entra.module';
import { AnomalyEventHandler } from './anomaly-event.handler';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Anomaly.name, schema: AnomalySchema },
      { name: RiskScore.name, schema: RiskScoreSchema },
    ]),
    ConfigModule.forFeature(anomalyConfig),
    IdentityModule,
    PolicyModule,
    EntitlementCatalogModule,
    EntraConnectorModule,
  ],
  controllers: [AnomalyController],
  providers: [AccessAnomalyService, AnomalyEventHandler],
  exports: [AccessAnomalyService],
})
export class AnomalyModule {}
