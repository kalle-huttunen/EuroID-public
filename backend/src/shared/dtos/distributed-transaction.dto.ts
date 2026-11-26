/**
 * Distributed Transaction DTOs
 *
 * Data structures for managing distributed transactions across multiple target systems
 * using the 2-phase commit pattern (Prepare → Commit → Rollback on failure).
 */

import { StandardUserDto } from './standard-user.dto';
import type { UserPayload } from '../types/user-payload';

/**
 * Transaction phases
 */
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

/**
 * Transaction status for a single system
 */
export enum SystemTransactionStatus {
  PENDING = 'PENDING',
  PREPARED = 'PREPARED',
  COMMITTED = 'COMMITTED',
  ROLLED_BACK = 'ROLLED_BACK',
  /** Committed, and the restore to the previous state failed: the change is still in place. */
  ROLLBACK_FAILED = 'ROLLBACK_FAILED',
  FAILED = 'FAILED',
}

/**
 * Distributed transaction request
 */
export interface DistributedTransactionRequest {
  transactionId: string;
  user: StandardUserDto;
  targetSystems: string[];
  operation: 'CREATE' | 'UPDATE' | 'DELETE';
  tenantId?: string;

  // Transaction options
  timeout?: number; // Max time for entire transaction (default: 5 minutes)
  autoRollback?: boolean; // Auto rollback on any failure (default: true)

  // Metadata
  initiatedBy: string;
  notes?: string;
}

/** Input type for activities — accepts user from workflows (UserPayload) or API (StandardUserDto) */
export type DistributedTransactionRequestInput = Omit<DistributedTransactionRequest, 'user'> & {
  user: StandardUserDto | UserPayload;
};

/**
 * System transaction state
 */
export interface SystemTransaction {
  system: string;
  status: SystemTransactionStatus;
  preparedAt?: Date;
  committedAt?: Date;
  rolledBackAt?: Date;

  /**
   * Snapshot for rollback: `{ snapshotRef }`, the state captured at prepare stored encrypted
   * (RollbackSnapshotService). For a CREATE that state is `{ accountUpn }`, the UPN resolved for
   * the account at prepare, which the commit creates it under.
   */
  previousState?: Record<string, unknown>;

  /**
   * A CREATE's account in the target, by the id the target gave it (Entra ID object id): the
   * rollback deletes it by this id, since the account's UPN need not be the email. Absent in
   * transactions committed before it was kept.
   */
  createdAccountId?: string;

  // Error info
  error?: string;

  // Lock info
  lockId?: string;
  lockAcquiredAt?: Date;
}

/** Per-system transaction state keyed by system. A plain object: it crosses Temporal payloads. */
export type SystemTransactions = Record<string, SystemTransaction>;

/**
 * Distributed transaction result
 */
export interface DistributedTransactionResult {
  transactionId: string;
  success: boolean;
  phase: TransactionPhase;

  // System results
  systems: SystemTransactions;

  // Timing
  startedAt: Date;
  completedAt: Date;
  durationMs: number;

  // Summary
  prepareSuccess: boolean;
  commitSuccess: boolean;
  rolledBack: boolean;

  error?: string;
}

/**
 * Snapshot of user state in a target system
 */
export interface UserSnapshot {
  system: string;
  userId: string;
  email: string;

  // Full state
  state: Record<string, unknown>;

  // Metadata
  capturedAt: Date;
  version?: string;
  hash?: string; // For change detection
}

/**
 * Drift detection result
 */
export interface DriftDetectionResult {
  userId: string;
  email: string;
  hasDrift: boolean;
  hubState: StandardUserDto;

  // System states
  systemStates: Map<string, UserSnapshot>;

  // Detected drifts
  drifts: SystemDrift[];

  /**
   * Target systems whose account could not be read (connector config missing or incomplete, a
   * failed call), with the reason, emails masked: no drift is raised or closed for them.
   */
  systemErrors?: Array<{ system: string; error: string }>;

  // Severity
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

  detectedAt: Date;
}

/** Input type for activities — accepts hubState from workflows (UserPayload) or API (StandardUserDto) */
export type DriftDetectionResultInput = Omit<DriftDetectionResult, 'hubState'> & {
  hubState: StandardUserDto | UserPayload;
};

/**
 * Drift in a specific system
 */
