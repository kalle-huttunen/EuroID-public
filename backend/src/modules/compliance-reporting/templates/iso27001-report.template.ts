/**
 * ISO 27001 Compliance Report Template
 *
 * Pure data transformer. Accepts aggregated data from services,
 * returns structured report payload for PDF/CSV rendering.
 */

export interface IsoAccessControlInventory {
  totalIdentities: number;
  entitlementsBySystem: Record<string, number>;
  accessTypes: Record<string, number>;
}

export interface IsoPeriodicReviewStatus {
  campaignsCompleted: number;
  campaignsInProgress: number;
  campaignsOverdue: number;
}

export interface IsoIncidentAnomalySummary {
  totalAnomalies: number;
  byType: Record<string, number>;
  bySeverity: Record<string, number>;
  byStatus: Record<string, number>;
}

export interface IsoChangeManagement {
  policyChanges: number;
  connectorConfigChanges: number;
  identityLifecycleEvents: number;
}

export interface IsoDataProtection {
  piiRevealedEvents: number;
  gdprErasureEvents: number;
  dsarExports: number;
}

export interface Iso27001ReportPayload {
  accessControlInventory: IsoAccessControlInventory;
  periodicReviewStatus: IsoPeriodicReviewStatus;
  incidentAnomalySummary: IsoIncidentAnomalySummary;
  changeManagement: IsoChangeManagement;
  dataProtection: IsoDataProtection;
}

export interface Iso27001ReportInput {
  dateRange: { from: Date; to: Date };
  totalIdentities: number;
  entitlementsBySystem: Record<string, number>;
  accessTypes: Record<string, number>;
  campaigns: { completed: number; inProgress: number; overdue: number };
  anomalies: Array<{ type: string; severity: string; status: string }>;
  policyChangesCount: number;
  connectorConfigChangesCount: number;
  identityLifecycleEventsCount: number;
  piiRevealedCount: number;
  gdprErasureCount: number;
  dsarExportsCount: number;
}

/**
 * Build ISO 27001 report payload from aggregated data.
 */
export function buildIso27001Report(input: Iso27001ReportInput): Iso27001ReportPayload {
  const byType: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};
  const byStatus: Record<string, number> = {};

  for (const a of input.anomalies) {
    byType[a.type] = (byType[a.type] || 0) + 1;
    bySeverity[a.severity] = (bySeverity[a.severity] || 0) + 1;
    byStatus[a.status] = (byStatus[a.status] || 0) + 1;
  }

  return {
    accessControlInventory: {
      totalIdentities: input.totalIdentities,
      entitlementsBySystem: input.entitlementsBySystem,
      accessTypes: input.accessTypes,
    },
    periodicReviewStatus: {
      campaignsCompleted: input.campaigns.completed,
      campaignsInProgress: input.campaigns.inProgress,
      campaignsOverdue: input.campaigns.overdue,
    },
    incidentAnomalySummary: {
      totalAnomalies: input.anomalies.length,
      byType,
      bySeverity,
      byStatus,
    },
    changeManagement: {
      policyChanges: input.policyChangesCount,
      connectorConfigChanges: input.connectorConfigChangesCount,
      identityLifecycleEvents: input.identityLifecycleEventsCount,
    },
    dataProtection: {
      piiRevealedEvents: input.piiRevealedCount,
      gdprErasureEvents: input.gdprErasureCount,
      dsarExports: input.dsarExportsCount,
    },
  };
}
