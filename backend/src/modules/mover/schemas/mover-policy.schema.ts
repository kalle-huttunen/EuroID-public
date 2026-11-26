import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

/**
 * Per-tenant HR mover policy (one document per tenant). A tenant without one gets
 * `defaultMoverPolicy()`; see ../hr-mover-policy.defaults.ts for what each field means.
 */
@Schema({ timestamps: true, collection: 'mover_policies' })
export class MoverPolicy {
  @Prop({ required: true, unique: true, index: true })
  tenantId!: string;

  @Prop({ required: true, min: 0 })
  massMoverMaxCount!: number;

  @Prop({ required: true, min: 0, max: 100 })
  massMoverMaxPercent!: number;

  @Prop({ required: true, min: 0 })
  massMoverMinCount!: number;

  /** Who last changed the policy (authenticated user). */
  @Prop()
  updatedBy?: string;
}

export type MoverPolicyDocument = HydratedDocument<MoverPolicy>;
export const MoverPolicySchema = SchemaFactory.createForClass(MoverPolicy);
