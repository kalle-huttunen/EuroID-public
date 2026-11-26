import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

/** Reference to an entitlement (system + type + targetId) for SoD conflict detection. */
export interface SodEntitlementRef {
  system: string;
  type: string;
  targetId: string;
}

@Schema({ _id: false })
export class SodEntitlementRefDoc {
  @Prop({ required: true })
  system!: string;

  @Prop({ required: true })
  type!: string;

  @Prop({ required: true })
  targetId!: string;
}

const SodEntitlementRefSchema = SchemaFactory.createForClass(SodEntitlementRefDoc);

export type SodPolicyDocument = HydratedDocument<SodPolicy>;

@Schema({ collection: 'sod_policies', timestamps: true })
export class SodPolicy {
  @Prop({ required: true, index: true })
  tenantId!: string;

  @Prop({ required: true })
  name!: string;

  @Prop()
  description?: string;

  @Prop({
    required: true,
    enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'],
    default: 'HIGH',
  })
  severity!: string;

  @Prop({ required: true, type: [SodEntitlementRefSchema] })
  conflictingEntitlements!: SodEntitlementRef[];

  @Prop({ default: true })
  isActive!: boolean;

  @Prop({ enum: ['BLOCK', 'WARN'], default: 'BLOCK' })
  action!: 'BLOCK' | 'WARN';
}

export const SodPolicySchema = SchemaFactory.createForClass(SodPolicy);

SodPolicySchema.index({ tenantId: 1, isActive: 1 });
