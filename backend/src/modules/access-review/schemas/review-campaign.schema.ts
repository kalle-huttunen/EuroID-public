import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type ReviewCampaignDocument = HydratedDocument<ReviewCampaign>;

export enum CampaignStatus {
  DRAFT = 'DRAFT',
  ACTIVE = 'ACTIVE',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
}

export type ScopeType = 'department' | 'role' | 'system' | 'all';

@Schema({ _id: false })
export class CampaignScope {
  @Prop({ required: true, enum: ['department', 'role', 'system', 'all'] })
  type!: ScopeType;

  @Prop()
  value?: string;
}

export const CampaignScopeSchema = SchemaFactory.createForClass(CampaignScope);

@Schema({ _id: false })
export class CampaignStats {
  @Prop({ default: 0 })
  totalItems!: number;

  @Prop({ default: 0 })
  approved!: number;

  @Prop({ default: 0 })
  revoked!: number;

  @Prop({ default: 0 })
  pending!: number;

  @Prop({ default: 0 })
  expired!: number;
}

export const CampaignStatsSchema = SchemaFactory.createForClass(CampaignStats);

/** Outcome counts of the campaign's revocations, set when the campaign completes. */
@Schema({ _id: false })
export class CampaignRevocationSummary {
  @Prop({ default: 0 })
  removed!: number;

  @Prop({ default: 0 })
  alreadyGone!: number;

  @Prop({ default: 0 })
  manualActionNeeded!: number;

  @Prop({ default: 0 })
  failed!: number;
}

export const CampaignRevocationSummarySchema =
  SchemaFactory.createForClass(CampaignRevocationSummary);

export type RecurrenceFrequency = 'MONTHLY' | 'QUARTERLY' | 'SEMI_ANNUAL' | 'ANNUAL';
export type EscalateTo = 'MANAGER' | 'ADMIN';

@Schema({ _id: false })
export class CampaignRecurrence {
  @Prop({ default: false })
  enabled!: boolean;

  @Prop({ enum: ['MONTHLY', 'QUARTERLY', 'SEMI_ANNUAL', 'ANNUAL'] })
  frequency?: RecurrenceFrequency;

  @Prop()
  nextRunAt?: Date;

  @Prop()
  previousCampaignId?: string;
}

export const CampaignRecurrenceSchema = SchemaFactory.createForClass(CampaignRecurrence);

@Schema({ _id: false })
export class CampaignEscalation {
  @Prop({ default: false })
  enabled!: boolean;

  @Prop({ default: 7 })
  escalateAfterDays!: number;

  @Prop({ enum: ['MANAGER', 'ADMIN'] })
  escalateTo!: EscalateTo;
}

export const CampaignEscalationSchema = SchemaFactory.createForClass(CampaignEscalation);

@Schema({
  timestamps: true,
  collection: 'review_campaigns',
})
export class ReviewCampaign {
  @Prop({ required: true, index: true })
  tenantId!: string;

  @Prop({ required: true, unique: true })
  campaignId!: string;

  @Prop({ required: true })
  name!: string;

  @Prop()
  description?: string;

  @Prop({ type: CampaignScopeSchema, required: true })
  scope!: CampaignScope;

  /**
   * Employment types to include in the campaign. Default: human types only.
   * Include 'SERVICE_ACCOUNT' or 'ADMIN_ACCOUNT' to review machine identities.
   */
  @Prop({
    type: [String],
    default: () => ['FULL_TIME', 'PART_TIME', 'CONTRACTOR', 'INTERN', 'CONSULTANT'],
  })
  targetEmploymentTypes!: string[];

  @Prop({ required: true, enum: Object.values(CampaignStatus), default: CampaignStatus.DRAFT })
  status!: CampaignStatus;

  @Prop({ required: true })
  createdBy!: string;

  @Prop({ required: true })
  deadline!: Date;

  @Prop({ default: false })
  autoRevokeOnExpiry!: boolean;

  @Prop({ default: false })
  allowSelfReview!: boolean;

  @Prop({ type: [String], default: ['LOW'] })
  selfReviewRiskLevels!: string[];

  @Prop({
    type: CampaignStatsSchema,
    default: () => ({ totalItems: 0, approved: 0, revoked: 0, pending: 0, expired: 0 }),
  })
  stats!: CampaignStats;

  @Prop()
  workflowId?: string;

  /**
   * When an activation claimed this DRAFT campaign, renewed while it generates items
   * (review-campaign-activation.ts); absent when none runs. Cleared when the activation ends,
   * either way.
   */
  @Prop()
  activationStartedAt?: Date;

  /**
   * The activation that holds the claim, or that made the campaign ACTIVE
   * (review-campaign-activation.ts): its later writes name it, so an activation that lost its
   * claim changes nothing of the one that took over. Absent on campaigns activated before it.
   */
  @Prop()
  activationId?: string;

  @Prop()
  completedAt?: Date;

  /** Absent when nothing was revoked (or the campaign completed before revocation results). */
  @Prop({ type: CampaignRevocationSummarySchema })
  revocationSummary?: CampaignRevocationSummary;

  @Prop({ type: CampaignRecurrenceSchema })
  recurrence?: CampaignRecurrence;

  @Prop({ type: CampaignEscalationSchema })
  escalation?: CampaignEscalation;

  @Prop()
  templateCampaignId?: string;
}

export const ReviewCampaignSchema = SchemaFactory.createForClass(ReviewCampaign);

ReviewCampaignSchema.index({ status: 1 });
ReviewCampaignSchema.index({ tenantId: 1, status: 1 });
ReviewCampaignSchema.index({ createdBy: 1 });
ReviewCampaignSchema.index({ deadline: 1 });
ReviewCampaignSchema.index({ 'scope.type': 1, 'scope.value': 1 });
ReviewCampaignSchema.index({ 'recurrence.enabled': 1, 'recurrence.nextRunAt': 1, status: 1 });
