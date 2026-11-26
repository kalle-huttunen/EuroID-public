/**
 * Connector Activities Module
 *
 * Provides Temporal activities for connector operations (Entra, AD, SCIM, Okta, GitHub,
 * ServiceNow, and the no-account targets Discord webhook, Google Sheets and File outbound).
 * Sits close to connector domains; no forwardRef needed.
 */
import { Module } from '@nestjs/common';
import { EntraActivities } from './entra.activities';
import { AdActivities } from './ad.activities';
import { ScimActivities } from './scim.activities';
import { OktaActivities } from './okta.activities';
import { GitHubActivities } from './github.activities';
import { ServiceNowActivities } from './servicenow.activities';
import { NoAccountTargetActivities } from './no-account-target.activities';
import { EntraEntitlementChanges } from './entra-entitlement-changes';
import { EntraConnectorModule } from '../modules/connectors/entra-connector/entra.module';
import { AdConnectorModule } from '../modules/connectors/ad-connector/ad.module';
import { ScimConnectorModule } from '../modules/connectors/scim-connector/scim.module';
import { OktaConnectorModule } from '../modules/connectors/okta-connector/okta.module';
import { GitHubConnectorModule } from '../modules/connectors/github-connector/github.module';
import { ServiceNowConnectorModule } from '../modules/connectors/servicenow-connector/servicenow.module';
import { DiscordWebhookConnectorModule } from '../modules/connectors/discord-webhook-connector/discord-webhook.module';
import { GoogleSheetsConnectorModule } from '../modules/connectors/google-sheets-connector/google-sheets.module';
import { FileOutboundConnectorModule } from '../modules/connectors/file-outbound-connector/file-outbound.module';
import { EventsModule } from '../infrastructure/events/events.module';
import { EntitlementCatalogModule } from '../modules/entitlement-catalog/entitlement-catalog.module';
import { IdentityModule } from '../modules/identity/identity.module';

@Module({
  imports: [
    EntraConnectorModule,
    AdConnectorModule,
    ScimConnectorModule,
    OktaConnectorModule,
    GitHubConnectorModule,
    ServiceNowConnectorModule,
    DiscordWebhookConnectorModule,
    GoogleSheetsConnectorModule,
    FileOutboundConnectorModule,
    EventsModule,
    EntitlementCatalogModule,
    IdentityModule, // SCIM and GitHub offboarding read the identity's lookup identifiers
  ],
  providers: [
    EntraActivities,
    AdActivities,
    ScimActivities,
    OktaActivities,
    GitHubActivities,
    ServiceNowActivities,
    NoAccountTargetActivities,
    EntraEntitlementChanges, // access request fulfilment and expiry: entitlements only
  ],
  exports: [
    EntraActivities,
    AdActivities,
    ScimActivities,
    OktaActivities,
    GitHubActivities,
    ServiceNowActivities,
    NoAccountTargetActivities,
    EntraEntitlementChanges,
  ],
})
export class ConnectorActivitiesModule {}
