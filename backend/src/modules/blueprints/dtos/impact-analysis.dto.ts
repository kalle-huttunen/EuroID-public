/**
 * Impact Analysis DTOs
 *
 * Type definitions for the Impact Fleet analysis endpoints
 */

export interface ImpactAnalysisRequest {
  users: Record<string, unknown>[];
  connectors: string[];
  dryRun: boolean;
}

export interface UserDelta {
  userId: string;
  displayName: string;
  upn?: string;
  action: 'CREATE' | 'UPDATE' | 'DELETE' | 'DISABLE';
  risk: 'Low' | 'Medium' | 'High' | 'Critical';
  changes?: FieldChange[];
  warnings?: string[];
  targetSystem: string;
}

export interface FieldChange {
  field: string;
  oldValue: string | null;
  newValue: string | null;
  impact: 'Low' | 'Medium' | 'High';
}

export interface EntraUserMetadata {
  userId: string;
  displayName: string;
  /** Null when not known (no Entra ID config with a default domain). */
  upn: string | null;
  upnStatus: 'valid' | 'conflict' | 'unknown';
  upnIssue?: string;
  licenses: EntraLicense[];
  /** The groups the policy assigns, by their catalog name. */
  groups: string[];
  /** The directory roles the policy assigns, by their catalog name. */
  roles: string[];
  /** What the answer cannot tell (the UPN, conditional access, an entitlement not discovered). */
  notKnown: string[];
  department?: string;
  location?: string;
}

export interface EntraLicense {
  sku: string;
  name: string;
  assigned: boolean;
  /** Units left, null until Entra ID discovery has read the license. */
  available: number | null;
}

export interface ImpactAnalysisResponse {
  success: boolean;
  dryRun: boolean;
  deltas: UserDelta[];
  entraMetadata: EntraUserMetadata[];
  summary: {
    totalUsers: number;
    creates: number;
    updates: number;
    deletes: number;
    highRisk: number;
  };
}

export interface ConnectorStatusResponse {
  name: string;
  type: string;
  health: 'online' | 'offline' | 'degraded';
  enabled: boolean;
  credentials: {
    valid: boolean;
    expiresIn?: string;
  };
  rateLimit?: {
    remaining: number;
    total: number;
    resetTime?: string;
  };
  errorMessage?: string;
}
