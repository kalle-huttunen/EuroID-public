import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import type { TriggerAttributeChange } from '../hr-mover-changes';

/**
 * - pending-approval: waits in a paused batch (open)
 * - started: the approval started its mover run (workflowId)
 * - superseded: nothing to start at approval (access already matched, identity gone or being
 *   offboarded, a mover run already in progress); `closeReason` says which
 * - failed: the approval could not start the run (`closeReason`); the next sync detects it again
 * - rejected: the batch was rejected; the same changes are not raised again
 */
export type MoverBatchItemStatus =
  | 'pending-approval'
  | 'started'
  | 'superseded'
  | 'failed'
  | 'rejected';

/**
 * One identity in a paused mover batch: the trigger attributes the HR sync changed against its
 * access baseline (values as detected; the approval recomputes them).
 */
@Schema({ timestamps: true, collection: 'mover_batch_items' })
export class MoverBatchItem {
  @Prop({ required: true, index: true })
  tenantId!: string;

  @Prop({ required: true })
  batchId!: string;

  @Prop({ required: true })
  identityId!: string;

  @Prop({ required: true })
  sourceName!: string;

  @Prop({ type: [Object], required: true })
  changes!: TriggerAttributeChange[];

  /** changeKey(changes): a rejected item with the same key is not raised again. */
  @Prop({ required: true })
  changeKey!: string;

  @Prop({
    required: true,
    type: String,
    enum: ['pending-approval', 'started', 'superseded', 'failed', 'rejected'],
  })
  status!: MoverBatchItemStatus;

  /** True while pending-approval; backs the one-open-item-per-identity index. */
  @Prop({ required: true })
  open!: boolean;

  @Prop()
  workflowId?: string;

  @Prop()
  closeReason?: string;

  @Prop()
  decidedBy?: string;

  /**
   * Set while one process starts an approved item's run, so two starters never both start it;
   * abandoned after HR_START_CLAIM_TIMEOUT_MS (HrMoverBatchService.startApproved).
   */
  @Prop()
  claimedAt?: Date;
}

export type MoverBatchItemDocument = HydratedDocument<MoverBatchItem>;
export const MoverBatchItemSchema = SchemaFactory.createForClass(MoverBatchItem);

MoverBatchItemSchema.index({ tenantId: 1, batchId: 1 });
MoverBatchItemSchema.index(
  { tenantId: 1, identityId: 1 },
  { unique: true, partialFilterExpression: { open: true } },
);
MoverBatchItemSchema.index({ tenantId: 1, identityId: 1, status: 1, changeKey: 1 });
