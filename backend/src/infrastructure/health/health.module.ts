/**
 * Health Module
 *
 * Provides /health (liveness) and /health/ready (readiness) endpoints.
 * Both are @Public() — no auth required for load balancers and K8s probes.
 */

import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import {
  ConnectorConfig,
  ConnectorConfigSchema,
} from '../../modules/connectors/schemas/connector-config.schema';

@Module({
  // The connector configs' sync states only (HealthService counts them); TenantService comes
  // from the global TenantModule.
  imports: [
    MongooseModule.forFeature([{ name: ConnectorConfig.name, schema: ConnectorConfigSchema }]),
  ],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
