/**
 * Connector Config Module
 *
 * Manages connector installation state and configuration persistence.
 * This is the top-level "Connector Marketplace" backend module.
 */

import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ConnectorConfigController } from './connector-config.controller';
import { ConnectorConfigService } from './connector-config.service';
import { SyncSchedulerService } from './sync-scheduler.service';
import { ConnectorConfig, ConnectorConfigSchema } from './schemas/connector-config.schema';
import { HrIngestionService } from './hr-ingestion.service';
import { ScheduledSyncActivities } from '../../activities/scheduled-sync.activities';
import { CsvHrConnectorModule } from './csv-hr-connector/csv-hr.module';
import { JsonApiHrConnectorModule } from './json-api-hr-connector/json-api-hr.module';
import { FileOutboundConnectorModule } from './file-outbound-connector/file-outbound.module';
import { DiscordWebhookConnectorModule } from './discord-webhook-connector/discord-webhook.module';
import { GitHubConnectorModule } from './github-connector/github.module';
import { GoogleSheetsConnectorModule } from './google-sheets-connector/google-sheets.module';
import { OktaConnectorModule } from './okta-connector/okta.module';
import { ServiceNowConnectorModule } from './servicenow-connector/servicenow.module';
import { CorrelationConfigModule } from '../correlation-config/correlation-config.module';
import { IdentityModule } from '../identity/identity.module';
import { ConnectorActivitiesModule } from '../../activities/connector-activities.module';
import { ConnectorConfigRegistryProvider } from './connector-config-registry.provider';
import { BlueprintsModule } from '../blueprints/blueprints.module';
import { ConnectorHealthService } from './connector-health.service';
import { buildConnectorHealthChecks, CONNECTOR_HEALTH_CHECKS } from './connector-health-checks';
import { EntraActivities } from '../../activities/entra.activities';
import { AdActivities } from '../../activities/ad.activities';
import { ScimActivities } from '../../activities/scim.activities';
import { OktaService } from './okta-connector/okta.service';
import { ServiceNowService } from './servicenow-connector/servicenow.service';
import { GitHubService } from './github-connector/github.service';
import { GoogleSheetsService } from './google-sheets-connector/google-sheets.service';
import { DiscordWebhookService } from './discord-webhook-connector/discord-webhook.service';
import { FileOutboundService } from './file-outbound-connector/file-outbound.service';
import { CsvHrService } from './csv-hr-connector/csv-hr.service';
import { JsonApiHrService } from './json-api-hr-connector/json-api-hr.service';

/** Each connector's health check by id (connector-health-checks.ts), for ConnectorHealthService. */
const connectorHealthChecksProvider = {
  provide: CONNECTOR_HEALTH_CHECKS,
  useFactory: (
    entra: EntraActivities,
    ad: AdActivities,
    scim: ScimActivities,
    okta: OktaService,
    serviceNow: ServiceNowService,
    gitHub: GitHubService,
    googleSheets: GoogleSheetsService,
    discordWebhook: DiscordWebhookService,
    fileOutbound: FileOutboundService,
    csvHr: CsvHrService,
    jsonApiHr: JsonApiHrService,
  ) =>
    buildConnectorHealthChecks({
      entra,
      ad,
      scim,
      okta,
      serviceNow,
      gitHub,
      googleSheets,
      discordWebhook,
      fileOutbound,
      csvHr,
      jsonApiHr,
    }),
  inject: [
    EntraActivities,
    AdActivities,
    ScimActivities,
    OktaService,
    ServiceNowService,
    GitHubService,
    GoogleSheetsService,
    DiscordWebhookService,
    FileOutboundService,
    CsvHrService,
    JsonApiHrService,
  ],
};

@Module({
  imports: [
    CorrelationConfigModule,
    MongooseModule.forFeature([{ name: ConnectorConfig.name, schema: ConnectorConfigSchema }]),
    forwardRef(() => ConnectorActivitiesModule), // SyncSchedulerService needs EntraActivities, AdActivities; forwardRef breaks cycle via Ad->Events->Identity->ConnectorConfig
    CsvHrConnectorModule,
    JsonApiHrConnectorModule,
    forwardRef(() => FileOutboundConnectorModule),
    forwardRef(() => DiscordWebhookConnectorModule),
    forwardRef(() => GitHubConnectorModule),
    forwardRef(() => GoogleSheetsConnectorModule),
    forwardRef(() => OktaConnectorModule),
    forwardRef(() => ServiceNowConnectorModule),
    IdentityModule,
    forwardRef(() => BlueprintsModule),
  ],
  controllers: [ConnectorConfigController],
  providers: [
    ConnectorConfigService,
    HrIngestionService,
    SyncSchedulerService,
    ScheduledSyncActivities,
    ConnectorConfigRegistryProvider,
    connectorHealthChecksProvider,
    ConnectorHealthService,
  ],
  exports: [
    ConnectorConfigService,
    HrIngestionService,
    ScheduledSyncActivities,
    ConnectorHealthService,
  ],
})
export class ConnectorConfigModule {}
