/**
 * [INTERFACE] Impact Analysis - Frontend contract for blueprint impact simulation
 * -------------------------------------------------------------------------------
 * Matches backend POST /api/v1/blueprints/impact-analysis request/response.
 */

import type { IStandardUser } from './standard-user.interface';

/** Single user delta from impact analysis. */
export interface IUserDelta {
  userId: string;
  displayName: string;
  upn: string;
  action: 'CREATE' | 'UPDATE' | 'DELETE' | 'NO_CHANGE';
  risk: 'Low' | 'Medium' | 'High' | 'Critical';
  changes?: {
    field: string;
    oldValue: string;
    newValue: string;
    impact: 'Low' | 'Medium' | 'High';
  }[];
  warnings?: string[];
  targetSystem: string;
}

/** Entra user metadata (licenses, groups, directory roles, UPN). */
export interface IEntraUserMetadata {
  userId: string;
  displayName: string;
  /** Null when the preview does not know it (no Entra ID config with a default domain). */
  upn: string | null;
  upnStatus: 'valid' | 'conflict' | 'unknown';
  upnIssue?: string;
  /** Suggested alternative UPN when primary is taken (from UPN resolver) */
  suggestedUpn?: string;
  /** All candidates that were checked (for debugging / transparency) */
  candidatesChecked?: string[];
  /** The licenses the policy assigns; `available`: units left, null until discovery read them. */
  licenses: {
    sku: string;
    name: string;
    assigned: boolean;
    available: number | null;
  }[];
  /** The groups the policy assigns, by their catalog name. */
  groups: string[];
  /** The directory roles the policy assigns, by their catalog name. */
  roles: string[];
  /** What the preview cannot tell (the UPN, conditional access, entitlements discovery has not read). */
  notKnown: string[];
  department?: string;
  location?: string;
}

/** Summary counts returned by impact analysis. */
export interface IRiskSummary {
  totalUsers: number;
  creates: number;
  updates: number;
  deletes: number;
  noChange?: number;
  warnings?: number;
  highRisk?: number;
}

/** Risk assessment from real delta computation. */
export interface IRiskAssessment {
  overallRisk: 'low' | 'medium' | 'high' | 'critical';
  affectedPercentage: number;
  createCount: number;
  updateCount: number;
  removeCount: number;
  disableCount: number;
  noChangeCount: number;
  highRiskOperations: string[];
  circuitBreakerTriggered: boolean;
  threshold: number;
}

/** Response from impact analysis endpoint. */
export interface ImpactAnalysisResponse {
  success: boolean;
  dryRun: boolean;
  deltas: IUserDelta[];
  entraMetadata: IEntraUserMetadata[];
  summary: IRiskSummary;
  risk?: IRiskAssessment;
  message?: string;
}
