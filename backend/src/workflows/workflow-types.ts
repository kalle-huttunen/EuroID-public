/**
 * Workflow-safe types for Temporal workflows.
 *
 * PURE TYPES ONLY — no NestJS, Zod, or Node built-ins.
 * Workflows run in a V8 isolate and cannot import from shared DTOs that use
 * @anatine/zod-nestjs, @nestjs/swagger, etc.
 *
 * These types mirror the shapes from shared/dtos for workflow input/output.
 * Activities convert between API DTOs and these types at the boundary.
 */

import type { UserPayload } from '../shared/types/user-payload';

/** User shape for workflow payloads — no NestJS deps. */
export type WorkflowUser = UserPayload;

// ============================================================
// Distributed Transaction (from distributed-transaction.dto)
// ============================================================

export enum TransactionPhase {
  PREPARING = 'PREPARING',
  PREPARED = 'PREPARED',
  COMMITTING = 'COMMITTING',
  COMMITTED = 'COMMITTED',
  ROLLING_BACK = 'ROLLING_BACK',
  ROLLED_BACK = 'ROLLED_BACK',
  /** The rollback ran, but one or more committed systems could not be restored. */
  ROLLBACK_FAILED = 'ROLLBACK_FAILED',
  FAILED = 'FAILED',
}

export enum SystemTransactionStatus {
  PENDING = 'PENDING',
  PREPARED = 'PREPARED',
  COMMITTED = 'COMMITTED',
  ROLLED_BACK = 'ROLLED_BACK',
  /** Committed, and the restore to the previous state failed: the change is still in place. */
  ROLLBACK_FAILED = 'ROLLBACK_FAILED',
  FAILED = 'FAILED',
}

export interface DistributedTransactionRequest {
  transactionId: string;
  user: WorkflowUser;
  targetSystems: string[];
  operation: 'CREATE' | 'UPDATE' | 'DELETE';
  tenantId?: string;
  timeout?: number;
  autoRollback?: boolean;
  initiatedBy: string;
  notes?: string;
}

export interface SystemTransaction {
  system: string;
  status: SystemTransactionStatus;
  preparedAt?: Date;
  committedAt?: Date;
  rolledBackAt?: Date;
  previousState?: Record<string, unknown>;
  error?: string;
  lockId?: string;
  lockAcquiredAt?: Date;
}

export interface DistributedTransactionResult {
  transactionId: string;
  success: boolean;
  phase: TransactionPhase;
  /** Keyed by system; a plain object because Temporal serialises a Map to {}. */
  systems: Record<string, SystemTransaction>;
  startedAt: Date;
  completedAt: Date;
  durationMs: number;
  prepareSuccess: boolean;
  commitSuccess: boolean;
  rolledBack: boolean;
  error?: string;
}

export enum DriftType {
  MISSING_USER = 'MISSING_USER',
  ORPHANED_USER = 'ORPHANED_USER',
  FIELD_MISMATCH = 'FIELD_MISMATCH',
  STATUS_MISMATCH = 'STATUS_MISMATCH',
  GROUP_MISMATCH = 'GROUP_MISMATCH',
  LICENSE_MISMATCH = 'LICENSE_MISMATCH',
}

export interface UserSnapshot {
  system: string;
  userId: string;
  email: string;
  state: Record<string, unknown>;
  capturedAt: Date;
  version?: string;
  hash?: string;
}

export interface SystemDrift {
  system: string;
  driftType: DriftType;
  field?: string;
  expectedValue?: unknown;
  actualValue?: unknown;
  description: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  autoCorrect: boolean;
}

export interface DriftDetectionResult {
  userId: string;
  email: string;
  hasDrift: boolean;
  hubState: WorkflowUser;
  systemStates: Map<string, UserSnapshot>;
  drifts: SystemDrift[];
  /** Target systems whose account could not be read, with the reason (no drift for them). */
  systemErrors?: Array<{ system: string; error: string }>;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  detectedAt: Date;
}

