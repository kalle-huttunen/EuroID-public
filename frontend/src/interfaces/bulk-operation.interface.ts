/**
 * [INTERFACE] Bulk Operations - Frontend Mirror
 * ---------------------------------------------
 * MUST align with backend 'backend/src/common/dtos/bulk-operation.dto.ts'
 * and workflow progress/result shapes.
 */

import type { IStandardUser } from './standard-user.interface';

export type BulkOperationType = 'CREATE' | 'UPDATE' | 'DELETE' | 'DISABLE';

export interface IBulkOperation {
  id: string;
  type: BulkOperationType;
  user: Partial<IStandardUser>;
  targetSystems: string[];
  priority: number;
  requiresApproval?: boolean;
  metadata?: Record<string, unknown>;
}

export interface IBulkOperationRequest {
  batchId: string;
  tenantId: string;
  operations: IBulkOperation[];
  dryRun: boolean;
  continueOnError: boolean;
  batchSize: number;
  requireApprovalForDeletes: boolean;
  initiatedBy: string;
  notes?: string;
}

/** Progress from workflow query (getProgress / getStatus) */
export interface IBulkProgress {
  batchId?: string;
  workflowId?: string;
  status:
    | 'VALIDATING'
    | 'RATE_LIMIT_INIT'
    | 'PARTITIONING'
    | 'EXECUTING_CREATES'
    | 'EXECUTING_UPDATES'
    | 'AWAITING_DELETE_APPROVAL'
    | 'EXECUTING_DELETES'
    | 'ROLLBACK'
    | 'COMPLETED'
    | 'FAILED'
    | 'CANCELLED';
  totalOperations: number;
  completedOperations: number;
  failedOperations: number;
  currentPhase: string;
  progressPercent: number;
  estimatedRemainingSeconds?: number;
}

/** Single operation result (from backend OperationResult) */
export interface IBulkResultItem {
  operationId: string;
  /** 'rolled-back': it ran, and a fail-fast or cancelled run undid it (the result's `rolledBack`). */
  status: 'success' | 'failed' | 'skipped' | 'rolled-back';
  success?: boolean;
  error?: string;
  /** Why the rollback undid the operation, or why it could not (a DELETE is not reversible). */
  rollbackReason?: string;
  userId?: string;
  email?: string;
  type?: BulkOperationType;
}

/** Final result from GET /bulk-provisioning/results/:workflowId */
export interface IBulkResult {
  batchId: string;
  status: string;
  summary: {
    total: number;
    succeeded: number;
    successful?: number;
    failed: number;
    skipped: number;
    rolledBack?: number;
  };
  results: IBulkResultItem[];
}
