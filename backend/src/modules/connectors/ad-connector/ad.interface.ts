import { StandardUserDto } from '@shared/dtos/standard-user.dto';
import { ProvisioningResult } from '@shared/dtos/provisioning-result.dto';

/**
 * Runtime configuration for Active Directory connector.
 * rootBaseDn is the top-level boundary; userSearchBase narrows user operations.
 * @deprecated baseDn — use rootBaseDn. Kept for backward compatibility during migration.
 */
export interface AdConfig {
  /** AD server hostname or IP (e.g., 10.0.0.1) */
  host: string;
  /** LDAP port (default 636 for LDAPS, 389 for LDAP) */
  port?: number;
  /** @deprecated Use rootBaseDn. Legacy: tenant isolation boundary. */
  baseDn?: string;
  /** Top-level DN boundary — all operations confined within this (e.g., DC=gov,DC=fi) */
  rootBaseDn?: string;
  /** Narrower OU for user search (e.g., OU=Helsinki,DC=gov,DC=fi). Must be inside rootBaseDn. */
  userSearchBase?: string;
  /** Bind DN for service account (e.g., CN=svc_euro_id,OU=ServiceAccounts,DC=gov,DC=fi) */
  serviceAccount: string;
  /** Service account password */
  password: string;
  /** Use LDAPS (port 636) vs LDAP (389). Default true. */
  useLdaps?: boolean;
  /** Domain for UPN generation (e.g., gov.fi) */
  defaultDomain?: string;
  /** Sub-OU for new users under search base (e.g., OU=Users). Default: create directly under search base */
  userOu?: string;
}

/**
 * Validates that searchBase is inside rootBaseDn.
 * e.g., "OU=Helsinki,DC=gov,DC=fi" is inside "DC=gov,DC=fi" ✓
 *       "OU=Espoo,DC=other,DC=fi" is NOT inside "DC=gov,DC=fi" ✗
 */
export function isInsideBaseDn(searchBase: string, rootBaseDn: string): boolean {
  const normalizedSearch = searchBase.toLowerCase().replace(/\s/g, '');
  const normalizedRoot = rootBaseDn.toLowerCase().replace(/\s/g, '');
  return normalizedSearch.endsWith(normalizedRoot);
}

/** LDAP attributes for a new AD user entry */
export interface AdUserDto {
  cn: string;
  sn: string;
  givenName: string;
  displayName: string;
  mail: string;
  sAMAccountName: string;
  userPrincipalName: string;
  objectClass: string[];
  /** 512 = normal account, 514 = disabled */
  userAccountControl: number;
}

/** LDAP search result for a user entry */
export interface AdUserEntry {
  dn: string;
  sAMAccountName?: string;
  mail?: string;
  userPrincipalName?: string;
  userAccountControl?: string;
  /** objectGUID bytes as AD stores them */
  objectGUID?: Buffer;
}

/** LDAP search result for a group entry */
export interface AdGroupEntry {
  dn: string;
  cn?: string;
  name?: string;
  /** Binary SID for RID extraction (well-known admin group detection) */
  objectSid?: Buffer | string;
}

/** Provisioning intent operations (groups) */
export interface ProvisioningIntent {
  operations: Array<{
    type: 'group' | 'license' | 'role';
    action: 'add' | 'remove';
    targetId: string;
  }>;
}

export interface Entitlement {
  nativeId: string;
  name: string;
  type: 'Group' | 'License';
  system?: string;
  /** PAM: Admin tier when requiresAdminAccount is true. */
  adminTier?: 'TIER_0' | 'TIER_1' | 'TIER_2';
  /** PAM: When true, assign to linked admin identity instead of primary. */
  requiresAdminAccount?: boolean;
  /** Risk level for access review and compliance. */
  riskLevel?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  metadata?: Record<string, unknown>;
}

/** Enriched health check result for AD connector UI */
export interface AdHealthCheckResult {
  connected: boolean;
  serverInfo?: string;
  rootBaseDnValid?: boolean;
  userSearchBaseValid?: boolean;
  groupCount?: number;
  error?: string;
}

/**
 * Active Directory connector interface.
 * Extends provision, discover, healthCheck semantics with AD-specific config.
 */
export interface IAdConnector {
  /**
   * Provision user to AD. Idempotent — if user exists (LDAP 68), returns existing DN.
   */
  provision(
    config: AdConfig,
    user: StandardUserDto,
    intent?: ProvisioningIntent,
  ): Promise<ProvisioningResult>;

  /**
   * Discover groups under baseDn for Entitlement Catalog.
   */
  discover(config: AdConfig): Promise<Entitlement[]>;

  /**
   * Health check — bind + unbind to verify LDAP connectivity.
   */
  healthCheck(config: AdConfig): Promise<boolean>;

  /**
   * Deprovision — disable user (set userAccountControl) or delete.
   */
  deprovision?(config: AdConfig, externalId: string): Promise<boolean>;
}
