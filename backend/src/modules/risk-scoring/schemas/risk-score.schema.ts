/**
 * Risk Score Schema
 *
 * Composite risk score (0-100) per identity. Calculated nightly via Temporal CronWorkflow.
 * Aggregates entitlement criticality, SoD violations, anomaly history, admin tier, dormancy.
 */

import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type RiskFactor =
  | 'entitlement_count'
  | 'high_risk_entitlements'
  | 'sod_violations'
  | 'anomaly_count'
  | 'admin_tier'
  | 'dormant'
  | 'peer_deviation';

export type RiskTrend = 'INCREASING' | 'STABLE' | 'DECREASING';

@Schema({ _id: false })
export class RiskFactorEntry {
  @Prop({ required: true })
  factor!: RiskFactor;

  @Prop({ required: true })
  weight!: number;

  @Prop({ required: true })
  rawValue!: number;

  @Prop({ required: true })
  contribution!: number;
}

export const RiskFactorEntrySchema = SchemaFactory.createForClass(RiskFactorEntry);

@Schema({ _id: false })
export class RiskScoreHistoryEntry {
  @Prop({ required: true, type: Date })
  date!: Date;

  @Prop({ required: true })
  score!: number;
}

export const RiskScoreHistoryEntrySchema = SchemaFactory.createForClass(RiskScoreHistoryEntry);

@Schema({ timestamps: true, collection: 'identity_risk_scores' })
export class IdentityRiskScore {
  @Prop({ required: true, index: true })
  tenantId!: string;

  @Prop({ required: true, index: true })
  identityId!: string;

  @Prop({ required: true, type: Number, min: 0, max: 100 })
  score!: number;

  @Prop({ type: [RiskFactorEntrySchema], default: [] })
  factors!: RiskFactorEntry[];

  @Prop({ required: true, enum: ['INCREASING', 'STABLE', 'DECREASING'] })
  trend!: RiskTrend;

  @Prop({ type: [RiskScoreHistoryEntrySchema], default: [] })
  history!: RiskScoreHistoryEntry[];

  @Prop({ required: true, type: Date })
  calculatedAt!: Date;
}

export type RiskScoreDocument = HydratedDocument<IdentityRiskScore>;
export const RiskScoreSchema = SchemaFactory.createForClass(IdentityRiskScore);

RiskScoreSchema.index({ tenantId: 1, identityId: 1 }, { unique: true });
RiskScoreSchema.index({ tenantId: 1, score: -1 });
