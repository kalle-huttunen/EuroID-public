/**
 * Connector system name normalization utilities.
 * Pure TypeScript — no NestJS dependencies (importable from Temporal workflows).
 *
 * @see docs/tasks/CURRENT_TASK_147.md
 */

/** Strip hyphens and lowercase a connector system name. */
export function normalizeSystemName(name: string | undefined | null): string {
  return (name ?? '').toLowerCase().replace(/-/g, '');
}

/** Map a raw system name to a known system type. */
export function getSystemType(system: string | undefined | null): 'entra' | 'ad' | 'unknown' {
  const n = normalizeSystemName(system);
  if (n === 'entra' || n === 'entraid') return 'entra';
  if (n === 'ad' || n === 'activedirectory') return 'ad';
  return 'unknown';
}

/**
 * A system as the policy engine and the entitlement catalog name it: `entra-id` for Entra ID
 * (`entra`, `entraid`), `ad` for Active Directory (`active-directory`), any other name as given.
 */
export function catalogSystemName(system: string | undefined | null): string {
  const type = getSystemType(system);
  if (type === 'entra') return 'entra-id';
  if (type === 'ad') return 'ad';
  return system ?? '';
}

/** One key for every name of one system: its catalogSystemName without case and dashes. */
export function systemKey(system: string | undefined | null): string {
  return normalizeSystemName(catalogSystemName(system));
}
