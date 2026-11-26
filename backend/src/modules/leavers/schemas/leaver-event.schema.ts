import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import type { LeaverReason } from '@infrastructure/events/event-payloads';

/**
 * - pending-approval: in a paused batch, waiting for an admin
 * - queued: cleared to start (under the mass-leaver limit, or its batch approved) and not started
 *   yet; a failed start stays queued (startError) and is retried by the source's next sync
 * - started: the offboarding workflow started (workflowId)
 * - rejected: an admin rejected its batch
 * - superseded: the person was back in the feed when the batch was approved, so not started
 */
export type LeaverEventStatus =
  | 'pending-approval'
  | 'queued'
  | 'started'
  | 'rejected'
  | 'superseded';

/** Statuses that still lead to an offboarding; an identity has at most one such event. */
export const OPEN_LEAVER_STATUSES: LeaverEventStatus[] = ['pending-approval', 'queued'];

/**
 * One leaver event: an identity an HR sync found to have left, and what became of it.
 * `eventKey` (source, reason, evidence) is unique per identity, so re-running a sync on the same
 * evidence never raises the event again, whatever its status (a rejection sticks until the HR
 * data changes).
 */
@Schema({ timestamps: true, collection: 'leaver_events' })
export class LeaverEvent {
  @Prop({ required: true, index: true })
  tenantId!: string;

  @Prop({ required: true })
  identityId!: string;

  @Prop({ required: true })
  sourceName!: string;

  @Prop({ required: true, type: String, enum: ['terminated', 'end-date', 'missing-from-source'] })
  reason!: LeaverReason;

  @Prop({ required: true })
  eventKey!: string;

  @Prop()
  effectiveDate?: Date;

  @Prop({
    required: true,
    type: String,
    enum: ['pending-approval', 'queued', 'started', 'rejected', 'superseded'],
  })
  status!: LeaverEventStatus;

  /** True while the status is open (OPEN_LEAVER_STATUSES); backs the one-open-event index. */
  @Prop({ required: true })
  open!: boolean;

  @Prop()
  batchId?: string;

  @Prop({ required: true })
  detectedAt!: Date;

  @Prop()
  workflowId?: string;

  @Prop()
  startedAt?: Date;

  /** Last failed start attempt, for a queued event. */
  @Prop()
  startError?: string;

  /** Why a superseded or rejected event closed without an offboarding. */
  @Prop()
  closeReason?: string;

  /** Set while one process starts the offboarding, so two starters never both run it. */
  @Prop()
  claimedAt?: Date;

  /**
   * The first start attempt. A later attempt counts an offboarding of the identity that finished
   * since then as this event's (an earlier start that timed out but ran), never starting another.
   */
  @Prop()
  startAttemptedAt?: Date;

  /** Actor of the batch decision (authenticated user), for batch members. */
  @Prop()
  decidedBy?: string;

  /**
   * When the started offboarding reported its result (kept in offboarding_records under
   * `workflowId`); unset while it runs. The HR mover skips identities whose leaver offboarding
   * has not finished (modules/mover/hr-mover-execution.service.ts).
   */
  @Prop()
  offboardingFinishedAt?: Date;
}

export type LeaverEventDocument = HydratedDocument<LeaverEvent>;
export const LeaverEventSchema = SchemaFactory.createForClass(LeaverEvent);

LeaverEventSchema.index({ tenantId: 1, identityId: 1, eventKey: 1 }, { unique: true });
LeaverEventSchema.index(
  { tenantId: 1, identityId: 1 },
  { unique: true, partialFilterExpression: { open: true } },
);
LeaverEventSchema.index({ tenantId: 1, batchId: 1 });
LeaverEventSchema.index({ tenantId: 1, status: 1, sourceName: 1 });
// The started event of an offboarding (its result is in offboarding_records, by workflow id)
LeaverEventSchema.index({ tenantId: 1, workflowId: 1 });
