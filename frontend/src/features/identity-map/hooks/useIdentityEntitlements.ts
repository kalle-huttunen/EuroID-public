/**
 * useIdentityEntitlements — aggregation hook for the Identity Entitlement Map.
 *
 * Fetches identity profile with provisioning, the identity's entitlements (a time-bound access
 * request's end date included), policy evaluation, drifts, risk score, linked admin accounts and
 * entitlement catalog metadata in parallel via individual TanStack Query hooks.
 */

import { useQuery, useQueries } from '@tanstack/react-query';
import {
  identityMapKeys,
  fetchIdentityProfile,
  fetchIdentityEntitlements,
  fetchPolicyEvaluation,
  fetchEntitlementCatalog,
  fetchDrifts,
  fetchRiskScoreByIdentity,
  fetchLinkedAdminAccounts,
} from '@api/identity-map-api';
import type {
  ProvisioningState,
  IdentityEntitlement,
  PolicyProvisioningIntent,
  EntitlementCatalogEntry,
  IDrift,
  RiskScoreFull,
  LinkedAdminAccount,
} from '@api/identity-map-api';
import { reconciliationKeys } from '@api/reconciliation-api';
import { intelligenceKeys } from '@api/intelligence-api';
import { useMemo } from 'react';

export interface IdentityEntitlementsData {
  identity: Record<string, unknown> | null;
  provisioning: ProvisioningState[];
  /** What policies and access requests grant the identity (GET /identity/:id/entitlements). */
  entitlements: IdentityEntitlement[];
  policyIntent: PolicyProvisioningIntent | null;
  drifts: IDrift[];
  riskScore: RiskScoreFull | null;
  adminAccounts: LinkedAdminAccount[];
  /**
   * Catalogue metadata (governance level, type) per system the entitlements are in, keyed by
   * the entitlements' targetSystem. Lists every entitlement of a system, not the identity's.
   */
  catalogBySystem: Record<string, EntitlementCatalogEntry[]>;
}

export interface UseIdentityEntitlementsResult {
  data: IdentityEntitlementsData;
  isLoading: boolean;
  isError: boolean;
}

export function useIdentityEntitlements(identityId: string): UseIdentityEntitlementsResult {
  const enabled = !!identityId;

  // 1. Identity profile with its provisioning[] array (GET /identity/v2/:id)
  const identityQuery = useQuery({
    queryKey: identityMapKeys.byId(identityId),
    queryFn: () => fetchIdentityProfile(identityId),
    enabled,
  });

  // Extract provisioning states from identity data
  const provisioning = useMemo<ProvisioningState[]>(() => {
    const raw = identityQuery.data as Record<string, unknown> | null;
    if (!raw) return [];
    const prov = raw.provisioning as ProvisioningState[] | undefined;
    return Array.isArray(prov) ? prov : [];
  }, [identityQuery.data]);

  // 1b. The identity's entitlements: what its active policies and access requests grant it
  const entitlementsQuery = useQuery({
    queryKey: [...identityMapKeys.byId(identityId), 'entitlements'],
    queryFn: () => fetchIdentityEntitlements(identityId),
    enabled,
  });

  // Systems the entitlements are in, named as the catalogue names them (policies say 'entra-id'
  // where provisioning may say 'entra')
  const entitlementSystems = useMemo(
    () => [...new Set((entitlementsQuery.data ?? []).map((e) => e.targetSystem))],
    [entitlementsQuery.data],
  );

  // 2. Policy evaluation for this identity
  const policyQuery = useQuery({
    queryKey: [...identityMapKeys.byId(identityId), 'policy-intent'],
    queryFn: () => fetchPolicyEvaluation(identityId),
    enabled,
  });

  // 3. Drifts for this identity
  const driftsQuery = useQuery({
    queryKey: reconciliationKeys.drifts({ identityId }),
    queryFn: () => fetchDrifts({ identityId }),
    enabled,
  });

  // 4. Risk score
  const riskQuery = useQuery({
    queryKey: intelligenceKeys.riskScoreByIdentity(identityId),
    queryFn: () => fetchRiskScoreByIdentity(identityId),
    enabled,
  });

  // 5. Linked admin accounts
  const adminQuery = useQuery({
    queryKey: [...identityMapKeys.byId(identityId), 'admin-accounts'],
    queryFn: () => fetchLinkedAdminAccounts(identityId),
    enabled,
  });

  // 6. Entitlement catalog metadata per system of the entitlements (useQueries for dynamic list)
  const catalogResults = useQueries({
    queries: entitlementSystems.map((system) => ({
      queryKey: [...identityMapKeys.byId(identityId), 'catalog', system],
      queryFn: () => fetchEntitlementCatalog(system),
      enabled,
    })),
  });

  const catalogBySystem = useMemo(() => {
    const result: Record<string, EntitlementCatalogEntry[]> = {};
    entitlementSystems.forEach((system, idx) => {
      result[system] = catalogResults[idx]?.data ?? [];
    });
    return result;
  }, [entitlementSystems, catalogResults]);

  const isLoading =
    identityQuery.isLoading ||
    entitlementsQuery.isLoading ||
    policyQuery.isLoading ||
    driftsQuery.isLoading ||
    riskQuery.isLoading ||
    adminQuery.isLoading ||
    catalogResults.some((q) => q.isLoading);

  // Without the entitlements the map would show the systems as if the identity had none there.
  const isError =
    identityQuery.isError ||
    entitlementsQuery.isError ||
    policyQuery.isError ||
    driftsQuery.isError;

  const data = useMemo<IdentityEntitlementsData>(
    () => ({
      identity: identityQuery.data ?? null,
      provisioning,
      entitlements: entitlementsQuery.data ?? [],
      policyIntent: policyQuery.data ?? null,
      drifts: driftsQuery.data ?? [],
      riskScore: riskQuery.data ?? null,
      adminAccounts: adminQuery.data ?? [],
      catalogBySystem,
    }),
    [
      identityQuery.data,
      provisioning,
      entitlementsQuery.data,
      policyQuery.data,
      driftsQuery.data,
      riskQuery.data,
      adminQuery.data,
      catalogBySystem,
    ],
  );

  return { data, isLoading, isError };
}
