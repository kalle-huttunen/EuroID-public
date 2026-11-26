/**
 * Transaction Log Schema
 *
 * Records distributed 2-phase commit transactions for the Transaction Viewer.
 * Each document captures the phases, system participants, and outcomes. The API records the
 * transaction when it starts it; DistributedTransactionActivities update the phase and the
 * participants at each phase transition (updateTransactionPhase).
 */

import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

// ── Types ────────────────────────────────────────────────────────────

/** ROLLBACK_FAILED: the rollback ran, but a committed system could not be restored. */
export const TRANSACTION_PHASES = [
  'PREPARING',
  'PREPARED',
  'COMMITTING',
  'COMMITTED',
  'ROLLING_BACK',
  'ROLLED_BACK',
  'ROLLBACK_FAILED',
  'FAILED',
] as const;

export type TransactionPhase = (typeof TRANSACTION_PHASES)[number];

/** Phases after which the transaction does nothing more (completedAt is set). */
export const TERMINAL_TRANSACTION_PHASES: readonly TransactionPhase[] = [
  'COMMITTED',
  'ROLLED_BACK',
  'ROLLBACK_FAILED',
  'FAILED',
];

/** ROLLBACK_FAILED: committed, and the restore failed, so the change is still in place. */
export type SystemParticipationStatus =
  | 'PREPARING'
  | 'PREPARED'
  | 'COMMITTED'
  | 'ROLLED_BACK'
  | 'ROLLBACK_FAILED'
  | 'FAILED';

// ── Sub-document ─────────────────────────────────────────────────────

export interface SystemParticipant {
  systemName: string;
  status: SystemParticipationStatus;
  preparedAt?: string;
  committedAt?: string;
  rolledBackAt?: string;
  error?: string;
  durationMs?: number;
}

// ── Schema ───────────────────────────────────────────────────────────

@Schema({ timestamps: true, collection: 'transaction_logs' })
export class TransactionLog {
  @Prop({ required: true, index: true })
  tenantId!: string;

  @Prop({ required: true, type: String, unique: true, index: true })
  transactionId!: string;

  @Prop({ required: true, type: String })
  workflowId!: string;

  @Prop({ required: true, type: String, default: 'PREPARING' })
  phase!: TransactionPhase;

  @Prop({ required: true, type: String })
  operation!: string;

  @Prop({ required: true, type: Date })
  startedAt!: Date;

  @Prop({ type: Date })
  completedAt?: Date;

  @Prop({ required: true, type: String })
  initiatedBy!: string;

  @Prop({ type: String })
  targetUser?: string;

  @Prop({ type: Array, default: [] })
  participants!: SystemParticipant[];

  @Prop({ type: Boolean, default: true })
  autoRollback!: boolean;

  @Prop({ type: Number, default: 300000 })
  timeout!: number;

  @Prop({ type: String })
  notes?: string;
}

export type TransactionLogDocument = TransactionLog & Document;
export const TransactionLogSchema = SchemaFactory.createForClass(TransactionLog);

// ── Indexes ──────────────────────────────────────────────────────────

TransactionLogSchema.index({ phase: 1 });
TransactionLogSchema.index({ startedAt: -1 });

// TTL: expire transaction logs after retention period (configurable via WORKFLOW_RETENTION_DAYS)
const txRetentionDays = parseInt(process.env.WORKFLOW_RETENTION_DAYS || '90', 10);
TransactionLogSchema.index({ startedAt: 1 }, { expireAfterSeconds: txRetentionDays * 86400 });
