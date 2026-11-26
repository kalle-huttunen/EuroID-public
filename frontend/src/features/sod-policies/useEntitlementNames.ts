/**
 * Catalog names for the entitlements of a list of SoD policies: one catalog list per kind the
 * policies use (GET /entitlement-catalog?system=&type=), keyed like sod-labels' catalogKey.
 */
import { useCatalogEntitlementLists } from '@api/entitlement-catalog-api';
import type { ISodPolicy } from '../../interfaces';
import { catalogKey, catalogListsFor } from './sod-labels';

/** Names the policies' entitlements from the catalog lists of their kinds. */
export interface EntitlementNames {
  /** catalogKey → name */
  names: Map<string, string>;
  /** Kind keys whose catalog list loaded, so a missing name means "not in the catalog". */
  loadedKinds: Set<string>;
}

export function useEntitlementNames(policies: ISodPolicy[]): EntitlementNames {
  const kinds = catalogListsFor(policies);
  const results = useCatalogEntitlementLists(
    kinds.map((k) => ({ system: k.system, type: k.catalogType })),
  );
  const names = new Map<string, string>();
  const loadedKinds = new Set<string>();
  results.forEach((result, i) => {
    const k = kinds[i];
    if (!k || !result.data) return;
    loadedKinds.add(k.key);
    for (const e of result.data) {
      names.set(catalogKey(k.system, k.catalogType, e.nativeId ?? e.name), e.name);
    }
  });
  return { names, loadedKinds };
}
