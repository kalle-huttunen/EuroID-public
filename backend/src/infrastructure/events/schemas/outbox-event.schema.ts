import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { DomainEventType } from '../event-types';

export type OutboxEventStatus = 'pending' | 'processing' | 'published' | 'failed';

/**
 * Outbox event document for transactional at-least-once delivery.
 * Events are inserted in the same MongoDB transaction as the entity update,
 * then published by the outbox poller.
 */
@Schema({ collection: 'event_outbox', timestamps: true })
export class OutboxEvent {
  @Prop({ required: true })
  eventId!: string;

  @Prop({ type: String, required: true })
  type!: DomainEventType;

  @Prop({ required: true })
  aggregateId!: string;

  @Prop({ type: Object, required: true })
  payload!: Record<string, unknown>;

  @Prop({ type: Object, required: true })
  metadata!: {
    correlationId: string;
    causedBy?: string;
    depth: number;
    emittedBy: string;
    actor: string;
    tenantId: string;
  };

  @Prop({
    type: String,
    enum: ['pending', 'processing', 'published', 'failed'],
    default: 'pending',
  })
  status!: OutboxEventStatus;

  /**
   * When a poller claimed the event (`processing`). A claim older than OUTBOX_CLAIM_TIMEOUT_MS is
   * taken again. Not in the schema before, so Mongoose dropped it from the claim's update.
   */
  @Prop({ type: Date })
  claimedAt?: Date;

  /**
   * Set on each claim. The claiming process renews claimedAt and writes the outcome only while the
   * stored token is still its own, so a process whose claim was taken over changes nothing.
   */
  @Prop({ type: String })
  claimToken?: string;

  @Prop({ default: 0 })
  retryCount!: number;

  /** After a failed publish: the event is not claimed again before this time (backoff). */
  @Prop({ type: Date })
  nextAttemptAt?: Date;

  @Prop()
  publishedAt?: Date;

  /** Set when status becomes published; TTL index expires docs after 7 days. */
  @Prop()
  expireAt?: Date;

  @Prop({ default: () => new Date() })
  createdAt!: Date;
}

export type OutboxEventDocument = HydratedDocument<OutboxEvent>;
export const OutboxEventSchema = SchemaFactory.createForClass(OutboxEvent);

OutboxEventSchema.index({ status: 1, createdAt: 1 });
OutboxEventSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

// ── TASK 106 RECAP ──
// Added: Mongoose schema for transactional outbox. Events stored with status (pending/published/failed),
// retryCount, expireAt. Indexes for poller queries and 7-day TTL cleanup of published events.
