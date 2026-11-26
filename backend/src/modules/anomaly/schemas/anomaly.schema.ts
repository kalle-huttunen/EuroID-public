/**
 * Anomaly Schema
 *
 * Stores detected access anomalies for the anomaly detection dashboard.
 * Supports filtering by status, type, severity, and identity.
 */

import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema } from 'mongoose';

// ── Types ────────────────────────────────────────────────────────────

export type AnomalyType =
  | 'TIME_BASED'
  | 'PEER_DEVIATION'
  | 'VELOCITY'
  | 'PRIVILEGE_ESCALATION'
  | 'ORPHAN_ACCESS';

export type AnomalySeverity = 'low' | 'medium' | 'high' | 'critical';

export type AnomalyStatus = 'open' | 'acknowledged' | 'dismissed' | 'resolved';

// ── Schema ───────────────────────────────────────────────────────────

@Schema({ timestamps: true, collection: 'anomalies' })
export class Anomaly {
  @Prop({ required: true, index: true })
  tenantId!: string;

  @Prop({ required: true, type: String, unique: true })
  anomalyId!: string;

  @Prop({ required: true, type: String })
  identityId!: string;

  @Prop({ required: true, type: String })
  type!: AnomalyType;

  @Prop({ required: true, type: String })
  severity!: AnomalySeverity;

  @Prop({ required: true, type: Number, min: 0, max: 100 })
  riskScore!: number;

  @Prop({ required: true, type: String })
  title!: string;

  @Prop({ required: true, type: String })
  description!: string;

  @Prop({
    required: true,
    type: {
      events: { type: [String], default: [] },
      pattern: { type: String, default: '' },
      details: { type: MongooseSchema.Types.Mixed, default: {} },
    },
  })
  evidence!: {
    events: string[];
    pattern: string;
    details: Record<string, unknown>;
  };

  @Prop({ required: true, type: String, default: 'open', index: true })
  status!: AnomalyStatus;

  @Prop({ required: true, type: Date, default: () => new Date(), index: true })
  detectedAt!: Date;

  @Prop({ type: String })
  acknowledgedBy?: string;

  /** Who dismissed or resolved it (POST /anomalies/:id/dismiss, /resolve). */
  @Prop({ type: String })
  resolvedBy?: string;

  @Prop({ type: Date })
  resolvedAt?: Date;

  @Prop({ type: Object })
  metadata?: Record<string, unknown>;
}

export type AnomalyDocument = Anomaly & Document;
export const AnomalySchema = SchemaFactory.createForClass(Anomaly);

// ── Indexes ──────────────────────────────────────────────────────────

AnomalySchema.index({ identityId: 1, detectedAt: -1 });
AnomalySchema.index({ type: 1 });
AnomalySchema.index({ severity: 1 });
AnomalySchema.index({ status: 1, detectedAt: -1 });
