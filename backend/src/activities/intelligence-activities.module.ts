/**
 * Intelligence Activities Module
 *
 * Provides Temporal activities for nightly intelligence batch.
 */
import { Module } from '@nestjs/common';
import { IntelligenceActivities } from './intelligence.activities';
import { IntelligenceModule } from '../modules/intelligence/intelligence.module';
import { TenantModule } from '@infrastructure/multi-tenancy/tenant.module';

@Module({
  imports: [IntelligenceModule, TenantModule],
  providers: [IntelligenceActivities],
  exports: [IntelligenceActivities],
})
export class IntelligenceActivitiesModule {}
