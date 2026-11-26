import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

/**
 * Per-tenant HR joiner policy (one document per tenant). A tenant without one gets
 * `defaultJoinerPolicy()`; see ../joiner-policy.defaults.ts for what each field means.
 */
@Schema({ timestamps: true, collection: 'joiner_policies' })
export class JoinerPolicy {
  @Prop({ required: true, unique: true, index: true })
  tenantId!: string;

  @Prop({ required: true, min: 0 })
  massJoinerMaxCount!: number;

  @Prop({ required: true, min: 0, max: 100 })
  massJoinerMaxPercent!: number;

  @Prop({ required: true, min: 0 })
  massJoinerMinCount!: number;

  /** Who last changed the policy (authenticated user). */
  @Prop()
  updatedBy?: string;
}

export type JoinerPolicyDocument = HydratedDocument<JoinerPolicy>;
export const JoinerPolicySchema = SchemaFactory.createForClass(JoinerPolicy);
