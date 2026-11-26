/**
 * Reconciliation Module
 *
 * Module for reconciliation workflows, distributed transactions,
 * drift detection/correction, and connector health.
 */

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { ReconciliationService } from './reconciliation.service';
import { ReconciliationController } from './reconciliation.controller';
import { Drift, DriftSchema } from './schemas/drift.schema';
import { DriftService } from './drift.service';
import { DriftCorrectionService } from './drift-correction.service';
import { OrphanDetectionService } from './orphan-detection.service';
import { OrphanCleanupService } from './orphan-cleanup.service';
import { IdentityModule } from '../identity/identity.module';
import { EntraConnectorModule } from '../connectors/entra-connector/entra.module';
import { AdConnectorModule } from '../connectors/ad-connector/ad.module';
import { ScimConnectorModule } from '../connectors/scim-connector/scim.module';
import { ConnectorConfigModule } from '../connectors/connector-config.module';
import { TemporalModule } from '@infrastructure/temporal/temporal.module';
import { ConnectorActivitiesModule } from '../../activities/connector-activities.module';
import { orphanConfig } from '@infrastructure/config/orphan.config';
import { CorrelationConfigModule } from '../correlation-config/correlation-config.module';

@Module({
  imports: [
    ConfigModule.forFeature(orphanConfig),
    MongooseModule.forFeature([{ name: Drift.name, schema: DriftSchema }]),
    IdentityModule,
    EntraConnectorModule,
    AdConnectorModule,
    ScimConnectorModule,
    ConnectorConfigModule,
    TemporalModule,
    ConnectorActivitiesModule,
    CorrelationConfigModule,
  ],
  providers: [
    ReconciliationService,
    DriftService,
    DriftCorrectionService,
    OrphanDetectionService,
    OrphanCleanupService,
  ],
  controllers: [ReconciliationController],
  exports: [ReconciliationService, DriftService, OrphanDetectionService],
})
export class ReconciliationModule {}
