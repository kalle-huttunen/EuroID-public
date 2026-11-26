/**
 * Dead Letter Queue Schema
 *
 * Captures failed events, failed Temporal workflows, and non-retryable connector errors.
 * Admin can inspect, replay, or dismiss entries. Auto-purged after 90 days.
 */

import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema } from 'mongoose';

// ── Types ────────────────────────────────────────────────────────────

export type DeadLetterType =
  | 'event_handler_failure'
  | 'event_chain_depth_exceeded'
  | 'event_validation_failure'
  | 'workflow_terminal'
  | 'connector_non_retryable';

export type DeadLetterStatus =
  | 'pending'
  | 'replayed'
  | 'dismissed'
  | 'retrying'
  | 'failed_permanently';

// ── Schema ───────────────────────────────────────────────────────────

/**
 * The entry's `error`. Its own schema so the global tenant plugin skips it: the plugin's
 * pre('validate') would demand a tenant context for the nested document even though the entry
 * carries its tenantId, and capture from a poller (outbox, webhook retries) has no context.
 */
const DeadLetterErrorSchema = new MongooseSchema(
  { message: String, stack: String, code: String },
  { _id: false },
);
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mongoose schema options do not expose custom keys; cast required for plugin bypass flag
DeadLetterErrorSchema.set('skipTenantPlugin' as any, true);

@Schema({ timestamps: true, collection: 'dead_letter' })
export class DeadLetterEntry {
  @Prop({ required: true, index: true })
  tenantId!: string;

  @Prop({ required: true, type: String })
  type!: DeadLetterType;

  @Prop({ required: true, type: String })
  source!: string;

  @Prop({ required: true, type: MongooseSchema.Types.Mixed })
  originalPayload!: Record<string, unknown>;

  /**
   * The `@OnEvent` handler that failed (`Class.method`), when the failure was captured per
   * handler (`HandlerFailureCaptureService`). Retry and replay then run only this handler with
   * the stored event; without it they re-emit the event to every handler.
   */
  @Prop({ type: String })
  handler?: string;

  @Prop({ required: true, type: DeadLetterErrorSchema })
  error!: {
    message: string;
    stack?: string;
    code?: string;
  };

  @Prop({ type: String })
  correlationId?: string;

  @Prop({ required: true, type: Number, default: 0 })
  retryCount!: number;

  @Prop({ required: true, type: String, default: 'pending' })
  status!: DeadLetterStatus;

  @Prop({ required: true, type: Number, default: 3 })
  maxRetries!: number;

  @Prop({ type: Date })
  nextRetryAt?: Date;

  @Prop({ type: String })
  lastRetryError?: string;

  @Prop({ type: String })
  resolvedBy?: string;

  @Prop({ type: Date })
  resolvedAt?: Date;
}

export type DeadLetterEntryDocument = DeadLetterEntry & Document;
export const DeadLetterEntrySchema = SchemaFactory.createForClass(DeadLetterEntry);

// ── Indexes ──────────────────────────────────────────────────────────

DeadLetterEntrySchema.index({ status: 1, createdAt: -1 });
DeadLetterEntrySchema.index({ type: 1 });
DeadLetterEntrySchema.index({ correlationId: 1 });
DeadLetterEntrySchema.index({ status: 1, nextRetryAt: 1 }); // Retry poller query
// TTL index: auto-delete after 90 days
DeadLetterEntrySchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });
