import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type JoinerBatchStatus = 'pending' | 'approved' | 'rejected';

/**
 * The due joiners of one HR sync that exceeded the mass-joiner limit. No onboarding starts until
 * an admin approves the batch; a rejection closes it. Members are the joiner_events with this
 * batchId.
 */
@Schema({ timestamps: true, collection: 'joiner_batches' })
export class JoinerBatch {
  @Prop({ required: true, index: true })
  tenantId!: string;

  @Prop({ required: true })
  sourceName!: string;

  @Prop({ required: true, type: String, enum: ['pending', 'approved', 'rejected'] })
  status!: JoinerBatchStatus;

  @Prop({ required: true })
  identityCount!: number;

  /** Onboarding runs the sync could have started without approval (massJoinerAllowance). */
  @Prop({ required: true })
  allowance!: number;

  @Prop({ required: true })
  activeIdentityCount!: number;

  @Prop()
  decidedBy?: string;

  @Prop()
  decidedAt?: Date;

  @Prop()
  comment?: string;

  /** Onboarding runs the approval started. */
  @Prop()
  startedCount?: number;
}

export type JoinerBatchDocument = HydratedDocument<JoinerBatch>;
export const JoinerBatchSchema = SchemaFactory.createForClass(JoinerBatch);

JoinerBatchSchema.index({ tenantId: 1, status: 1, createdAt: -1 });
