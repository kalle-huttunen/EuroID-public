/**
 * Connector-agnostic provisioning types.
 *
 * These types are shared across all connectors (Entra, AD, SCIM, Discord, etc.)
 * and related modules (entitlement catalog, reconciliation, activities).
 *
 * Historically lived in entra.interface.ts; extracted here to eliminate
 * cross-module coupling through a single connector's type file.
 */

/** Target account shape returned by listUsers (orphan detection / reconciliation) */
export interface TargetAccount {
  id: string;
  userPrincipalName: string;
  mail?: string;
  displayName?: string;
  accountEnabled?: boolean;
  /** AD (listUsers): the objectGUID, an opaque id; `id` is the DN, whose CN is the person's name. */
  objectGuid?: string;
}

/** Operations the Policy Engine wants executed after user creation */
export interface ProvisioningIntent {
  operations: Array<{
    type: 'group' | 'license' | 'role';
    action: 'add' | 'remove';
    targetId: string; // The SKU ID or Group ID
  }>;
}

/** Origin: POLICY = Hub is source of truth (strict revert); EXTERNAL = target is source (discovery & visibility only). */
export type EntitlementOrigin = 'POLICY' | 'EXTERNAL';
/** STRICT = revert drift; OPEN = absorb only, do not revert. */
export type EntitlementGovernanceLevel = 'STRICT' | 'OPEN';

export interface Entitlement {
  nativeId: string; // GUID or SKU id
  name: string; // "All Staff", "Project Alpha"
  type: 'Group' | 'License' | 'DirectoryRole';
  /** Target system (e.g. "entra-id"). */
  system?: string;
  /** Classification: POLICY = policy-defined (revert drift); EXTERNAL = ad-hoc (discover only). */
  origin?: EntitlementOrigin;
  /** STRICT = revert manual changes; OPEN = sync back, do not revert. */
  governanceLevel?: EntitlementGovernanceLevel;
  /** PAM: Admin tier when requiresAdminAccount is true. */
  adminTier?: 'TIER_0' | 'TIER_1' | 'TIER_2';
  /** PAM: When true, assign to linked admin identity instead of primary. */
  requiresAdminAccount?: boolean;
  /** Risk level for access review and compliance. */
  riskLevel?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  metadata?: Record<string, unknown>;
  /** A license's units in use and enabled, as the target reports them (Entra ID subscribedSkus). */
  licenseUnits?: { consumed: number; enabled: number };
}
