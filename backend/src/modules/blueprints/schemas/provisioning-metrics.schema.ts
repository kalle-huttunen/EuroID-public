/**
 * Provisioning Metrics Schema
 *
 * Tracks provisioning outcomes per tenant for circuit breaker logic.
 * Rolling window: last 1 hour of attempts.
 */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

@Schema({ timestamps: true })
export class ProvisioningMetrics extends Document {
  @Prop({ required: true, index: true })
  tenantId!: string;

  @Prop({ required: true, default: () => new Date() })
  windowStart!: Date;

  @Prop({ default: 0 })
  totalAttempts!: number;

  @Prop({ default: 0 })
  successCount!: number;

  @Prop({ default: 0 })
  failureCount!: number;

  @Prop({ default: 0 })
  errorRate!: number;
}

export const ProvisioningMetricsSchema = SchemaFactory.createForClass(ProvisioningMetrics);

// TTL index: expire documents after 2 hours (rolling window is 1 hour, keep buffer)
ProvisioningMetricsSchema.index({ windowStart: 1 }, { expireAfterSeconds: 7200 });
