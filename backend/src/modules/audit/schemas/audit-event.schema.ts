/**
 * Audit Event Schema
 *
 * Stores every significant action that occurs in the system for compliance
 * and audit trail purposes. Supports filtering by action, severity, actor,
 * resource type, target system, and date range.
 */

import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

// ── Types ────────────────────────────────────────────────────────────

export type AuditAction =
  | 'USER_CREATED'
  | 'USER_UPDATED'
  | 'USER_DELETED'
  | 'POLICY_CREATED'
  | 'POLICY_UPDATED'
  | 'POLICY_DELETED'
  | 'POLICY_TOGGLED'
  | 'PROVISIONING_EXECUTED'
  | 'PROVISIONING_FAILED'
  | 'RECONCILIATION_RUN'
  | 'DRIFT_CORRECTED'
  | 'BULK_OPERATION_STARTED'
  | 'BULK_OPERATION_COMPLETED'
  | 'CONNECTOR_INSTALLED'
  | 'CONNECTOR_REMOVED'
  | 'CONFIG_CHANGED'
  | 'APPROVAL_GRANTED'
  | 'APPROVAL_DENIED'
  | 'EMERGENCY_ACCESS'
  | 'DATA_EXPORTED'
  | 'BULK_QUERY_EXECUTED'
  | 'PII_REVEALED'
  | 'GDPR_ERASURE_EXECUTED'
  | 'AUDIT_CHECKPOINT_CREATED'
  // Domain event types (from Event Bus)
  | 'identity.created'
  | 'identity.updated'
  | 'identity.deleted'
  | 'identity.status_changed'
  | 'provisioning.started'
  | 'provisioning.completed'
  | 'provisioning.failed'
  | 'policy.evaluated'
  | 'drift.detected'
  | 'drift.resolved'
  | (string & {}); // Allow any domain event type for future extensibility

export type AuditSeverity = 'info' | 'warning' | 'error' | 'critical';

// ── Schema ───────────────────────────────────────────────────────────

@Schema({ timestamps: true, collection: 'audit_events' })
export class AuditEvent {
  @Prop({ required: true, type: String })
  action!: AuditAction;

  @Prop({ required: true, type: String, default: 'info' })
  severity!: AuditSeverity;

  @Prop({ required: true, type: Date, default: () => new Date() })
  timestamp!: Date;

  /** Actor: user email, system name, or "Temporal Worker" */
  @Prop({ required: true, type: String, index: true })
  actor!: string;

  /** Resource type: "user", "policy", "connector", "workflow" */
  @Prop({ required: true, type: String, index: true })
  resourceType!: string;

  /** Resource identifier (user ID, policy ID, etc.) */
  @Prop({ required: true, type: String })
  resourceId!: string;

  /** Human-readable resource name */
  @Prop({ required: true, type: String })
  resourceName!: string;

  /** Target system involved, if any (e.g., "Microsoft Entra ID") */
  @Prop({ type: String })
  targetSystem?: string;

  /** Human-readable description */
  @Prop({ required: true, type: String })
  description!: string;

  /** Change payload (before/after for updates) */
  @Prop({ type: Object })
  payload?: {
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  };

  /** IP address or request source */
  @Prop({ type: String })
  source?: string;

  /** Tenant identifier for multi-tenancy */
  @Prop({ type: String, required: true })
  tenantId!: string;

  /**
   * The domain event this entry records (AuditEventHandler), one entry per event: a redelivered
   * event writes none. Absent on entries written directly and on entries from before it.
   */
  @Prop({ type: String })
  eventId?: string;

  /**
   * Position in the tenant's hash chain (1, 2, 3, ...), set by AuditService through the chain
   * head. Absent on events written before it: those are ordered by time.
   */
  @Prop({ type: Number })
  seq?: number;

  /** How integrityHash was computed (audit-hash.ts): 2 covers every field; absent means 1. */
  @Prop({ type: Number })
  hashVersion?: number;

  /** SHA-256 hash chain: hash of (previousHash + canonical event JSON), see audit-hash.ts */
  @Prop({ type: String, index: true })
  integrityHash!: string;

  /** integrityHash of the preceding event in this tenant's chain */
  @Prop({ type: String })
  previousHash!: string;
}

export type AuditEventDocument = AuditEvent & Document;
export const AuditEventSchema = SchemaFactory.createForClass(AuditEvent);

// ── Indexes ──────────────────────────────────────────────────────────

AuditEventSchema.index({ action: 1 });
AuditEventSchema.index({ severity: 1 });
AuditEventSchema.index({ tenantId: 1, timestamp: -1 });
AuditEventSchema.index({ resourceType: 1, resourceId: 1 });
// One entry per domain event; entries without eventId are not in the index
AuditEventSchema.index(
  { tenantId: 1, eventId: 1 },
  { unique: true, partialFilterExpression: { eventId: { $type: 'string' } } },
);
// One event per chain position: of two writers that took the same position, one stores its event
// and the other moves on to the next position. Events without seq are not in the index.
AuditEventSchema.index(
  { tenantId: 1, seq: 1 },
  { unique: true, partialFilterExpression: { seq: { $type: 'number' } } },
);
// TTL index: retention + 30-day buffer so archival workflow can export before auto-delete
const auditRetentionDays = parseInt(process.env.AUDIT_RETENTION_DAYS || '365', 10);
const auditTtlSeconds = (auditRetentionDays + 30) * 86400;
AuditEventSchema.index({ timestamp: 1 }, { expireAfterSeconds: auditTtlSeconds });
// Text index for full-text search (actor, description, resourceName). Weights: actor=3, resourceName=2, description=1.
AuditEventSchema.index(
  { actor: 'text', description: 'text', resourceName: 'text' },
  {
    name: 'audit_text_search',
    weights: { actor: 3, resourceName: 2, description: 1 },
    default_language: 'none',
  },
);

// --- TASK_104 recap: Text index on actor, description, resourceName for $text search. Weights: actor=3, resourceName=2, description=1.
// --- TASK_101: Added EMERGENCY_ACCESS to AuditAction.
