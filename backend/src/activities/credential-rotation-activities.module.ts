/**
 * Credential Rotation Activities Module
 *
 * Provides the Temporal activity of the nightly credential rotation CronWorkflow and the inventory
 * refresh it runs first (reads Entra ID and AD credential state through CredentialActivities).
 */
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CredentialRotationActivities } from './credential-rotation.activities';
import { CredentialInventoryRefresh } from './credential-inventory-refresh';
import { CredentialActivitiesModule } from './credential-activities.module';
import { CredentialLifecycleModule } from '../modules/credential-lifecycle/credential-lifecycle.module';
import { EntraConnectorModule } from '../modules/connectors/entra-connector/entra.module';
import { EventsModule } from '../infrastructure/events/events.module';
import { BlueprintsModule } from '../modules/blueprints/blueprints.module';
import { TenantModule } from '@infrastructure/multi-tenancy/tenant.module';
import { Identity, IdentitySchema } from '../modules/identity/schemas/identity.schema';
import { ConfigActivities } from './config.activities';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Identity.name, schema: IdentitySchema }]),
    CredentialLifecycleModule,
    CredentialActivitiesModule, // CredentialActivities: the Entra ID and AD credential reads
    EntraConnectorModule, // EntraService.isConfiguredForTenant
    EventsModule,
    BlueprintsModule, // ConfigActivities needs BlueprintsService (the AD config)
    TenantModule, // TenantService: the schedule's run covers every active tenant
  ],
  providers: [CredentialRotationActivities, CredentialInventoryRefresh, ConfigActivities],
  exports: [CredentialRotationActivities],
})
export class CredentialRotationActivitiesModule {}
