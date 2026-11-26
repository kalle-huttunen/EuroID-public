import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type MoverBatchStatus = 'pending' | 'approved' | 'rejected';

/**
 * The movers of one HR sync that exceeded the mass-mover limit. No mover run starts until an
 * admin approves the batch; a rejection closes it. Members are the mover_batch_items with this
 * batchId.
 */
@Schema({ timestamps: true, collection: 'mover_batches' })
export class MoverBatch {
  @Prop({ required: true, index: true })
  tenantId!: string;

  @Prop({ required: true })
  sourceName!: string;

  @Prop({ required: true, type: String, enum: ['pending', 'approved', 'rejected'] })
  status!: MoverBatchStatus;

  @Prop({ required: true })
  identityCount!: number;

  /** Mover runs the sync could have started without approval (massMoverAllowance). */
  @Prop({ required: true })
  allowance!: number;

  @Prop({ required: true })
  activeIdentityCount!: number;

  /** How many members changed each trigger attribute (departmentName: 12, ...). */
  @Prop({ type: Object, default: {} })
  fieldCounts!: Record<string, number>;

  @Prop()
  decidedBy?: string;

  @Prop()
  decidedAt?: Date;

  @Prop()
  comment?: string;

  /** Mover runs the approval started. */
  @Prop()
  startedCount?: number;
}

export type MoverBatchDocument = HydratedDocument<MoverBatch>;
export const MoverBatchSchema = SchemaFactory.createForClass(MoverBatch);

MoverBatchSchema.index({ tenantId: 1, status: 1, createdAt: -1 });
