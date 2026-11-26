/**
 * Access Request Activities Module
 *
 * Provides Temporal activities for the access request approval workflow.
 */
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  AccessRequest,
  AccessRequestSchema,
} from '../modules/access-requests/schemas/access-request.schema';
import { AccessRequestActivities } from './access-request.activities';
import { EntitlementCatalogModule } from '../modules/entitlement-catalog/entitlement-catalog.module';
import { IdentityModule } from '../modules/identity/identity.module';
import { ConnectorActivitiesModule } from './connector-activities.module';
import { NotificationsModule } from '../modules/notifications/notifications.module';
import { AccessRequestsModule } from '../modules/access-requests/access-requests.module';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: AccessRequest.name, schema: AccessRequestSchema }]),
    EntitlementCatalogModule,
    IdentityModule,
    ConnectorActivitiesModule,
    NotificationsModule, // notifyApprover: approver email
    AccessRequestsModule, // recheckSodBeforeProvisioning: AccessRequestSodService
  ],
  providers: [AccessRequestActivities],
  exports: [AccessRequestActivities],
})
export class AccessRequestActivitiesModule {}
