import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import type { RevocationOutcome } from '@shared/types/access-review-revocation';

export type ReviewItemDocument = HydratedDocument<ReviewItem>;

export type ReviewDecision = 'pending' | 'approved' | 'revoked' | 'expired';

/** What revoking the entitlement did, written by the access review workflow at campaign close. */
@Schema({ _id: false })
export class ReviewRevocation {
  @Prop({
    type: String,
    required: true,
    enum: ['removed', 'already-gone', 'manual-action-needed', 'failed'],
  })
  outcome!: RevocationOutcome;

  /** What the target did or found (removed, already-gone). No personal data. */
  @Prop()
  detail?: string;

  /** Why it failed, or what an admin must do (manual-action-needed). Emails masked. */
  @Prop()
  reason?: string;

  @Prop({ required: true })
  at!: Date;
}

export const ReviewRevocationSchema = SchemaFactory.createForClass(ReviewRevocation);

@Schema({ _id: false })
export class ReviewEntitlement {
  @Prop({ required: true })
  system!: string;

  @Prop({ required: true })
  type!: string;

  @Prop({ required: true })
  name!: string;

  @Prop()
  nativeId?: string;

  @Prop({ default: false })
  policyManaged!: boolean;

  @Prop()
  riskLevel?: string;

  /**
   * The holder's account in the target when the item was generated (Entra object id, AD DN,
   * Okta or SCIM user id). Revocation removes the access of this account. Items generated
   * before this field existed have none: Entra ID then looks the account up by the email.
   */
  @Prop()
  accountId?: string;

  /** Set once the workflow has tried to revoke this entitlement (revoked or auto-expired item). */
  @Prop({ type: ReviewRevocationSchema })
  revocation?: ReviewRevocation;
}

export const ReviewEntitlementSchema = SchemaFactory.createForClass(ReviewEntitlement);

@Schema({
  timestamps: true,
  collection: 'review_items',
  optimisticConcurrency: true,
})
export class ReviewItem {
  @Prop({ required: true, index: true })
  tenantId!: string;

  @Prop({ required: true, unique: true })
  itemId!: string;

  @Prop({ required: true, index: true })
  campaignId!: string;

  @Prop({ required: true, index: true })
  identityId!: string;

  @Prop({ required: true })
  identityEmail!: string;

  @Prop({ required: true })
  identityName!: string;

  /**
   * Who decides the item: an email (manager, owner, self) or an admin id. Stored trimmed and
   * lower-cased (`trim`, `lowercase`: on create and in updates such as the escalation's), so My
   * Reviews finds it by the signed-in reviewer's email in any case, as decide compares it.
   */
  @Prop({ required: true, index: true, trim: true, lowercase: true })
  reviewerId!: string;

  @Prop({ type: [ReviewEntitlementSchema], default: [] })
  entitlements!: ReviewEntitlement[];

  @Prop({ required: true, enum: ['pending', 'approved', 'revoked', 'expired'], default: 'pending' })
  decision!: ReviewDecision;

  @Prop()
  decidedBy?: string;

  @Prop()
  decidedAt?: Date;

  @Prop()
  justification?: string;

  @Prop({ default: false })
  autoExpired!: boolean;

  /** True when reviewer is the identity themselves (self-attestation). Set by system during activation. */
  @Prop({ default: false })
  isSelfReview!: boolean;

  /** From prior campaign (carry-forward). */
  @Prop({ enum: ['APPROVED', 'REVOKED'] })
  previousDecision?: 'APPROVED' | 'REVOKED';

  @Prop()
  previousDecisionDate?: Date;

  @Prop()
  previousCampaignId?: string;

  /** Escalation: original reviewer when item was reassigned. */
  @Prop()
  escalatedFrom?: string;

  @Prop()
  escalatedAt?: Date;
}

export const ReviewItemSchema = SchemaFactory.createForClass(ReviewItem);

ReviewItemSchema.index({ campaignId: 1, decision: 1 });
ReviewItemSchema.index({ tenantId: 1, campaignId: 1, decision: 1 });
ReviewItemSchema.index({ campaignId: 1, reviewerId: 1 });
ReviewItemSchema.index({ reviewerId: 1, decision: 1 });
