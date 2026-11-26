import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';

// ── Enums (match frontend types.ts) ─────────────────────────────────

export enum PolicyStatus {
  ACTIVE = 'active',
  DISABLED = 'disabled',
  DRAFT = 'draft',
  TESTING = 'testing',
}

export enum RiskLevel {
  LOW = 'Low',
  MEDIUM = 'Medium',
  HIGH = 'High',
  CRITICAL = 'Critical',
}

// ── Subdocument: Condition ──────────────────────────────────────────

@Schema({ _id: false })
export class PolicyCondition {
  @Prop({ required: true })
  id!: string;

  @Prop({ required: true })
  field!: string;

  @Prop({ required: true })
  operator!: string; // equals, not_equals, contains, starts_with, ends_with, in, not_in, regex, greater_than, less_than, is_empty, is_not_empty

  @Prop({ type: MongooseSchema.Types.Mixed, required: true })
  value!: string | string[];
}

// ── Subdocument: ConditionGroup ─────────────────────────────────────

@Schema({ _id: false })
export class ConditionGroup {
  @Prop({ required: true })
  id!: string;

  @Prop({ required: true, enum: ['AND', 'OR'] })
  join!: 'AND' | 'OR';

  @Prop({ type: [PolicyCondition], default: [] })
  conditions!: PolicyCondition[];
}

// ── Subdocument: PolicyAction ───────────────────────────────────────

@Schema({ _id: false })
export class PolicyAction {
  @Prop({ required: true })
  id!: string;

  @Prop({ required: true })
  type!: string; // assign_group, assign_license, set_attribute, enable_mfa, etc.

  @Prop({ required: true })
  target!: string; // active-directory, entra-id, salesforce, all

  @Prop({ type: Object, default: {} })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mongoose Mixed type for dynamic action parameters; shape varies per action type
  params!: Record<string, any>;

  @Prop()
  label?: string;

  @Prop()
  description?: string;

  /** Time-bound access: duration in days or fixed expiry date. */
  @Prop({ type: Object })
  timeConstraint?: { durationDays?: number; expiresAt?: Date };
}

// ── Main Document: Policy ───────────────────────────────────────────

export type PolicyDocument = HydratedDocument<Policy>;

@Schema({
  timestamps: true,
  collection: 'policies',
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
  optimisticConcurrency: true,
})
export class Policy {
  @Prop({ required: true, index: true })
  tenantId!: string;

  @Prop({ required: true })
  name!: string;

  @Prop({ default: '' })
  description!: string;

  @Prop({ enum: PolicyStatus, default: PolicyStatus.DRAFT, index: true })
  status!: PolicyStatus;

  @Prop({ default: 3, min: 1, max: 5, index: true })
  priority!: number;

  @Prop({ enum: RiskLevel, default: RiskLevel.LOW })
  risk!: RiskLevel;

  @Prop({ type: [ConditionGroup], default: [] })
  conditionGroups!: ConditionGroup[];

  @Prop({ type: [PolicyAction], default: [] })
  actions!: PolicyAction[];

  @Prop({ type: [String], default: [] })
  tags!: string[];

  /**
   * Employment types this policy targets. When absent or empty, only human types (FULL_TIME, PART_TIME, etc.) are evaluated.
   * Include 'SERVICE_ACCOUNT' or 'ADMIN_ACCOUNT' to evaluate machine identities.
   */
  @Prop({ type: [String], default: [] })
  targetEmploymentTypes?: string[];

  @Prop({ default: 'system' })
  createdBy!: string;

  /**
   * Who last changed what the policy grants (conditions, actions, role bundle) and when. That
   * change sends the policy to DRAFT; `activate` then refuses this admin (on a policy never so
   * edited: its creator), so a second policy-admin reviews every grant change.
   */
  @Prop()
  lastEditedBy?: string;

  @Prop()
  lastEditedAt?: Date;

  @Prop()
  lastTriggered?: Date;

  @Prop({ default: 0 })
  affectedUsers!: number;

  @Prop({ default: 0 })
  totalExecutions!: number;

  @Prop()
  roleBundleId?: string;
}

export const PolicySchema = SchemaFactory.createForClass(Policy);

// Compound index for common queries (tenant-scoped)
PolicySchema.index({ tenantId: 1, status: 1, priority: 1 });
