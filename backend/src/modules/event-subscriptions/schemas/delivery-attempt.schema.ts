/**
 * Delivery Attempt Schema
 *
 * Records each webhook delivery attempt for observability and retry tracking.
 * Auto-deleted after 30 days via TTL index.
 */

import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';

export type DeliveryStatus = 'PENDING' | 'DELIVERED' | 'FAILED';

@Schema({ timestamps: true, collection: 'webhook_delivery_attempts' })
export class DeliveryAttempt {
  @Prop({ required: true, index: true })
  tenantId!: string;

  @Prop({ required: true, type: String, index: true })
  subscriptionId!: string;

  @Prop({ required: true })
  eventType!: string;

  @Prop({ required: true })
  eventId!: string;

  /**
   * The JSON body to deliver (ids only, see webhook-payload.ts buildWebhookBody), kept so a retry
   * re-sends what the first attempt sent. Absent on attempts recorded before 2.0cu.
   */
  @Prop({ type: MongooseSchema.Types.Mixed })
  body?: Record<string, unknown>;

  @Prop({ required: true, type: String, default: 'PENDING' })
  status!: DeliveryStatus;

  @Prop({ type: Number })
  httpStatus?: number;

  @Prop({ required: true, type: Number, default: 0 })
  attempts!: number;

  /**
   * FAILED: when the retry poller sends it again (absent once the attempts ran out). PENDING: the
   * end of the sending process's lease; after it the poller takes the delivery over (2.0dl).
   */
  @Prop({ type: Date })
  nextRetryAt?: Date;

  @Prop({ type: String })
  lastError?: string;
}

export type DeliveryAttemptDocument = HydratedDocument<DeliveryAttempt>;
export const DeliveryAttemptSchema = SchemaFactory.createForClass(DeliveryAttempt);

// ── Indexes ──────────────────────────────────────────────────────────
DeliveryAttemptSchema.index({ subscriptionId: 1, createdAt: -1 });
// One delivery per subscription and event: inserting the attempt is the claim (deliverWebhook), so
// a redelivered event, or one two processes handle at once, is sent once. Migration
// 20261125000002 replaced the non-unique index of the same name.
DeliveryAttemptSchema.index({ subscriptionId: 1, eventId: 1 }, { unique: true });
DeliveryAttemptSchema.index({ status: 1, nextRetryAt: 1 });
// The retry poller's claim: the due deliveries of each active subscription, oldest due first.
DeliveryAttemptSchema.index({ subscriptionId: 1, status: 1, nextRetryAt: 1 });
// TTL: auto-delete after 30 days
DeliveryAttemptSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });
