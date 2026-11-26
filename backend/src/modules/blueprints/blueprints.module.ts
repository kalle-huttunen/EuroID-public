/**
 * BlueprintsModule
 *
 * Manages workflow blueprint creation, configuration, and validation.
 * Provides endpoints for creating, retrieving, and validating workflow blueprints
 * composed of nodes (connectors and controls) with configurable parameters.
 */
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { authConfig } from '@infrastructure/config/auth.config';
import { BlueprintsController } from './blueprints.controller';
import { BlueprintsService } from './blueprints.service';
import { ImpactAnalysisService } from './impact-analysis.service';
import { ImpactEntraMetadataService } from './impact-entra-metadata.service';
import { PipelineService } from './pipeline.service';
import { CircuitBreakerService } from './circuit-breaker.service';
import {
  BlueprintNode,
  BlueprintSchema,
  CanvasBlueprint,
  CanvasBlueprintSchema,
} from './schemas/blueprint.schema';
import {
  ProvisioningMetrics,
  ProvisioningMetricsSchema,
} from './schemas/provisioning-metrics.schema';
import { ConnectorActivitiesModule } from '../../activities/connector-activities.module';
import { EntraConnectorModule } from '../connectors/entra-connector/entra.module';
import { CorrelationConfigModule } from '../correlation-config/correlation-config.module';
import { IdentityModule } from '../identity/identity.module';
import { PolicyModule } from '../policy/policy.module';
import { BlueprintsRegistryProvider } from './blueprints-registry.provider';
import { RealTimeModule } from '@infrastructure/realtime/realtime.module';
import {
  EntitlementCatalog,
  EntitlementCatalogSchema,
} from '../entitlement-catalog/schemas/entitlement-catalog.schema';

@Module({
  imports: [
    ConfigModule.forFeature(authConfig),
    CorrelationConfigModule,
    MongooseModule.forFeature([
      { name: BlueprintNode.name, schema: BlueprintSchema },
      { name: CanvasBlueprint.name, schema: CanvasBlueprintSchema },
      { name: ProvisioningMetrics.name, schema: ProvisioningMetricsSchema },
      // ImpactEntraMetadataService names the intent's groups and licenses from the catalog
      { name: EntitlementCatalog.name, schema: EntitlementCatalogSchema },
    ]),
    ConnectorActivitiesModule, // PipelineService needs EntraActivities, AdActivities
    EntraConnectorModule, // Provides EntraService to controller and ImpactAnalysisService
    IdentityModule,
    PolicyModule,
    RealTimeModule, // EventsGateway for circuit breaker alerts
  ],
  controllers: [BlueprintsController],
  providers: [
    BlueprintsService,
    ImpactAnalysisService,
    ImpactEntraMetadataService,
    PipelineService,
    CircuitBreakerService,
    BlueprintsRegistryProvider,
  ],
  exports: [BlueprintsService, PipelineService, CircuitBreakerService],
})
export class BlueprintsModule {}
