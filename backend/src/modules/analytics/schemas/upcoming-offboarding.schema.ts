/**
 * Upcoming Offboarding Schema
 *
 * Cached pre-computation of offboarding blast radius for identities
 * approaching their endDate. Marked stale when identity is updated.
 */

import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type BlastRadiusRiskLevel = 'low' | 'medium' | 'high';

@Schema({ _id: false })
export class BlastRadiusEntitlement {
  @Prop({ required: true })
  system!: string;

  @Prop({ required: true })
  name!: string;

  @Prop({ required: true })
  type!: string;
}

export const BlastRadiusEntitlementSchema = SchemaFactory.createForClass(BlastRadiusEntitlement);

@Schema({ _id: false })
export class BlastRadius {
  @Prop({ type: [String], default: [] })
  affectedSystems!: string[];

  @Prop({ type: [BlastRadiusEntitlementSchema], default: [] })
  entitlements!: BlastRadiusEntitlement[];

  @Prop({ default: 0 })
  totalEntitlements!: number;

  @Prop({ enum: ['low', 'medium', 'high'], default: 'low' })
  riskLevel!: BlastRadiusRiskLevel;
}

export const BlastRadiusSchema = SchemaFactory.createForClass(BlastRadius);

@Schema({
  timestamps: true,
  collection: 'upcoming_offboardings',
})
export class UpcomingOffboarding {
  @Prop({ required: true, index: true })
  tenantId!: string;

  @Prop({ required: true, index: true })
  identityId!: string;

  @Prop({ required: true })
  email!: string;

  @Prop()
  displayName?: string;

  @Prop({ required: true, index: true })
  endDate!: Date;

  @Prop({ required: true })
  daysRemaining!: number;

  @Prop({ type: BlastRadiusSchema, required: true })
  blastRadius!: BlastRadius;

  @Prop({ required: true, default: () => new Date() })
  computedAt!: Date;

  @Prop({ default: false })
  stale!: boolean;
}

export type UpcomingOffboardingDocument = HydratedDocument<UpcomingOffboarding>;
export const UpcomingOffboardingSchema = SchemaFactory.createForClass(UpcomingOffboarding);

UpcomingOffboardingSchema.index({ tenantId: 1, identityId: 1 });
UpcomingOffboardingSchema.index({ computedAt: 1 });
UpcomingOffboardingSchema.index({ stale: 1 });
