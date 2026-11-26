/**
 * Writeback Activities Module
 *
 * Provides Temporal activities for attribute writeback from target systems to the Hub.
 */
import { Module } from '@nestjs/common';
import { WritebackActivities } from './writeback.activities';
import { IdentityModule } from '../modules/identity/identity.module';
import { ConnectorConfigModule } from '../modules/connectors/connector-config.module';
import { BlueprintsModule } from '../modules/blueprints/blueprints.module';

@Module({
  imports: [IdentityModule, ConnectorConfigModule, BlueprintsModule],
  providers: [WritebackActivities],
  exports: [WritebackActivities],
})
export class WritebackActivitiesModule {}
