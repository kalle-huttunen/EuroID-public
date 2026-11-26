/**
 * The groups, directory roles and licenses the policy assigns a person in Entra ID, for the
 * impact analysis's Entra ID metadata (ImpactEntraMetadataService): from the entitlement changes
 * of the person's entra-id delta, named by the entitlement catalog, a license's availability from
 * the units discovery last read (catalog licenseUnits). `notKnown` says what the answer cannot
 * tell.
 */
import type { EntitlementChange, EntraUserMetadata } from './impact-analysis.types';

/** A catalog entry of Entra ID, as far as the metadata reads it. */
export interface IntentCatalogEntry {
  nativeId?: string;
  name: string;
  type: string;
  licenseUnits?: { consumed?: number; enabled?: number };
}

const NOT_READ =
  'Conditional access policies: EuroID does not read them, so which apply is not shown.';

export function entraIntentMetadata(
  changes: EntitlementChange[],
  catalog: IntentCatalogEntry[],
): Pick<EntraUserMetadata, 'licenses' | 'groups' | 'roles' | 'notKnown'> {
  const entryOf = (targetId: string, type: string) =>
    catalog.find((e) => e.type === type && e.nativeId === targetId) ??
    catalog.find((e) => e.type === type && e.name === targetId);
  const notKnown = [NOT_READ];
  const added = changes.filter((c) => c.action === 'add');

  const groups = added
    .filter((c) => c.type === 'group')
    .map((c) => {
      const entry = entryOf(c.targetId, 'Group');
      if (!entry) {
        notKnown.push(
          `Group ${c.targetId} is not in the entitlement catalog: whether it exists in Entra ID ` +
            'is not known until discovery finds it.',
        );
      }
      return entry?.name ?? c.targetId;
    });

  const roles = added
    .filter((c) => c.type === 'role')
    .map((c) => {
      const entry = entryOf(c.targetId, 'DirectoryRole');
      if (!entry) {
        notKnown.push(
          `Directory role ${c.targetId} is not in the entitlement catalog: whether it exists in ` +
            'Entra ID is not known until discovery finds it.',
        );
      }
      return entry?.name ?? c.targetId;
    });

  const licenses = added
    .filter((c) => c.type === 'license')
    .map((c) => {
      const entry = entryOf(c.targetId, 'License');
      const units = entry?.licenseUnits;
      const known = typeof units?.consumed === 'number' && typeof units?.enabled === 'number';
      if (!known) {
        notKnown.push(
          `Units left of license ${c.targetId}: not known until Entra ID discovery has read it.`,
        );
      }
      return {
        sku: entry?.nativeId ?? c.targetId,
        name: entry?.name ?? c.targetId,
        assigned: true,
        available: known ? Math.max(0, units!.enabled! - units!.consumed!) : null,
      };
    });

  return { licenses, groups, roles, notKnown };
}
