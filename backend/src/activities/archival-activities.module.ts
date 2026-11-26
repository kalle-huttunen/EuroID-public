/**
 * Archival Activities Module
 *
 * Provides Temporal activities for cold storage archival.
 */
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ArchivalActivities } from './archival.activities';
import { AuditEvent, AuditEventSchema } from '../modules/audit/schemas/audit-event.schema';
import { UserEvent, UserEventSchema } from '../modules/identity/schemas/user-event.schema';
import {
  ArchivalRecord,
  ArchivalRecordSchema,
} from '@infrastructure/retention/schemas/archival-record.schema';
import { createStorageAdapter } from '@infrastructure/retention/storage/storage.factory';
import { TenantModule } from '@infrastructure/multi-tenancy/tenant.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: AuditEvent.name, schema: AuditEventSchema },
      { name: UserEvent.name, schema: UserEventSchema },
      { name: ArchivalRecord.name, schema: ArchivalRecordSchema },
    ]),
    TenantModule, // TenantService: archival runs per tenant
  ],
  providers: [
    {
      provide: 'STORAGE_ADAPTER',
      useFactory: createStorageAdapter,
    },
    ArchivalActivities,
  ],
  exports: [ArchivalActivities],
})
export class ArchivalActivitiesModule {}

// --- Task 108 recap: Nest module for archival. Registers AuditEvent, UserEvent, ArchivalRecord + storage.
