/**
 * The entitlement catalog entry a policy target stands for. A role-based rule (and an SoD policy,
 * which SodService matches against the rule's operations) names an entitlement by a system and a
 * target id of its choosing, often a group's display name, while the catalog, access requests and
 * the access graph key it by its native id. The entry is the one on the target's system with the
 * target id as its native id, else the only entry with a native id that has the target id as its
 * name there. A target the catalog does not know, or names more than once, has none: the caller
 * keeps the target's own id. Systems compare by `systemKey`, so a rule naming `entra` or
 * `active-directory` finds the catalog's `entra-id` or `ad` entries. Used by HeldAccessService (intelligence) and the access graph
 * (GraphResyncService, GraphSyncService, the SoD check of AccessExplorerService).
 */
import type { Model } from 'mongoose';
import { catalogSystemName, systemKey } from '@shared/utils/normalize-system-name';
import type { EntitlementCatalogDocument } from './schemas/entitlement-catalog.schema';

/** A system and the id a policy names an entitlement by there. */
export interface PolicyTarget {
  system: string;
  targetId: string;
}

/** A catalog entry with a native id, as the lookup answers it, with its privilege marking. */
export interface CatalogTargetEntry {
  system: string;
  nativeId: string;
  name: string;
  adminTier?: string;
  requiresAdminAccount?: boolean;
  riskLevel?: string;
}

export type CatalogTargetLookup = (target: PolicyTarget) => CatalogTargetEntry | undefined;

/** The lookup over catalog entries that have a native id. */
export function catalogTargetLookup(entries: CatalogTargetEntry[]): CatalogTargetLookup {
  const byNativeId = new Map<string, CatalogTargetEntry>();
  const byName = new Map<string, CatalogTargetEntry[]>();
  for (const entry of entries) {
    const system = systemKey(entry.system);
    byNativeId.set(`${system}::${entry.nativeId}`, entry);
    const key = `${system}::${entry.name}`;
    byName.set(key, [...(byName.get(key) ?? []), entry]);
  }
  return (target) => {
    const key = `${systemKey(target.system)}::${target.targetId}`;
    const sameName = byName.get(key) ?? [];
    return byNativeId.get(key) ?? (sameName.length === 1 ? sameName[0] : undefined);
  };
}

/** Reads the tenant's catalog entries the targets can stand for, and answers their lookup. */
export async function loadCatalogTargetLookup(
  catalogModel: Model<EntitlementCatalogDocument>,
  tenantId: string,
  targets: PolicyTarget[],
): Promise<CatalogTargetLookup> {
  if (!targets.length) return () => undefined;
  const targetIds = [...new Set(targets.map((t) => t.targetId))];
  // The catalog stores a system under its catalog name; a rule may name it otherwise
  const systems = [...new Set(targets.flatMap((t) => [catalogSystemName(t.system), t.system]))];
  const entries = (await catalogModel
    .find({
      tenantId,
      system: { $in: systems },
      nativeId: { $type: 'string', $ne: '' },
      $or: [{ nativeId: { $in: targetIds } }, { name: { $in: targetIds } }],
    })
    .select('system nativeId name adminTier requiresAdminAccount riskLevel')
    .lean()
    .exec()) as CatalogTargetEntry[];
  return catalogTargetLookup(entries);
}
