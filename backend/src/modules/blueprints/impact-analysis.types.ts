import type { SodViolation } from '../policy/sod.service';
import type { StandardUserDto, UserStatus } from '@shared/dtos/standard-user.dto';

/** Loose shape of a canvas node coming from CanvasBlueprint.nodes (Mixed BSON). */
export interface BlueprintCanvasNode {
  id?: string;
  type?: string;
  data?: {
    type?: string;
    role?: string;
    label?: string;
    config?: Record<string, unknown>;
  };
}

/**
 * Shape accepted by toStandardUserDto / generateEntraMetadata.
 * Either a raw Identity document (with `.profile`) or an already-flat user record.
 */
export interface IdentityLikeRecord {
  _id?: { toString(): string } | string;
  id?: string;
  profile?: {
    firstName?: string;
    middleName?: string;
    lastName?: string;
    email?: string;
    status?: UserStatus;
    sourceSystem?: string;
    sourceUserId?: string;
    tenantId?: string;
    departmentCode?: string;
    location?: string;
    userPrincipalName?: string;
    [key: string]: unknown;
  };
  sources?: Array<{ sourceName?: string; externalId?: string }>;
  tenantId?: string;
  [key: string]: unknown;
}

/** Return shape of generateEntraMetadata per user. */
export interface EntraUserMetadata {
  userId: string;
  displayName: string;
  /** Null when not known: no Entra ID config with a default domain (a `notKnown` sentence says so). */
  upn: string | null;
  upnStatus: 'valid' | 'conflict' | 'unknown';
  upnIssue?: string;
  suggestedUpn?: string;
  candidatesChecked?: string[];
  /** The licenses the policy assigns; `available`: units left, null until discovery read them. */
  licenses: Array<{ sku: string; name: string; assigned: boolean; available: number | null }>;
  /** The groups the policy assigns, by their catalog name (else as the policy names them). */
  groups: string[];
  /** The directory roles the policy assigns, by their catalog name (else as the policy names them). */
  roles: string[];
  /** What the answer cannot tell (the UPN, conditional access, an entitlement discovery has not read). */
  notKnown: string[];
  department?: string;
  location?: string;
}

export interface AttributeChange {
  field: string;
  currentValue: string | number | boolean | null;
  newValue: string | number | boolean | null;
}

export interface EntitlementChange {
  type: 'group' | 'license' | 'role';
  action: 'add' | 'remove';
  targetId: string;
  targetName: string;
}

export interface ImpactDelta {
  userId: string;
  email: string;
  upn: string;
  displayName: string;
  operation: 'CREATE' | 'UPDATE' | 'REMOVE' | 'DISABLE' | 'NO_CHANGE';
  targetSystem: string;
  changes: AttributeChange[];
  entitlementChanges: EntitlementChange[];
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  riskReasons: string[];
}

export interface RiskAssessment {
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

export interface ImpactAnalysisResult {
  deltas: ImpactDelta[];
  summary: {
    totalUsers: number;
    creates: number;
    updates: number;
    deletes: number;
    noChange: number;
    highRisk: number;
    warnings: number;
  };
  risk: RiskAssessment;
  sodViolationsByUser?: Array<{ userId: string; email: string; violations: SodViolation[] }>;
  /** First N users (for Entra metadata generation). Set when streaming from Hub. */
  userSample?: StandardUserDto[];
}

export const DEFAULT_RISK_THRESHOLD = 10;

export const RISK_THRESHOLDS = {
  CRITICAL: { affectedPercentage: 30, removeCount: 10 },
  HIGH: { affectedPercentage: 15, removeCount: 5 },
  MEDIUM: { affectedPercentage: 5, removeCount: 0 },
} as const;
