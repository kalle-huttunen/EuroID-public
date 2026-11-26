/**
 * Identity Activities Module
 *
 * Provides Temporal activities for Hub operations (save, lookup, HR fetch, offboarding result).
 */
import { Module } from '@nestjs/common';
import { IdentityActivities } from './identity.activities';
import { HrActivities } from './hr.activities';
import { OffboardingActivities } from './offboarding.activities';
import { IdentityModule } from '../modules/identity/identity.module';

@Module({
  imports: [IdentityModule],
  providers: [IdentityActivities, HrActivities, OffboardingActivities],
  exports: [IdentityActivities, HrActivities, OffboardingActivities],
})
export class IdentityActivitiesModule {}
