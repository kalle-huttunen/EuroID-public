/**
 * Risk Score Activities Module
 *
 * Provides Temporal activities for risk score batch calculation.
 */
import { Module } from '@nestjs/common';
import { RiskScoreActivities } from './risk-score.activities';
import { RiskScoringModule } from '../modules/risk-scoring/risk-scoring.module';
import { TenantModule } from '@infrastructure/multi-tenancy/tenant.module';

@Module({
  imports: [RiskScoringModule, TenantModule],
  providers: [RiskScoreActivities],
  exports: [RiskScoreActivities],
})
export class RiskScoreActivitiesModule {}
