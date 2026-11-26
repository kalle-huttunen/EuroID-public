/**
 * Drift Schema
 *
 * Persists drift records detected by the reconciliation workflow.
 * Supports the Drift Dashboard with filtering, auto-correct, and bulk actions.
 */

import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

// ── Types ────────────────────────────────────────────────────────────

export type DriftType =
  | 'MISSING_USER'
  | 'ORPHANED_USER'
  | 'ORPHAN_ACCOUNT'
  | 'FIELD_MISMATCH'
  | 'STATUS_MISMATCH'
  | 'GROUP_MISMATCH'
  | 'LICENSE_MISMATCH';

export type DriftSeverity = 'low' | 'medium' | 'high' | 'critical';

export type DriftStatus = 'open' | 'corrected' | 'ignored' | 'quarantined';

export interface OrphanDetails {
  targetSystem: string;
  externalId: string;
  accountName?: string;
  discoveredAt: Date;
  gracePeriodEndsAt?: Date;
  disabledAt?: Date;
  decision?: 'DELETE' | 'ADOPT';
  decidedBy?: string;
  adoptedIdentityId?: string;
  /** Why EuroID keeps the account instead of deleting it (an AD orphan: orphan-delete-policy). */
  keptReason?: string;
}

// ── Schema ───────────────────────────────────────────────────────────

@Schema({ timestamps: true, collection: 'drift_records' })
export class Drift {
  @Prop({ required: true, index: true })
  tenantId!: string;

  @Prop({ required: true, type: String })
  type!: DriftType;

  @Prop({ required: true, type: String })
  severity!: DriftSeverity;

  @Prop({ required: true, type: String, index: true })
  userId!: string;

  @Prop({ required: true, type: String })
  userDisplayName!: string;

  @Prop({ required: true, type: String })
  userEmail!: string;

  @Prop({ required: true, type: String, index: true })
  targetSystem!: string;

  /** The field that drifted (e.g., "jobTitle", "department") */
  @Prop({ type: String })
  field?: string;

  /** What the Hub says the value should be */
  @Prop({ type: String })
  hubValue?: string;

  /** What the target system currently has */
  @Prop({ type: String })
  targetValue?: string;

  @Prop({ required: true, type: Date, default: () => new Date() })
  detectedAt!: Date;

  @Prop({ type: Boolean, default: false })
  autoCorrectEligible!: boolean;

  @Prop({ type: String, default: 'open', index: true })
  status!: DriftStatus;

  @Prop({ type: Date })
  correctedAt?: Date;

  /** The workflow run that detected this drift */
  @Prop({ type: String })
  workflowId?: string;

  /** Orphan-specific data (for type=ORPHAN_ACCOUNT) */
  @Prop({
    type: {
      targetSystem: String,
      externalId: String,
      accountName: String,
      discoveredAt: Date,
      gracePeriodEndsAt: Date,
      disabledAt: Date,
      decision: String,
      decidedBy: String,
      adoptedIdentityId: String,
      keptReason: String,
    },
  })
  orphanDetails?: OrphanDetails;
}

export type DriftDocument = Drift & Document;
export const DriftSchema = SchemaFactory.createForClass(Drift);

// ── Indexes ──────────────────────────────────────────────────────────

DriftSchema.index({ tenantId: 1, userId: 1, detectedAt: -1 });
DriftSchema.index({ severity: 1 });
DriftSchema.index({ status: 1, severity: 1 });
DriftSchema.index({ userId: 1, targetSystem: 1 });
DriftSchema.index({ tenantId: 1, status: 1, severity: 1, targetSystem: 1 });
DriftSchema.index({ 'orphanDetails.targetSystem': 1, 'orphanDetails.externalId': 1 });
