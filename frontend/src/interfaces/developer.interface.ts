/**
 * Developer Tools – Workflow Debugger & Transaction Viewer.
 * Backend APIs: GET /api/v1/dev/workflows, GET /api/v1/dev/transactions (future).
 */

// ── Workflow Debugger ──

export type WorkflowType =
  | "ONBOARDING"
  | "OFFBOARDING"
  | "RECONCILIATION"
  | "BULK_PROVISIONING"
  | "DISTRIBUTED_TRANSACTION";

export type WorkflowStatus =
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "TIMED_OUT"
  | "CANCELLED";

export interface IWorkflowStep {
  name: string;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  output?: Record<string, unknown>;
  error?: string;
}

export interface IWorkflowExecution {
  workflowId: string;
  type: WorkflowType;
  status: WorkflowStatus;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  triggeredBy: string;
  /** Target user or batch for context */
  targetDescription: string;
  steps: IWorkflowStep[];
  metadata?: Record<string, unknown>;
}

// ── Transaction Viewer ──

/** ROLLBACK_FAILED: the rollback ran, but a committed system could not be restored. */
export type TransactionPhase =
  | "PREPARING"
  | "PREPARED"
  | "COMMITTING"
  | "COMMITTED"
  | "ROLLING_BACK"
  | "ROLLED_BACK"
  | "ROLLBACK_FAILED"
  | "FAILED";

/** ROLLBACK_FAILED: committed, and the restore failed, so the change is still in place. */
export type SystemParticipationStatus =
  | "PREPARING"
  | "PREPARED"
  | "COMMITTED"
  | "ROLLED_BACK"
  | "ROLLBACK_FAILED"
  | "FAILED";

export interface ISystemParticipant {
  systemName: string;
  status: SystemParticipationStatus;
  preparedAt?: string;
  committedAt?: string;
  rolledBackAt?: string;
  error?: string;
  durationMs?: number;
}

export interface IDistributedTransaction {
  transactionId: string;
  workflowId: string;
  phase: TransactionPhase;
  operation: string;
  startedAt: string;
  completedAt?: string;
  initiatedBy: string;
  targetUser?: string;
  participants: ISystemParticipant[];
  autoRollback: boolean;
  timeout: number;
  notes?: string;
}
