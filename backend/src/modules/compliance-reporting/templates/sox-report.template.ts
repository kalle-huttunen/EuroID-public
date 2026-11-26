/**
 * SOX Compliance Report Template
 *
 * Pure data transformer. Accepts aggregated data from services,
 * returns structured report payload for PDF/CSV rendering.
 */

export interface SoxExecutiveSummary {
  dateRangeFrom: string;
  dateRangeTo: string;
  overallComplianceScore: number;
  criticalFindingsCount: number;
}

export interface SoxSegregationOfDuties {
  activePoliciesCount: number;
  violationsBlocked: number;
  violationsWarned: number;
  identitiesWithViolations: number;
  resolutionStatus: string;
}

export interface SoxAccessCertification {
  campaignsCompleted: number;
  campaignsInProgress: number;
  campaignsOverdue: number;
  totalPendingReviews: number;
  autoRevokedItems: number;
}

export interface SoxPrivilegedAccess {
  adminAccountsTotal: number;
  activeSessions: number;
  tierDistribution: Record<string, number>;
  activationEventsInPeriod: number;
}

export interface SoxRiskPosture {
  topRiskyUsers: Array<{ identityId: string; score: number; trend: string }>;
  averageRiskScore: number;
  trend: string;
}

export interface SoxAuditTrailIntegrity {
  valid: boolean;
  eventsChecked: number;
  firstInvalid?: string;
}

export interface SoxReportPayload {
  executiveSummary: SoxExecutiveSummary;
  segregationOfDuties: SoxSegregationOfDuties;
  accessCertification: SoxAccessCertification;
  privilegedAccess: SoxPrivilegedAccess;
  riskPosture: SoxRiskPosture;
  auditTrailIntegrity: SoxAuditTrailIntegrity;
}

export interface SoxReportInput {
  dateRange: { from: Date; to: Date };
  auditStats: { total: number; critical: number; warnings: number };
  riskDistribution: { average: number; median: number };
  sodPoliciesCount: number;
  identitiesWithSodViolations: number;
  campaigns: {
    completed: number;
    active: number;
    overdue: number;
    totalPending: number;
    autoRevoked: number;
  };
  adminAccounts: Array<{ adminTier: string; status: string }>;
  adminActivationEventsCount: number;
  topRisky: Array<{ identityId: string; score: number; trend: string }>;
  integrityResult: { valid: boolean; eventsChecked: number; firstInvalid?: string };
}

/**
 * Build SOX report payload from aggregated data.
 */
export function buildSoxReport(input: SoxReportInput): SoxReportPayload {
  const complianceScore = Math.max(
    0,
    100 -
      input.auditStats.critical * 10 -
      input.identitiesWithSodViolations * 5 -
      (input.integrityResult.valid ? 0 : 20),
  );

  const tierDistribution: Record<string, number> = {};
  for (const a of input.adminAccounts) {
    const tier = a.adminTier || 'UNKNOWN';
    tierDistribution[tier] = (tierDistribution[tier] || 0) + 1;
  }

  const activeSessions = input.adminAccounts.filter((a) => a.status === 'ACTIVE').length;

  return {
    executiveSummary: {
      dateRangeFrom: input.dateRange.from.toISOString().split('T')[0],
      dateRangeTo: input.dateRange.to.toISOString().split('T')[0],
      overallComplianceScore: Math.min(100, complianceScore),
      criticalFindingsCount: input.auditStats.critical + input.identitiesWithSodViolations,
    },
    segregationOfDuties: {
      activePoliciesCount: input.sodPoliciesCount,
      violationsBlocked: 0,
      violationsWarned: 0,
      identitiesWithViolations: input.identitiesWithSodViolations,
      resolutionStatus: 'N/A',
    },
    accessCertification: {
      campaignsCompleted: input.campaigns.completed,
      campaignsInProgress: input.campaigns.active,
      campaignsOverdue: input.campaigns.overdue,
      totalPendingReviews: input.campaigns.totalPending,
      autoRevokedItems: input.campaigns.autoRevoked,
    },
    privilegedAccess: {
      adminAccountsTotal: input.adminAccounts.length,
      activeSessions,
      tierDistribution,
      activationEventsInPeriod: input.adminActivationEventsCount,
    },
    riskPosture: {
      topRiskyUsers: input.topRisky,
      averageRiskScore: input.riskDistribution.average,
      trend: input.riskDistribution.average > 50 ? 'ELEVATED' : 'NORMAL',
    },
    auditTrailIntegrity: {
      valid: input.integrityResult.valid,
      eventsChecked: input.integrityResult.eventsChecked,
      firstInvalid: input.integrityResult.firstInvalid,
    },
  };
}
