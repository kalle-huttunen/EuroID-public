import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import type { LeaverSignalToggles } from '../leaver-policy.defaults';

/**
 * Per-tenant leaver policy (one document per tenant). A tenant without one gets
 * `defaultLeaverPolicy()`; see leaver-policy.defaults.ts for what each field means.
 */
@Schema({ timestamps: true, collection: 'leaver_policies' })
export class LeaverPolicy {
  @Prop({ required: true, unique: true, index: true })
  tenantId!: string;

  @Prop({ type: Object, required: true })
  signals!: LeaverSignalToggles;

  @Prop({ type: [String], required: true })
  terminatedStatuses!: string[];

  @Prop({ required: true, min: 1 })
  missingSyncThreshold!: number;

  @Prop({ required: true, min: 0 })
  massLeaverMaxCount!: number;

  @Prop({ required: true, min: 0, max: 100 })
  massLeaverMaxPercent!: number;

  /** Absent in policies stored before the floor existed: read as defaultMassLeaverMinCount. */
  @Prop({ min: 0 })
  massLeaverMinCount?: number;

  @Prop({ required: true })
  timezone!: string;

  /** Who last changed the policy (authenticated user). */
  @Prop()
  updatedBy?: string;
}

export type LeaverPolicyDocument = HydratedDocument<LeaverPolicy>;
export const LeaverPolicySchema = SchemaFactory.createForClass(LeaverPolicy);