export interface ReconciliationReport {
  reportId: string;
  tenantId: string;
  totalUsers: number;
  scannedUsers: number;
  usersWithDrift: number;
  totalDrifts: number;
  /** Drifts per severity, each drift once: the four add up to totalDrifts. */
  criticalDrifts: number;
  highDrifts: number;
  mediumDrifts: number;
  lowDrifts: number;
  driftsByType: Map<DriftType, number>;
  driftsBySystem: Map<string, number>;
  autoCorrected: number;
  requiresManualReview: number;
  startedAt: Date;
  completedAt: Date;
  durationMs: number;
  drifts: DriftDetectionResult[];
  /** The drift thresholds of the run's settings it reached; absent when none was. */
  alerts?: ReconciliationAlert[]; /** The systems whose orphan detection (or cleanup start) failed, with why; absent: none. */
  orphanDetectionFailures?: OrphanDetectionFailure[];
}

/** A target system whose orphan detection failed in a reconciliation run. */
export interface OrphanDetectionFailure {
  system: string;
  error: string;
}

/** A drift threshold of ReconciliationConfig a run reached (reconciliation-alerts.ts). */
export interface ReconciliationAlert {
  /** maxDriftsBeforeAlert counts every drift, criticalDriftAlertThreshold the CRITICAL ones. */
  threshold: 'maxDriftsBeforeAlert' | 'criticalDriftAlertThreshold';
  limit: number;
  found: number;
}

/**
 * What dailyReconciliationWorkflow hands notifyDriftThresholdExceeded: the run's ids and counts
 * (the event's payload), and the address to mail when the run named one.
 */
export interface DriftThresholdNotice {
  workflowId: string;
  runId: string;
  totalDrifts: number;
  criticalDrifts: number;
  alerts: ReconciliationAlert[];
  notifyEmail?: string;
}

export interface CorrectionAction {
  driftId: string;
  system: string;
  action: 'CREATE' | 'UPDATE' | 'DELETE' | 'DISABLE' | 'ENABLE';
  user: WorkflowUser;
  success: boolean;
  error?: string;
  executedAt: Date;
}

export interface ReconciliationBatchResult {
  drifts: DriftDetectionResult[];
  corrections: CorrectionAction[];
  usersScanned: number;
  errors?: string[];
}

export interface ReconciliationConfig {
  tenantId: string;
  /**
   * Runs start on request; nothing schedules one. The API refuses cronSchedule and
   * enabled: false; runs started before that may carry them, and nothing reads them.
   */
  enabled?: boolean;
  cronSchedule?: string;
  targetSystems: string[];
  /** The scan scope (shared/utils/reconciliation-scope.ts): absent or empty, every department. */
  includedDepartments?: string[];
  /** Identity ids or emails the run never scans or corrects (reconciliation-scope.ts). */
  excludedUsers?: string[];
  autoCorrect: boolean;
  autoCorrectTypes: DriftType[];
  requireApprovalForDeletes: boolean;
  /** A threshold reached: emit reconciliation.drift_threshold_exceeded (and mail notifyEmail). */
  notifyOnDrift: boolean;
  /** A user of the tenant (admin user or identity, by email) to mail when a threshold is reached. */
  notifyEmail?: string;
  /** 0 = off. */
  maxDriftsBeforeAlert: number;
  /** 0 = off. */
  criticalDriftAlertThreshold: number;
}

// ============================================================
// Bulk Operation (from bulk-operation.dto)
// ============================================================

export enum BulkOperationType {
  CREATE = 'CREATE',
  UPDATE = 'UPDATE',
  DELETE = 'DELETE',
  DISABLE = 'DISABLE',
}

export enum OperationPriority {
  LOW = 'LOW',
  NORMAL = 'NORMAL',
  HIGH = 'HIGH',
  CRITICAL = 'CRITICAL',
}

export interface BulkOperation {
  id: string;
  type: BulkOperationType;
  user: WorkflowUser;
  targetSystems: string[];
  priority: OperationPriority;
  requiresApproval?: boolean;
  metadata?: Record<string, unknown>;
}

export interface BulkOperationRequest {
  batchId: string;
  tenantId: string;
  operations: BulkOperation[];
  dryRun?: boolean;
  continueOnError?: boolean;
  batchSize?: number;
  requireApprovalForDeletes?: boolean;
  initiatedBy: string;
  notes?: string;
  /** Delay between batches in ms (default 500) */
  batchDelayMs?: number;
  /** Delete approval wait timeout, e.g. '1 hour' (default '1 hour') */
  deleteApprovalTimeout?: string;
  /** Delete approval wait timeout in ms (overrides deleteApprovalTimeout when set) */
  deleteApprovalTimeoutMs?: number;
  /** Delay between sequential deletes in ms (default 1000) */
  deleteSequentialDelayMs?: number;
}

