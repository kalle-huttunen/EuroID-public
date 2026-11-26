/**
 * Entitlement Expiry Activities Module
 *
 * Provides Temporal activities for time-bound access expiry.
 * Finds expired provisioning entries, deprovisions them through offboarding's per-target
 * deprovision activities (ConnectorActivitiesModule), emits events.
 * EntitlementExpiryTimelineHandler puts their outcome on the identity timeline.
 */
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { EntitlementExpiryActivities } from './entitlement-expiry.activities';
import { EntitlementExpiryDeprovision } from './entitlement-expiry-deprovision';
import { ConnectorActivitiesModule } from './connector-activities.module';
import { IdentityModule } from '../modules/identity/identity.module';
import { Identity, IdentitySchema } from '../modules/identity/schemas/identity.schema';
import { BlueprintsModule } from '../modules/blueprints/blueprints.module';
import { TenantModule } from '@infrastructure/multi-tenancy/tenant.module';
import { PrivilegedAccessModule } from '../modules/privileged-access/privileged-access.module';
import { OktaConnectorModule } from '../modules/connectors/okta-connector/okta.module';
import { EntitlementExpiryTimelineHandler } from '../infrastructure/events/handlers/entitlement-expiry-timeline.handler';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Identity.name, schema: IdentitySchema }]),
    IdentityModule,
    BlueprintsModule, // the Entra ID, AD and SCIM configs on the canvas
    ConnectorActivitiesModule, // the Entra, AD, SCIM, Okta, GitHub and ServiceNow deprovision
    TenantModule,
    PrivilegedAccessModule,
    OktaConnectorModule, // the PAM sweep reads an Okta admin account's status before a run
  ],
  providers: [
    EntitlementExpiryActivities,
    EntitlementExpiryDeprovision,
    EntitlementExpiryTimelineHandler,
  ],
  // EntitlementExpiryDeprovision: also an access review's account revocation (AccessReviewModule)
  exports: [EntitlementExpiryActivities, EntitlementExpiryDeprovision],
})
export class EntitlementExpiryActivitiesModule {}
