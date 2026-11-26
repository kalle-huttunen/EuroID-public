/**
 * Reconciliation Activities Module
 *
 * Provides Temporal activities for drift detection and correction.
 */
import { Module } from '@nestjs/common';
import { ReconciliationActivities } from './reconciliation.activities';
import { IdentityModule } from '../modules/identity/identity.module';
import { ConnectorActivitiesModule } from './connector-activities.module';
import { ReconciliationModule } from '../modules/reconciliation/reconciliation.module';
import { EntraConnectorModule } from '../modules/connectors/entra-connector/entra.module';
import { AdConnectorModule } from '../modules/connectors/ad-connector/ad.module';
import { ScimConnectorModule } from '../modules/connectors/scim-connector/scim.module';
import { ConnectorConfigModule } from '../modules/connectors/connector-config.module';
import { NotificationsModule } from '../modules/notifications/notifications.module';

@Module({
  imports: [
    IdentityModule,
    ConnectorActivitiesModule,
    ReconciliationModule,
    ConnectorConfigModule, // ConnectorConfigService for getConfig('ad'|'scim')
    EntraConnectorModule, // EntraService for fetchEntraUsers, fetchUserFromSystem
    AdConnectorModule, // AdService for listUsers, getUserByEmail
    ScimConnectorModule, // SCIMService for listUsers, getUserByEmail
    NotificationsModule, // EmailNotificationService for notifyDriftThresholdExceeded
  ],
  providers: [ReconciliationActivities],
  exports: [ReconciliationActivities],
})
export class ReconciliationActivitiesModule {}