export interface SystemOperationResult {
  system: string;
  success: boolean;
  objectId?: string;
  error?: string;
  apiCallsUsed: number;
  durationMs: number;
  skipped?: boolean;
  /** State before the change, captured for compensation (Entra CREATE and UPDATE). */
  previousState?: TargetStateSnapshot;
  /** Set by the rollback: whether this system's change was undone, and why not if it was not. */
  rolledBack?: boolean;
  rollbackReason?: string;
}

/**
 * A target account's state just before a bulk CREATE or UPDATE changed it, so a rollback can
 * put it back: restore `attributes` when the account existed, deactivate it when it did not.
 */
export interface TargetStateSnapshot {
  existed: boolean;
  objectId?: string;
  /**
   * Reference to the values of the attributes the change wrote, as read before the change
   * (null = unset). The values are personal data: they are stored encrypted in the rollback
   * snapshot store, so only this reference is in the workflow history and the result.
   */
  snapshotRef?: string;
  /**
   * The store kind behind snapshotRef. 'entra-state': the whole pre-change state, taken once per
   * operation and system, so a retried activity keeps the state from before its first attempt.
   * Absent: 'entra-attributes', the attribute values only (results recorded before).
   */
  snapshotKind?: 'entra-state';
  /** The values themselves: only in results recorded before snapshotRef existed. */
  attributes?: Record<string, unknown>;
}

/**
 * What a rollback did for one operation; `systems` covers each system that had succeeded, `hub`
 * the Golden Record write when there was one.
 */
export interface OperationRollback {
  /** True only when every system that had succeeded, and the Golden Record write, was undone. */
  rolledBack: boolean;
  reason: string;
  systems: Array<{ system: string; rolledBack: boolean; reason: string }>;
  hub?: { rolledBack: boolean; reason: string };
}

export interface OperationResult {
  operationId: string;
  success: boolean;
  type: BulkOperationType;
  userId: string;
  email: string;
  /** One entry per target system; plain array so it survives Temporal payloads. */
  systemResults: SystemOperationResult[];
  /** Rate limiter throttles during this operation (see bulk-operation.dto.ts). */
  rateLimitHits?: number;
  startedAt: Date;
  completedAt: Date;
  durationMs: number;
  error?: string;
  retryCount?: number;
  rolledBack?: boolean;
  rollbackReason?: string;
  /** The Golden Record write, when the operation saved one (see HubWrite). */
  hubWrite?: HubWrite;
}

/**
 * An operation's Golden Record write. The state it overwrote is personal data: it is stored
 * encrypted in the rollback snapshot store, and only the reference is here.
 */
export interface HubWrite {
  identityId: string;
  snapshotRef: string;
  /** Set by the rollback: whether the write was undone, and why not if it was not. */
  rolledBack?: boolean;
  rollbackReason?: string;
}

export interface BulkOperationResult {
  batchId: string;
  /** CANCELLED: the run was cancelled, what it changed compensated (bulk-provisioning:cancel-compensates). */
  status: 'COMPLETED' | 'PARTIAL_SUCCESS' | 'FAILED' | 'CANCELLED';
  dryRun: boolean;
  summary: {
    total: number;
    successful: number;
    failed: number;
    rolledBack: number;
    skipped: number;
  };
  breakdown: {
    creates: { total: number; successful: number; failed: number };
    updates: { total: number; successful: number; failed: number };
    deletes: { total: number; successful: number; failed: number };
    disables: { total: number; successful: number; failed: number };
  };
  results: OperationResult[];
  metrics: {
    totalDurationMs: number;
    averageOperationMs: number;
    apiCallsTotal: number;
    rateLimitHits: number;
  };
  startedAt: Date;
  completedAt: Date;
  errors?: string[];
  warnings?: string[];
}

export interface OperationPartitions {
  creates: BulkOperation[];
  updates: BulkOperation[];
  deletes: BulkOperation[];
  disables: BulkOperation[];
}

export interface ValidationError {
  operationId: string;
  field: string;
  message: string;
  severity: 'ERROR' | 'CRITICAL';
}

export interface ValidationWarning {
  operationId: string;
  message: string;
  suggestion?: string;
}

export interface ValidationResult {
  safe: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
  risk: {
    level: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
    reasons: string[];
    destructiveOps: number;
    vipUsersAffected: number;
  };
}
