import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';

// ── Enums ────────────────────────────────────────────────────────────

export enum SuggestionType {
  BIRTHRIGHT_PATTERN = 'BIRTHRIGHT_PATTERN',
  ORPHAN_ENTITLEMENT = 'ORPHAN_ENTITLEMENT',
  REDUNDANT_POLICY = 'REDUNDANT_POLICY',
  COVERAGE_GAP = 'COVERAGE_GAP',
}

export type SuggestionStatus = 'pending' | 'accepted' | 'dismissed' | 'expired';

// ── Subdocument: Suggested Policy (matches AccessPolicy/Policy shape) ──

@Schema({ _id: false })
export class SuggestedPolicyCondition {
  @Prop({ required: true })
  id!: string;

  @Prop({ required: true })
  field!: string;

  @Prop({ required: true })
  operator!: string;

  @Prop({ type: MongooseSchema.Types.Mixed, required: true })
  value!: string | string[];
}

@Schema({ _id: false })
export class SuggestedConditionGroup {
  @Prop({ required: true })
  id!: string;

  @Prop({ required: true, enum: ['AND', 'OR'] })
  join!: 'AND' | 'OR';

  @Prop({ type: [SuggestedPolicyCondition], default: [] })
  conditions!: SuggestedPolicyCondition[];
}

@Schema({ _id: false })
export class SuggestedPolicyAction {
  @Prop({ required: true })
  id!: string;

  @Prop({ required: true })
  type!: string;

  @Prop({ required: true })
  target!: string;

  @Prop({ type: Object, default: {} })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mongoose Mixed type for dynamic action parameters; shape varies per action type
  params!: Record<string, any>;

  @Prop()
  label?: string;

  @Prop()
  description?: string;
}

@Schema({ _id: false })
export class SuggestedPolicy {
  @Prop({ required: true })
  name!: string;

  @Prop({ type: [SuggestedConditionGroup], default: [] })
  conditionGroups!: SuggestedConditionGroup[];

  @Prop({ type: [SuggestedPolicyAction], default: [] })
  actions!: SuggestedPolicyAction[];

  @Prop({ required: true })
  risk!: string; // RiskLevel enum value
}

// ── Subdocument: Evidence ────────────────────────────────────────────

@Schema({ _id: false })
export class SuggestionEvidence {
  @Prop({ required: true })
  totalUsers!: number;

  @Prop({ required: true })
  matchingUsers!: number;

  @Prop({ required: true })
  percentage!: number;

  @Prop({ type: [String], default: [] })
  sampleUserIds!: string[];

  @Prop({ type: [String], default: [] })
  affectedEntitlements!: string[];
}

// ── Main Document ────────────────────────────────────────────────────

export type PolicySuggestionDocument = HydratedDocument<PolicySuggestion>;

@Schema({
  timestamps: true,
  collection: 'policy_suggestions',
})
export class PolicySuggestion {
  @Prop({ required: true, index: true })
  tenantId!: string;

  @Prop({ required: true, unique: true })
  suggestionId!: string;

  @Prop({ required: true, enum: SuggestionType })
  type!: SuggestionType;

  @Prop({ required: true, min: 0, max: 100 })
  confidence!: number;

  @Prop({ required: true })
  title!: string;

  @Prop({ required: true })
  description!: string;

  @Prop({ type: SuggestedPolicy, required: false })
  suggestedPolicy?: SuggestedPolicy;

  @Prop({ type: SuggestionEvidence, required: false })
  evidence?: SuggestionEvidence;

  @Prop({
    required: true,
    enum: ['pending', 'accepted', 'dismissed', 'expired'],
    default: 'pending',
  })
  status!: SuggestionStatus;

  @Prop()
  acceptedBy?: string;

  @Prop()
  dismissedBy?: string;

  @Prop()
  dismissReason?: string;

  @Prop()
  resultingPolicyId?: string;

  @Prop()
  sourcePolicyId?: string; // For REDUNDANT_POLICY, the policy that is redundant
}

export const PolicySuggestionSchema = SchemaFactory.createForClass(PolicySuggestion);

PolicySuggestionSchema.index({ type: 1, status: 1 });
PolicySuggestionSchema.index({ confidence: -1 });
PolicySuggestionSchema.index({ createdAt: -1 });
