import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import type { ReviewExclusionScope } from '../review-exclusion-match';

export type ReviewExclusionDocument = HydratedDocument<ReviewExclusion>;

export type ReviewExclusionStatus = 'active' | 'lifted';

/** A policy that granted the excluded entitlement when the review closed. */
@Schema({ _id: false })
export class ReviewExclusionPolicy {
  @Prop({ required: true })
  policyId!: string;

  /** The policy's name then (a later rename does not change it). */
  @Prop({ required: true })
  policyName!: string;
}

export const ReviewExclusionPolicySchema = SchemaFactory.createForClass(ReviewExclusionPolicy);

/**
 * A revoke in an access review, kept as a durable exception (review-exclusion.service.ts): while
 * it is active the policy engine leaves the entitlement (or, for an account item, every grant in
 * the system) out of the identity's intent. Written when the campaign closes
 * (AccessReviewRevocationActivities.listRevocationTasks), lifted only by a policy-admin. Lifted
 * exclusions stay as the record of the decision.
 */
@Schema({ timestamps: true, collection: 'review_exclusions' })
export class ReviewExclusion {
  @Prop({ required: true, index: true })
  tenantId!: string;

  @Prop({ required: true })
  identityId!: string;

  /** The system as the review named it (entra-id, ad, okta, scim, github, ...). */
  @Prop({ required: true })
  targetSystem!: string;

  /** systemKey(targetSystem): how the engine compares it with an operation's target. */
  @Prop({ required: true })
  systemKey!: string;

  /** entitlement: one group, role or license; account: every grant in the system. */
  // type: String: an imported union has no design:type when a file is transpiled on its own
  @Prop({ type: String, required: true, enum: ['entitlement', 'account'] })
  scope!: ReviewExclusionScope;

  /** The review entitlement type (group, directory-role, app-group, license, account, ...). */
  @Prop({ required: true })
  entitlementType!: string;

  @Prop({ required: true })
  entitlementName!: string;

  /** The entitlement's id in the target (group object id, DN, Okta or SCIM group id). */
  @Prop()
  entitlementId?: string;

  /** exclusionKey: one active exclusion per identity, system and this key ('*': the account). */
  @Prop({ required: true })
  entitlementKey!: string;

  @Prop({ required: true })
  campaignId!: string;

  @Prop({ required: true })
  campaignName!: string;

  @Prop({ required: true })
  itemId!: string;

  /** revoked: a reviewer revoked it; expired: not reviewed by the deadline, auto-revoked. */
  @Prop({ type: String, required: true, enum: ['revoked', 'expired'] })
  decision!: 'revoked' | 'expired';

  /** The reviewer who revoked it; none for an expired item the campaign auto-revoked. */
  @Prop()
  reviewer?: string;

  @Prop()
  justification?: string;

  @Prop()
  decidedAt?: Date;

  /** The active policies whose operations it suppressed when it was recorded. */
  @Prop({ type: [ReviewExclusionPolicySchema], default: [] })
  grantingPolicies!: ReviewExclusionPolicy[];

  @Prop({ type: String, required: true, enum: ['active', 'lifted'], default: 'active' })
  status!: ReviewExclusionStatus;

  /** The policy-admin who lifted it, or 'system' (the identity's offboarding completed). */
  @Prop()
  liftedBy?: string;

  @Prop()
  liftedAt?: Date;

  /** Why the system lifted it ('identity offboarded'); none for an admin's lift. */
  @Prop()
  liftReason?: string;

  /** Set by `timestamps`: when the campaign close recorded it. */
  createdAt?: Date;
  updatedAt?: Date;
}

export const ReviewExclusionSchema = SchemaFactory.createForClass(ReviewExclusion);

ReviewExclusionSchema.index({ tenantId: 1, identityId: 1, status: 1 });
// One active exclusion per identity, system and entitlement: a retried close or a second
// campaign revoking the same access keeps the first
ReviewExclusionSchema.index(
  { tenantId: 1, identityId: 1, systemKey: 1, entitlementKey: 1 },
  { unique: true, partialFilterExpression: { status: 'active' } },
);
ReviewExclusionSchema.index({ tenantId: 1, 'grantingPolicies.policyId': 1 });
