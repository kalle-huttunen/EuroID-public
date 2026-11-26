/**
 * Risk Score Schema
 *
 * Stores computed risk scores per identity for quick lookup and sorting.
 * Updated when anomalies are detected or resolved.
 */

import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

@Schema({ timestamps: true, collection: 'risk_scores' })
export class RiskScore {
  @Prop({ required: true, type: String, unique: true })
  identityId!: string;

  @Prop({ required: true, type: Number, min: 0, max: 100 })
  riskScore!: number;

  @Prop({ required: true, type: Date, default: () => new Date() })
  updatedAt!: Date;
}

export type RiskScoreDocument = RiskScore & Document;
export const RiskScoreSchema = SchemaFactory.createForClass(RiskScore);

RiskScoreSchema.index({ riskScore: -1 });
