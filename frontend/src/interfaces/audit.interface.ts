/**
 * Audit & Compliance – event log types.
 * Backend API: GET /api/v1/audit (not implemented yet; see FRONTEND_TASK_7.md).
 */

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
  | 'APPROVAL_DENIED';

export type AuditSeverity = 'info' | 'warning' | 'error' | 'critical';

export interface IAuditEvent {
  id: string;
  action: AuditAction;
  severity: AuditSeverity;
  timestamp: string;
  /** Actor: user email, system name, or "Temporal Worker" */
  actor: string;
  /** Resource type: "user", "policy", "connector", "workflow" */
  resourceType: string;
  /** Resource identifier (user ID, policy ID, etc.) */
  resourceId: string;
  /** Human-readable resource name */
  resourceName: string;
  /** Target system involved, if any */
  targetSystem?: string;
  /** Human-readable description */
  description: string;
  /** Change payload (before/after for updates) */
  payload?: {
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  };
  /** IP address or request source */
  source?: string;
}

export interface IAuditFilter {
  action?: AuditAction[];
  severity?: AuditSeverity[];
  actor?: string;
  resourceType?: string;
  targetSystem?: string;
  dateFrom?: string;
  dateTo?: string;
  search?: string;
}
