/**
 * Orphan Activities Module
 *
 * Provides Temporal activities for orphan cleanup workflow.
 */
import { Module } from '@nestjs/common';
import { OrphanActivities } from './orphan.activities';
import { ReconciliationModule } from '../modules/reconciliation/reconciliation.module';
import { IdentityModule } from '../modules/identity/identity.module';
import { ConnectorActivitiesModule } from './connector-activities.module';
import { AdConnectorModule } from '../modules/connectors/ad-connector/ad.module';
import { ScimConnectorModule } from '../modules/connectors/scim-connector/scim.module';
import { ConnectorConfigModule } from '../modules/connectors/connector-config.module';

@Module({
  imports: [
    ReconciliationModule,
    IdentityModule,
    ConnectorActivitiesModule,
    AdConnectorModule,
    ScimConnectorModule,
    ConnectorConfigModule,
  ],
  providers: [OrphanActivities],
  exports: [OrphanActivities],
})
export class OrphanActivitiesModule {}
