/**
 * Event Subscription Schema
 *
 * Stores webhook subscription configurations for external systems to receive
 * EuroID domain events. Signing secrets encrypted at rest via EncryptionService.
 */

import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type SubscriptionStatus = 'ACTIVE' | 'PAUSED' | 'DISABLED';
export type SubscriptionType = 'WEBHOOK';

@Schema({ _id: false })
export class SubscriptionFilter {
  /** Glob patterns for event types, e.g. 'identity.*', 'provisioning.failed' */
  @Prop({ type: [String], required: true })
  eventTypes!: string[];

  @Prop({ type: String })
  severityMin?: string;
}

const SubscriptionFilterSchema = SchemaFactory.createForClass(SubscriptionFilter);

@Schema({ _id: false })
export class WebhookConfig {
  /** SSRF-validated on write */
  @Prop({ required: true })
  url!: string;

  @Prop({ type: Map, of: String, default: {} })
  headers!: Map<string, string>;

  /** Encrypted via EncryptionService (AES-256-GCM) */
  @Prop({ required: true })
  signingSecret!: string;
}

const WebhookConfigSchema = SchemaFactory.createForClass(WebhookConfig);

@Schema({ timestamps: true, collection: 'event_subscriptions' })
export class EventSubscription {
  @Prop({ required: true, index: true })
  tenantId!: string;

  @Prop({ required: true })
  name!: string;

  @Prop({ required: true, type: String, default: 'WEBHOOK' })
  type!: SubscriptionType;

  @Prop({ required: true, type: String, default: 'ACTIVE' })
  status!: SubscriptionStatus;

  @Prop({ type: SubscriptionFilterSchema, required: true })
  filters!: SubscriptionFilter;

  @Prop({ type: WebhookConfigSchema, required: true })
  webhook!: WebhookConfig;

  @Prop()
  createdBy?: string;
}

export type EventSubscriptionDocument = HydratedDocument<EventSubscription>;
export const EventSubscriptionSchema = SchemaFactory.createForClass(EventSubscription);

// ── Indexes ──────────────────────────────────────────────────────────
EventSubscriptionSchema.index({ tenantId: 1, status: 1 });
EventSubscriptionSchema.index({ tenantId: 1, name: 1 }, { unique: true });
