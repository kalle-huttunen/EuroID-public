/**
 * Connector Config Schema
 *
 * Persists connector installation state and configuration (secrets, tenant IDs, etc.).
 * Replaces the frontend-only Zustand/localStorage approach with server-side storage.
 */

import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

@Schema({ timestamps: true, collection: 'connector_configs' })
export class ConnectorConfig {
  @Prop({ required: true, index: true })
  tenantId!: string;

  /** Canonical connector name (e.g., "Microsoft Entra ID", "Active Directory") */
  @Prop({ required: true, type: String, index: true })
  connectorName!: string;

  /** Configuration key-value pairs (tenantId, clientId, clientSecret, etc.) — legacy plaintext */
  @Prop({ type: Object })
  config!: Record<string, string>;

  /** Encrypted config blob (preferred). When present, config is ignored. */
  @Prop({ type: String })
  configEncrypted!: string;

  /** ISO timestamp when the connector was first installed */
  @Prop({ type: Date, default: () => new Date() })
  installedAt!: Date;

  /** ISO timestamp of last config update */
  @Prop({ type: Date })
  updatedAt!: Date;

  /** Email or identifier of the admin who installed it */
  @Prop({ type: String, default: 'admin' })
  installedBy!: string;

  /** Whether the connector is actively in use */
  @Prop({ type: String, enum: ['active', 'disabled'], default: 'active' })
  status!: 'active' | 'disabled';

  /** When was the last successful sync? */
  @Prop({ type: Date })
  lastSyncAt!: Date;

  /** Status of the last sync */
  @Prop({ type: String, enum: ['success', 'failed', 'running'] })
  lastSyncStatus!: 'success' | 'failed' | 'running';

  /** When the sync was started (for stale lock detection — auto-release after 30min) */
  @Prop({ type: Date })
  lastSyncStartedAt!: Date;

  /** Error message if last sync failed */
  @Prop({ type: String })
  lastSyncError!: string;

  /** Number of items synced (users for HR, entitlements for discovery) */
  @Prop({ type: Number })
  lastSyncCount!: number;

  // ─── HR Source: Priority & Mastery (not encrypted) ────────────────────────

  /** Numeric ingest priority. Lower = higher priority. Default: 1 for first HR source. */
  @Prop({ type: Number })
  ingestPriority!: number;

  /** Contract tag: PRIMARY or SECONDARY. Drives contractType on ingested records. */
  @Prop({ type: String, enum: ['PRIMARY', 'SECONDARY'] })
  contractTag!: 'PRIMARY' | 'SECONDARY';

  /** List of Golden Record fields this source is authoritative for. */
  @Prop({ type: [String], default: undefined })
  masteryFields!: string[];
}

export type ConnectorConfigDocument = ConnectorConfig & Document;
export const ConnectorConfigSchema = SchemaFactory.createForClass(ConnectorConfig);

ConnectorConfigSchema.index({ tenantId: 1, connectorName: 1 }, { unique: true });
