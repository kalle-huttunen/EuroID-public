/**
 * Identity Entitlement Map API
 *
 * Query key factory and fetch functions for the per-identity entitlement map.
 * Aggregates data from existing endpoints: identity profile and provisioning, the identity's
 * entitlements (with the end date of access a time-bound request granted), policy evaluation,
 * entitlement catalog, drifts, risk scoring and admin accounts.
 */

import { axiosInstance } from './data';
import { API_BASE } from './constants';
import { fetchDrifts } from './reconciliation-api';
import { fetchRiskScoreByIdentity } from './intelligence-api';
import { fetchLinkedAdminAccounts } from './privileged-access-api';
import type { IDrift } from '../interfaces';
import type { RiskScoreFull } from './intelligence-api';
import type { LinkedAdminAccount } from './privileged-access-api';

// ── Query Key Factory ─────────────────────────────────────────────────

export const identityMapKeys = {
  all: () => ['identity-map'] as const,
  byId: (id: string) => ['identity-map', id] as const,
};

// ── Types ─────────────────────────────────────────────────────────────

/** One `provisioning[]` entry of the identity document (`ProvisioningState` in identity.schema.ts). */
export interface ProvisioningState {
  targetSystem: string;
  status: 'SYNCED' | 'SYNCING' | 'ERROR' | 'DEPROVISIONED' | 'PENDING';
  lastSync?: string;
  errorMsg?: string;
}

/**
 * One row of GET /identity/:id/entitlements (the Access tab reads the same): an entitlement an
 * active policy or an access request grants the identity. A policy grant is Active when its
 * target system is SYNCED; a request grant follows the request.
 */
export interface IdentityEntitlement {
  id: string;
  entitlement: string;
  /** group, license, role (policies); group, license, directoryrole (access requests) */
  type: string;
  /** Policy name or "Access request <id>" */
  source: string;
  targetSystem: string;
  grantedBy: 'policy' | 'request';
  status: 'Active' | 'Pending' | 'Revoked';
  /** End of the access a time-bound access request grants (request grants only), ISO 8601. */
  expiresAt?: string;
}

export interface ProvisioningOperation {
  type:
    | 'group'
    | 'license'
    | 'role'
    | 'attribute'
    | 'mfa'
    | 'conditional_access'
    | 'notification'
    | 'workflow';
  action: 'add' | 'remove' | 'set';
  target: string;
  targetId: string;
  params?: Record<string, string | number | boolean>;
  sourcePolicy: string;
  timeConstraint?: { durationDays?: number; expiresAt?: string };
}

export interface AdminOperation extends ProvisioningOperation {
  adminTier: 'TIER_0' | 'TIER_1' | 'TIER_2';
}

export interface SoDValidationResult {
  blockers: unknown[];
  warnings: unknown[];
}

/** An operation the policies grant that an access review revoked (an active review exclusion). */
export interface SuppressedOperation extends ProvisioningOperation {
  suppressedBy: {
    /** 'Suppressed by access review' */
    reason: string;
    exclusionId: string;
    campaignId: string;
  };
}

export interface PolicyProvisioningIntent {
  operations: ProvisioningOperation[];
  adminOperations?: AdminOperation[];
  sodWarnings?: unknown[];
  sodValidation?: SoDValidationResult;
  /** Left out of `operations`: revoked in an access review (GET /policy/evaluate/:identityId). */
  suppressedOperations?: SuppressedOperation[];
}

export interface EntitlementCatalogEntry {
  nativeId: string;
  name: string;
  type: 'Group' | 'License' | 'DirectoryRole';
  origin: 'POLICY' | 'EXTERNAL';
  governanceLevel?: 'STRICT' | 'OPEN';
  adminTier?: string;
}

interface IdentityDocumentResponse {
  found: boolean;
  identity: {
    _id: string;
    profile?: Record<string, unknown>;
    provisioning?: ProvisioningState[];
  } | null;
}

// ── Fetch Functions ───────────────────────────────────────────────────

/**
 * The identity's profile fields with its `provisioning[]`, from GET /identity/v2/:id (tenant-scoped,
 * PII masked). GET /identity/:id returns the profile only.
 */
export async function fetchIdentityProfile(id: string): Promise<Record<string, unknown>> {
  const res = await axiosInstance.get<IdentityDocumentResponse>(`${API_BASE}/identity/v2/${id}`);
  const identity = res.data?.identity;
  if (!res.data?.found || !identity) throw new Error('Identity not found');
  return {
    ...identity.profile,
    _id: identity._id,
    provisioning: Array.isArray(identity.provisioning) ? identity.provisioning : [],
  };
}

export async function fetchIdentityEntitlements(id: string): Promise<IdentityEntitlement[]> {
  const res = await axiosInstance.get<{ identityId: string; entitlements: IdentityEntitlement[] }>(
    `${API_BASE}/identity/${id}/entitlements`,
  );
  return Array.isArray(res.data?.entitlements) ? res.data.entitlements : [];
}

export async function fetchPolicyEvaluation(
  identityId: string,
): Promise<PolicyProvisioningIntent | null> {
  try {
    const res = await axiosInstance.get<PolicyProvisioningIntent>(
      `${API_BASE}/policy/evaluate/${identityId}`,
    );
    return res.data ?? null;
  } catch {
    return null;
  }
}

export async function fetchEntitlementCatalog(system: string): Promise<EntitlementCatalogEntry[]> {
  const res = await axiosInstance.get<{
    entitlements: EntitlementCatalogEntry[];
    count: number;
  }>(`${API_BASE}/entitlement-catalog?system=${encodeURIComponent(system)}`);
  return res.data?.entitlements ?? [];
}

// Re-export existing functions used by the aggregation hook
export { fetchDrifts, fetchRiskScoreByIdentity, fetchLinkedAdminAccounts };

// Re-export types used by consuming components
export type { IDrift, RiskScoreFull, LinkedAdminAccount };
