/**
 * Mover Activities Module
 *
 * Provides Temporal activities for the Mover workflow (role/department change, re-evaluation):
 * MoverActivities on the default queue, MoverAccessActivities (applyMoverAccess) on the Entra ID,
 * AD, Okta and SCIM queues (worker.ts registers it there).
 */
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { MoverActivities } from './mover.activities';
import { MoverAccessActivities } from './mover-access.activities';
import { ConfigActivities } from './config.activities';
import { ConnectorActivitiesModule } from './connector-activities.module';
import { MoverTargetAccessService } from '../modules/mover/mover-target-access.service';
import { EventsModule } from '../infrastructure/events/events.module';
import { IdentityModule } from '../modules/identity/identity.module';
import { PolicyModule } from '../modules/policy/policy.module';
import { BlueprintsModule } from '../modules/blueprints/blueprints.module';
import { AdConnectorModule } from '../modules/connectors/ad-connector/ad.module';
import { OktaConnectorModule } from '../modules/connectors/okta-connector/okta.module';
import { ScimConnectorModule } from '../modules/connectors/scim-connector/scim.module';
import {
  AccessRequest,
  AccessRequestSchema,
} from '../modules/access-requests/schemas/access-request.schema';

@Module({
  imports: [
    EventsModule,
    IdentityModule,
    PolicyModule, // PolicyActivities.evaluateUser for evaluateMoverChange
    ConnectorActivitiesModule, // EntraActivities.provisionUserToEntra for the Entra ID change
    AdConnectorModule,
    OktaConnectorModule,
    ScimConnectorModule,
    BlueprintsModule, // ConfigActivities reads the Entra ID, AD and SCIM configs from the canvas
    // Read only: evaluateMoverChange keeps what an active access request grants
    MongooseModule.forFeature([{ name: AccessRequest.name, schema: AccessRequestSchema }]),
  ],
  providers: [MoverActivities, MoverAccessActivities, MoverTargetAccessService, ConfigActivities],
  exports: [MoverActivities, MoverAccessActivities],
})
export class MoverActivitiesModule {}
