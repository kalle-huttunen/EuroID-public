import { Module } from '@nestjs/common';
import { LoggerModule } from './logger.module';
import { MetricsModule } from './metrics.module';

@Module({
  imports: [LoggerModule, MetricsModule],
  exports: [LoggerModule, MetricsModule],
})
export class ObservabilityModule {}
