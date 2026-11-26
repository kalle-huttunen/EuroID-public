/**
 * User Event Schema
 *
 * Timeline events for an individual user's lifecycle. Displayed in the
 * identity page's (IdentityDetailPage) "Timeline" tab. Each event captures what happened,
 * who/what triggered it, and optional metadata.
 */

import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

// ── Types ────────────────────────────────────────────────────────────

export type TimelineEventType =
  | 'USER_CREATED'
  | 'USER_UPDATED'
  | 'USER_PROVISIONED'
  | 'USER_DEPROVISIONED'
  | 'POLICY_EVALUATED'
  | 'DRIFT_DETECTED'
  | 'DRIFT_RESOLVED'
  | 'GROUP_ASSIGNED'
  | 'GROUP_REMOVED'
  | 'LICENSE_ASSIGNED'
  | 'LICENSE_REMOVED'
  | 'WORKFLOW_STARTED'
  | 'WORKFLOW_COMPLETED'
  | 'APPROVAL_REQUESTED'
  | 'APPROVAL_GRANTED'
  | 'STATUS_CHANGE' // For identity.status_changed events
  | 'LEAVER_DETECTED'; // An HR sync found the user has left (identity.leaver_detected)

export type TimelineEventSeverity = 'info' | 'success' | 'warning' | 'error';

// ── Schema ───────────────────────────────────────────────────────────

@Schema({ timestamps: true, collection: 'user_events' })
export class UserEvent {
  @Prop({ required: true, index: true })
  tenantId!: string;

  /** The user this event belongs to (MongoDB _id or email) */
  @Prop({ required: true, type: String, index: true })
  userId!: string;

  @Prop({ required: true, type: String })
  type!: TimelineEventType;

  @Prop({ required: true, type: String, default: 'info' })
  severity!: TimelineEventSeverity;

  @Prop({ required: true, type: Date, default: () => new Date() })
  timestamp!: Date;

  /** Short summary (e.g., "Provisioned to Entra ID") */
  @Prop({ required: true, type: String })
  title!: string;

  /** Optional longer description */
  @Prop({ type: String })
  description!: string;

  /** The system or user that triggered this event */
  @Prop({ required: true, type: String })
  actor!: string;

  /** Target system involved (e.g., "Entra ID", "Active Directory") */
  @Prop({ type: String })
  targetSystem!: string;

  /**
   * The domain event this entry records, set by a handler that writes one entry of its type per
   * event (UserTimelineHandler): a redelivered event writes none. Absent otherwise.
   */
  @Prop({ type: String })
  eventId?: string;

  /** Additional metadata (field changes, group names, etc.) */
  @Prop({ type: Object })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mongoose Mixed type for dynamic event metadata; shape varies per event type
  metadata!: Record<string, any>;
}

export type UserEventDocument = UserEvent & Document;
export const UserEventSchema = SchemaFactory.createForClass(UserEvent);

// ── Indexes ──────────────────────────────────────────────────────────

UserEventSchema.index({ tenantId: 1, userId: 1, timestamp: -1 });
UserEventSchema.index({ type: 1 });
// One entry of a type per domain event; entries without eventId are not in the index
UserEventSchema.index(
  { tenantId: 1, eventId: 1, type: 1 },
  { unique: true, partialFilterExpression: { eventId: { $type: 'string' } } },
);

// TTL: retention + 30-day buffer so archival workflow can export before auto-delete
const userEventsRetentionDays = parseInt(process.env.USER_EVENTS_RETENTION_DAYS || '365', 10);
const userEventsTtlSeconds = (userEventsRetentionDays + 30) * 86400;
UserEventSchema.index({ timestamp: 1 }, { expireAfterSeconds: userEventsTtlSeconds });

// --- Task 108 recap: TTL extended by 30 days so archival workflow can export before auto-delete.
