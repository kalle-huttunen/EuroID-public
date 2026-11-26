/**
 * Audit Archive Activities Module
 *
 * Provides Temporal activities for S3 Object Lock export.
 */
import { Module } from '@nestjs/common';
import { AuditArchiveActivities } from './audit-archive.activities';
import { AuditModule } from '../modules/audit/audit.module';
import { TenantModule } from '../infrastructure/multi-tenancy/tenant.module';

@Module({
  imports: [AuditModule, TenantModule],
  providers: [AuditArchiveActivities],
  exports: [AuditArchiveActivities],
})
export class AuditArchiveActivitiesModule {}
