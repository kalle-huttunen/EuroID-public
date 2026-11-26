/**
 * Reviewer Quality Score Schema
 *
 * Tracks reviewer behavior per campaign: approval rate, decision speed,
 * bulk approvals, and missing justifications. Used by rubber-stamp detection (F-12).
 */

import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type ReviewerQualityDocument = HydratedDocument<ReviewerQualityScore>;

@Schema({ _id: false })
export class ReviewerSignals {
  @Prop({ required: true, type: Number, min: 0, max: 1 })
  approvalRate!: number;

  @Prop({ required: true, type: Number, min: 0 })
  avgDecisionTimeSeconds!: number;

  @Prop({ required: true, type: Number, min: 0 })
  bulkApproveCount!: number;

  @Prop({ required: true, type: Number, min: 0, max: 1 })
  noJustificationRate!: number;
}

export const ReviewerSignalsSchema = SchemaFactory.createForClass(ReviewerSignals);

@Schema({ timestamps: true, collection: 'reviewer_quality_scores' })
export class ReviewerQualityScore {
  @Prop({ required: true, index: true })
  tenantId!: string;

  @Prop({ required: true })
  reviewerId!: string;

  @Prop({ required: true })
  campaignId!: string;

  @Prop({ required: true, type: Number, min: 0, max: 100 })
  qualityScore!: number;

  @Prop({ type: ReviewerSignalsSchema, required: true })
  signals!: ReviewerSignals;

  @Prop({ type: [String], default: [] })
  flaggedDecisions!: string[];

  /**
   * The average decision time under which the score lost 25 points
   * (INTELLIGENCE_RUBBER_STAMP_THRESHOLD_MS when scored). Absent on a score from before it was
   * recorded, which used 30 seconds.
   */
  @Prop({ type: Number, min: 0 })
  decisionTimeThresholdSeconds?: number;

  /**
   * The bulk approval rule the score used: this many approvals within bulkApproveWindowMinutes
   * cost 20 points (INTELLIGENCE_BULK_APPROVE_WINDOW_COUNT when scored, and 5 minutes). Absent on a
   * score from before they were recorded, which used 10 approvals within 5 minutes.
   */
  @Prop({ type: Number, min: 1 })
  bulkApproveWindowCount?: number;

  @Prop({ type: Number, min: 0 })
  bulkApproveWindowMinutes?: number;

  @Prop({ required: true, type: Date })
  calculatedAt!: Date;
}

export const ReviewerQualityScoreSchema = SchemaFactory.createForClass(ReviewerQualityScore);

ReviewerQualityScoreSchema.index({ tenantId: 1, reviewerId: 1, campaignId: 1 }, { unique: true });
ReviewerQualityScoreSchema.index({ tenantId: 1, qualityScore: 1 });
