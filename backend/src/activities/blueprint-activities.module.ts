/**
 * Blueprint Activities Module
 *
 * Provides Temporal activities for pipeline status and circuit breaker recording.
 */
import { Module } from '@nestjs/common';
import { PipelineActivities } from './pipeline.activities';
import { BlueprintsModule } from '../modules/blueprints/blueprints.module';

@Module({
  imports: [BlueprintsModule],
  providers: [PipelineActivities],
  exports: [PipelineActivities],
})
export class BlueprintActivitiesModule {}