export interface SystemDrift {
  system: string;
  driftType: DriftType;
  field?: string;
  expectedValue?: unknown;
  actualValue?: unknown;
  description: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  autoCorrect: boolean; // Can this be auto-corrected?
}

export enum DriftType {
  MISSING_USER = 'MISSING_USER', // User in Hub but not in system
  ORPHANED_USER = 'ORPHANED_USER', // User in system but not in Hub
  FIELD_MISMATCH = 'FIELD_MISMATCH', // Field value doesn't match
  STATUS_MISMATCH = 'STATUS_MISMATCH', // User active in Hub but disabled in system
  GROUP_MISMATCH = 'GROUP_MISMATCH', // Group membership doesn't match
  LICENSE_MISMATCH = 'LICENSE_MISMATCH', // License assignment doesn't match
}

/**
 * Reconciliation report
 */
export interface ReconciliationReport {
  reportId: string;
  tenantId: string;

  // Scope
  totalUsers: number;
  scannedUsers: number;

  // Summary
  usersWithDrift: number;
  totalDrifts: number;

  // Drifts per severity, each drift once: the four add up to totalDrifts
  criticalDrifts: number;
  highDrifts: number;
  mediumDrifts: number;
  lowDrifts: number;

  // By type
  driftsByType: Map<DriftType, number>;

  // By system
  driftsBySystem: Map<string, number>;

  // Actions taken
  autoCorrected: number;
  requiresManualReview: number;

  // Timing
  startedAt: Date;
  completedAt: Date;
  durationMs: number;

  // Detailed results
  drifts: DriftDetectionResult[];

  // The drift thresholds of the run's settings it reached (set by the workflow); absent: none
  alerts?: ReconciliationAlert[]; /** The systems whose orphan detection (or cleanup start) failed, with why; absent: none. */
  orphanDetectionFailures?: OrphanDetectionFailure[];
}

/** A target system whose orphan detection failed in a reconciliation run. */
export interface OrphanDetectionFailure {
  system: string;
  error: string;
}

/** A drift threshold of ReconciliationConfig a run reached (workflows/reconciliation-alerts.ts). */
export interface ReconciliationAlert {
  threshold: 'maxDriftsBeforeAlert' | 'criticalDriftAlertThreshold';
  limit: number;
  found: number;
}

/**
 * Result from a single reconciliation batch (child workflow).
 */
export interface ReconciliationBatchResult {
  drifts: DriftDetectionResult[];
  corrections: CorrectionAction[];
  usersScanned: number;
  errors?: string[];
}

/**
 * Auto-correction action
 */
export interface CorrectionAction {
  driftId: string;
  system: string;
  action: 'CREATE' | 'UPDATE' | 'DELETE' | 'DISABLE' | 'ENABLE';
  user: StandardUserDto;

  // Result
  success: boolean;
  error?: string;
  executedAt: Date;
}

/** Input type for activities — accepts user from workflows (UserPayload) or API (StandardUserDto) */
export type CorrectionActionInput = Omit<CorrectionAction, 'user'> & {
  user: StandardUserDto | UserPayload;
};

/**
 * Reconciliation configuration
 */
export interface ReconciliationConfig {
  tenantId: string;

  // Schedule: none exists, a run starts on request. The API refuses cronSchedule and
  // enabled: false (reconciliation.controller.ts); nothing reads either.
  enabled?: boolean;
  cronSchedule?: string;

  // Scope (shared/utils/reconciliation-scope.ts): departments to scan (exact, ignoring case;
  // absent or empty, every one), and identity ids or emails never scanned or corrected
  targetSystems: string[];
  includedDepartments?: string[];
  excludedUsers?: string[];

  // Actions
  autoCorrect: boolean;
  autoCorrectTypes: DriftType[];
  requireApprovalForDeletes: boolean;

  // Notifications (a drift threshold reached): the event, and a mail to a user of the tenant.
  // No Slack: the API refuses notifySlack (reconciliation.controller.ts).
  notifyOnDrift: boolean;
  notifyEmail?: string;

  // Thresholds
  maxDriftsBeforeAlert: number;
  criticalDriftAlertThreshold: number;
}

/**
 * Transaction lock (for distributed locking)
 */
export interface TransactionLock {
  lockId: string;
  resourceType: 'USER' | 'SYSTEM';
  resourceId: string;

  acquiredBy: string; // Transaction ID
  acquiredAt: Date;
  expiresAt: Date;

  released: boolean;
  releasedAt?: Date;
}
