/**
 * Bulk Operation DTOs
 *
 * Data structures for handling bulk user provisioning operations with mixed
 * CREATE/UPDATE/DELETE actions across multiple target systems.
 */

import { StandardUserDto } from './standard-user.dto';
import type { UserPayload } from '../types/user-payload';

/** Input type for activities — accepts user from workflows (UserPayload) or API (StandardUserDto) */
export type BulkOperationInput = Omit<BulkOperation, 'user'> & {
  user: StandardUserDto | UserPayload;
};

/** Partitions with input-compatible operations */
export type OperationPartitionsInput = Omit<
  OperationPartitions,
  'creates' | 'updates' | 'deletes' | 'disables'
> & {
  creates: BulkOperationInput[];
  updates: BulkOperationInput[];
  deletes: BulkOperationInput[];
  disables: BulkOperationInput[];
};

/**
 * Operation types for bulk provisioning
 */
export enum BulkOperationType {
  CREATE = 'CREATE',
  UPDATE = 'UPDATE',
  DELETE = 'DELETE',
  DISABLE = 'DISABLE',
}

/**
 * Priority levels for operation execution
 */
export enum OperationPriority {
  LOW = 'LOW',
  NORMAL = 'NORMAL',
  HIGH = 'HIGH',
  CRITICAL = 'CRITICAL',
}

/**
 * Individual operation within a bulk batch
 */
export interface BulkOperation {
  id: string; // Unique operation ID
  type: BulkOperationType;
  user: StandardUserDto;
  targetSystems: string[]; // e.g., ['entra-id', 'active-directory']
  priority: OperationPriority;
  requiresApproval?: boolean; // For DELETE/DISABLE operations
  metadata?: Record<string, unknown>;
}

/**
 * Request payload for bulk provisioning
 */
export interface BulkOperationRequest {
  batchId: string;
  tenantId: string;
  operations: BulkOperation[];

  // Configuration
  dryRun?: boolean; // Simulate without executing
  continueOnError?: boolean; // Continue if individual ops fail
  batchSize?: number; // Number of concurrent operations (default: 10)
  requireApprovalForDeletes?: boolean; // Human approval gate

  // Metadata
  initiatedBy: string; // Who triggered this
  notes?: string;
}

/**
 * Result of a single operation
 */
export interface OperationResult {
  operationId: string;
  success: boolean;
  type: BulkOperationType;
  userId: string;
  email: string;

  // System-specific results, one per target system. A plain array (not a Map) because
  // activity results cross Temporal's JSON payload converter, which turns a Map into {}.
  systemResults: SystemOperationResult[];
  /** Times the rate limiter throttled this operation. A 429 from a target fails the activity
   * instead, and Temporal retries it after the target's retry-after delay. */
  rateLimitHits?: number;

  // Timing
  startedAt: Date;
  completedAt: Date;
  durationMs: number;

  // Error handling
  error?: string;
  retryCount?: number;

  // Rollback info
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

/**
 * Result of operation on a specific target system
 */
export interface SystemOperationResult {
  system: string; // 'entra-id', 'active-directory', etc.
  success: boolean;
  objectId?: string; // System-specific user ID
  error?: string;
  apiCallsUsed: number;
  durationMs: number;
  skipped?: boolean; // If user already exists/doesn't exist
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

/**
 * Complete bulk operation result
 */
export interface BulkOperationResult {
  batchId: string;
  /** CANCELLED: the run was cancelled, what it changed compensated (bulk-provisioning:cancel-compensates). */
  status: 'COMPLETED' | 'PARTIAL_SUCCESS' | 'FAILED' | 'CANCELLED';
  dryRun: boolean;

  // Summary statistics
  summary: {
    total: number;
    successful: number;
    failed: number;
    rolledBack: number;
    skipped: number;
  };

  // Breakdown by operation type
  breakdown: {
    creates: { total: number; successful: number; failed: number };
    updates: { total: number; successful: number; failed: number };
    deletes: { total: number; successful: number; failed: number };
    disables: { total: number; successful: number; failed: number };
  };

  // Detailed results
  results: OperationResult[];

  // Performance metrics
  metrics: {
    totalDurationMs: number;
    averageOperationMs: number;
    apiCallsTotal: number;
    rateLimitHits: number;
  };

  // Timing
  startedAt: Date;
  completedAt: Date;

  // Errors
  errors?: string[];
  warnings?: string[];
}

/**
 * Partitioned operations by type for ordered execution
 */
export interface OperationPartitions {
  creates: BulkOperation[];
  updates: BulkOperation[];
  deletes: BulkOperation[];
  disables: BulkOperation[];
}

/**
 * Validation result for pre-flight checks
 */
export interface ValidationResult {
  safe: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];

  // Risk assessment
  risk: {
    level: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
    reasons: string[];
    destructiveOps: number; // DELETE + DISABLE count
    vipUsersAffected: number;
  };
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

/**
 * Rate limit state for a target system
 */
export interface RateLimitState {
  system: string;
  remaining: number;
  total: number;
  resetTime: Date;

  // Calculated fields
  utilizationPercent: number;
  estimatedWaitMs: number;
}

/**
 * Batch execution configuration
 */
export interface BatchExecutionConfig {
  batchSize: number;
  maxConcurrent: number;
  retryAttempts: number;
  retryDelayMs: number;
  timeoutMs: number;

  // Rate limiting
  respectRateLimits: boolean;
  rateLimitThreshold: number; // Stop if utilization > this % (default: 80)
}
