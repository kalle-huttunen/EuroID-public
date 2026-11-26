import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

/**
 * ReconciliationConfig — Per-tenant configuration for the reconciliation engine.
 *
 * Controls which connectors are HR sources, field mastery priority, contract-critical
 * fields, and target ID keys. No hardcoded defaults; tenants must configure explicitly.
 */
@Schema({ timestamps: true, collection: 'reconciliation_configs' })
export class ReconciliationConfig {
  @Prop({ required: true, unique: true, index: true })
  tenantId!: string;

  /** Connector names considered HR sources (e.g., ['workday', 'csv-hr', 'personio']). */
  @Prop({ type: [String], required: true })
  hrSourceTags!: string[];

  /** Global source priority order. Lower index = higher priority. */
  @Prop({ type: [String], required: true })
  sourcePriorityOrder!: string[];

  /** Fields only the primary HR source can set (unless explicitly mastered). */
  @Prop({ type: [String], required: true })
  contractCriticalFields!: string[];

  /** Per-field mastery: field name -> ordered list of authoritative source names. */
  @Prop({ type: Object, required: true })
  defaultMastery!: Record<string, string[]>;

  /** Target-specific ID keys that go to customAttributes, not root profile. */
  @Prop({ type: [String], required: true })
  targetIdKeys!: string[];
}

export type ReconciliationConfigDocument = ReconciliationConfig & Document;
export const ReconciliationConfigSchema = SchemaFactory.createForClass(ReconciliationConfig);
