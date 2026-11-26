/**
 * Entitlement catalog reads (GET /entitlement-catalog?system=&type=, viewer): the groups,
 * licenses and directory roles connector discovery found in a target system. The source the
 * Policy Engine's own pickers read (components/policy-engine/hooks/usePolicyCatalog.ts), here as
 * TanStack queries for the SoD policy pickers.
 */
import { useQueries, useQuery } from '@tanstack/react-query';
import { axiosInstance } from '@api/data';
import { API_BASE } from '@api/constants';

const CATALOG_API = `${API_BASE}/entitlement-catalog`;

/** The `type` values the list route accepts. */
export type CatalogEntitlementType = 'Group' | 'License' | 'DirectoryRole';

export interface CatalogEntitlement {
  /** The id in the target system; older policy-registered entries may have none. */
  nativeId?: string;
  name: string;
  type: CatalogEntitlementType;
  origin: 'POLICY' | 'EXTERNAL';
  governanceLevel: 'STRICT' | 'OPEN';
  adminTier?: string;
}

export const entitlementCatalogKeys = {
  all: ['entitlement-catalog'] as const,
  list: (system: string, type: CatalogEntitlementType) =>
    [...entitlementCatalogKeys.all, 'list', system, type] as const,
};

export async function fetchCatalogEntitlements(
  system: string,
  type: CatalogEntitlementType,
): Promise<CatalogEntitlement[]> {
  const { data } = await axiosInstance.get<{ entitlements?: CatalogEntitlement[] }>(CATALOG_API, {
    params: { system, type },
  });
  return data?.entitlements ?? [];
}

/** One system's entries of one type, sorted by name (the backend's order). Idle without both. */
export function useCatalogEntitlements(system?: string, type?: CatalogEntitlementType) {
  return useQuery({
    queryKey: entitlementCatalogKeys.list(system ?? '', type ?? 'Group'),
    queryFn: () => fetchCatalogEntitlements(system as string, type as CatalogEntitlementType),
    enabled: !!system && !!type,
    staleTime: 60_000,
  });
}

/** Several system and type lists at once, e.g. to name the entitlements of a list of policies. */
export function useCatalogEntitlementLists(
  lists: Array<{ system: string; type: CatalogEntitlementType }>,
) {
  return useQueries({
    queries: lists.map(({ system, type }) => ({
      queryKey: entitlementCatalogKeys.list(system, type),
      queryFn: () => fetchCatalogEntitlements(system, type),
      staleTime: 60_000,
    })),
  });
}
