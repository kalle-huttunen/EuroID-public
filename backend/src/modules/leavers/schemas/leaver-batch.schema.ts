import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import type { LeaverReason } from '@infrastructure/events/event-payloads';

export type LeaverBatchStatus = 'pending' | 'approved' | 'rejected';

/**
 * The leavers of one sync run that exceeded the mass-leaver limit. None of them starts until an
 * admin approves the batch; a rejection clears them. Members are the leaver_events with this
 * batchId.
 */
@Schema({ timestamps: true, collection: 'leaver_batches' })
export class LeaverBatch {
  @Prop({ required: true, index: true })
  tenantId!: string;

  @Prop({ required: true })
  sourceName!: string;

  @Prop({ required: true, type: String, enum: ['pending', 'approved', 'rejected'] })
  status!: LeaverBatchStatus;

  @Prop({ required: true })
  identityCount!: number;

  /** Leavers the run could have started without approval (massLeaverAllowance). */
  @Prop({ required: true })
  allowance!: number;

  @Prop({ required: true })
  activeIdentityCount!: number;

  @Prop({ type: Object, default: {} })
  reasonCounts!: Partial<Record<LeaverReason, number>>;

  @Prop()
  decidedBy?: string;

  @Prop()
  decidedAt?: Date;

  @Prop()
  comment?: string;

  /** Offboardings the approval started. */
  @Prop()
  startedCount?: number;
}

export type LeaverBatchDocument = HydratedDocument<LeaverBatch>;
export const LeaverBatchSchema = SchemaFactory.createForClass(LeaverBatch);

LeaverBatchSchema.index({ tenantId: 1, status: 1, createdAt: -1 });
