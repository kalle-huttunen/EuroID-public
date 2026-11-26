/**
 * Reconciliation Dashboard interfaces.
 * Mirrors backend reconciliation and connector health contracts.
 */

export type DriftType =
  | 'MISSING_USER' // User in Hub but not in target
  | 'ORPHANED_USER' // User in target but not in Hub
  | 'ORPHAN_ACCOUNT' // Target account with no Hub identity
  | 'FIELD_MISMATCH' // Attribute differs between Hub and target
  | 'STATUS_MISMATCH' // Status differs (e.g., ACTIVE in Hub, disabled in AD)
  | 'GROUP_MISMATCH' // Group membership differs
  | 'LICENSE_MISMATCH'; // License assignment differs

export const DRIFT_TYPE_LABELS: Record<DriftType, string> = {
  MISSING_USER: 'Missing in target',
  ORPHANED_USER: 'Orphan in target',
  ORPHAN_ACCOUNT: 'Orphan account',
  FIELD_MISMATCH: 'Field mismatch',
  STATUS_MISMATCH: 'Status mismatch',
  GROUP_MISMATCH: 'Group mismatch',
  LICENSE_MISMATCH: 'License mismatch',
};

export interface OrphanDetails {
  targetSystem: string;
  externalId: string;
  accountName?: string;
  discoveredAt: string;
  gracePeriodEndsAt?: string;
  disabledAt?: string;
  decision?: 'DELETE' | 'ADOPT';
  decidedBy?: string;
  adoptedIdentityId?: string;
  /** Why EuroID keeps the account instead of deleting it (an Active Directory orphan). */
  keptReason?: string;
}

export interface IOrphanDrift extends IDrift {
  orphanDetails?: OrphanDetails;
  workflowId?: string;
}

export type DriftSeverity = 'low' | 'medium' | 'high' | 'critical';

export type DriftStatus = 'open' | 'corrected' | 'ignored' | 'quarantined';

export interface IDrift {
  id: string;
  type: DriftType;
  severity: DriftSeverity;
  userId: string;
  userDisplayName: string;
  userEmail: string;
  targetSystem: string;
  field?: string;
  hubValue?: string;
  targetValue?: string;
  detectedAt: string;
  autoCorrectEligible: boolean;
  status?: DriftStatus;
  workflowId?: string;
}

export interface IConnectorHealthStatus {
  connectorName: string;
  connectorId: string;
  status: 'healthy' | 'degraded' | 'down' | 'unknown';
  uptime: number | null; // percentage (0-100); null when not tracked
  lastChecked: string | null; // null when the connector was never checked
  rateLimitRemaining?: number;
  rateLimitTotal?: number;
  credentialExpiresAt?: string;
  lastError?: string;
  responseTimeMs?: number;
}
