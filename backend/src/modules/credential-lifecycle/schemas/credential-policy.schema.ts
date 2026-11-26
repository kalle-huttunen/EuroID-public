/**
 * Credential Policy Schema
 *
 * Defines password rotation, MFA requirements, and compliance rules
 * scoped by target connector type and employment type.
 */

import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

// ── Sub-schemas ──────────────────────────────────────────────────────────

@Schema({ _id: false })
export class TargetScopeConfig {
  @Prop({ type: [String] })
  connectorTypes?: string[];

  @Prop({ type: [String] })
  employmentTypes?: string[];

  @Prop({ type: [Number] })
  entitlementTiers?: number[];
}

export const TargetScopeConfigSchema = SchemaFactory.createForClass(TargetScopeConfig);

@Schema({ _id: false })
export class PasswordPolicyConfig {
  @Prop({ type: Number, default: 90 })
  maxAgeDays!: number;

  @Prop({ type: Number, default: 16 })
  minLength!: number;

  @Prop({ type: Boolean, default: true })
  requireComplexity!: boolean;

  @Prop({ type: Number, default: 5 })
  preventReuse!: number;
}

export const PasswordPolicyConfigSchema = SchemaFactory.createForClass(PasswordPolicyConfig);

@Schema({ _id: false })
export class RotationPolicyConfig {
  @Prop({ type: Boolean, default: false })
  enabled!: boolean;

  @Prop({ type: Number, default: 90 })
  intervalDays!: number;

  @Prop({ type: Number, default: 7 })
  notifyDaysBefore!: number;

  @Prop({ type: Boolean, default: false })
  vaultStorage!: boolean;
}

export const RotationPolicyConfigSchema = SchemaFactory.createForClass(RotationPolicyConfig);

@Schema({ _id: false })
export class MfaRequirementConfig {
  @Prop({ type: Boolean, default: false })
  required!: boolean;

  @Prop({ type: [String], default: [] })
  methods!: string[];

  @Prop({ type: Number, default: 14 })
  gracePeriodDays!: number;
}

export const MfaRequirementConfigSchema = SchemaFactory.createForClass(MfaRequirementConfig);

// ── Main schema ──────────────────────────────────────────────────────────

@Schema({ timestamps: true, collection: 'credential_policies' })
export class CredentialPolicy {
  @Prop({ required: true, index: true })
  tenantId!: string;

  @Prop({ required: true })
  name!: string;

  @Prop()
  description?: string;

  @Prop({ type: TargetScopeConfigSchema })
  targetScope?: TargetScopeConfig;

  @Prop({ type: PasswordPolicyConfigSchema })
  passwordPolicy?: PasswordPolicyConfig;

  @Prop({ type: RotationPolicyConfigSchema })
  rotationPolicy?: RotationPolicyConfig;

  @Prop({ type: MfaRequirementConfigSchema })
  mfaRequirement?: MfaRequirementConfig;

  @Prop({ type: Boolean, default: true })
  isActive!: boolean;
}

export type CredentialPolicyDocument = HydratedDocument<CredentialPolicy>;
export const CredentialPolicySchema = SchemaFactory.createForClass(CredentialPolicy);

CredentialPolicySchema.index({ tenantId: 1, name: 1 }, { unique: true });
