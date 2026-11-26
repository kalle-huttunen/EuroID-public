/**
 * Email Notification Schema
 *
 * One email to one recipient: stored before the first send so a failed send can be retried from
 * the dead-letter queue (which holds only this document's id, no address or content). Bodies are
 * dropped once sent. Auto-deleted after 30 days via TTL index, like webhook delivery attempts.
 */

import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type EmailNotificationKind =
  | 'approval-requested'
  | 'review-assigned'
  | 'review-escalated'
  | 'access-expiring'
  | 'drift-threshold-exceeded';

export type EmailNotificationStatus = 'PENDING' | 'SENDING' | 'SENT' | 'FAILED';

@Schema({ timestamps: true, collection: 'email_notifications' })
export class EmailNotification {
  @Prop({ required: true, index: true })
  tenantId!: string;

  @Prop({ required: true, type: String })
  kind!: EmailNotificationKind;

  /**
   * The same notification twice (an hourly expiry run, a retried activity, a replayed event)
   * is stored, and sent, once. Unique per tenant.
   */
  @Prop({ required: true })
  dedupeKey!: string;

  @Prop({ required: true })
  to!: string;

  @Prop({ required: true })
  subject!: string;

  @Prop({ type: String })
  text?: string;

  @Prop({ type: String })
  html?: string;

  @Prop({ required: true, type: String, default: 'PENDING' })
  status!: EmailNotificationStatus;

  @Prop({ required: true, type: Number, default: 0 })
  attempts!: number;

  /** When the current send started; a SENDING claim older than the stale limit can be taken over. */
  @Prop({ type: Date })
  claimedAt?: Date;

  @Prop({ type: Date })
  sentAt?: Date;

  /** Last send error, email addresses masked. */
  @Prop({ type: String })
  lastError?: string;
}

export type EmailNotificationDocument = HydratedDocument<EmailNotification>;
export const EmailNotificationSchema = SchemaFactory.createForClass(EmailNotification);

// ── Indexes ──────────────────────────────────────────────────────────
EmailNotificationSchema.index({ tenantId: 1, dedupeKey: 1 }, { unique: true });
// TTL: auto-delete after 30 days
EmailNotificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });
