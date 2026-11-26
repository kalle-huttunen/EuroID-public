/**
 * Contract-critical fields (Recon Config `contractCriticalFields`) always come from the primary HR
 * contract (ReconciliationService: no master applies to them). A mastery setting that names another
 * source for one of them, a secondary HR source or a target, claims an owner reconcile never uses,
 * so the saves that store mastery refuse it (owner decision 2026-11-24): the default mastery
 * (PUT /admin/reconciliation-config), in the Design studio (POST /blueprints/save) the Brain's
 * Field Mastery and an HR source node's mastery fields, and an installed connector's mastery
 * fields (POST /connectors/:name/install, PATCH /connectors/:name). Naming the primary itself is
 * accepted.
 *
 * Pure and dependency-free.
 */

/** An HR connector with the settings that choose the primary contract (Contract Tag, priority). */
export interface HrConnectorRank {
  name: string;
  ingestPriority: number;
  contractTag?: string;
}

/** One mastery setting to check: where it is (for the message) and field -> the sources named. */
export interface MasterySetting {
  label: string;
  entries: Record<string, string[] | undefined>;
}

/**
 * The HR source the Contract Tag and priority make primary, as reconcile picks it for an identity
 * that has records from all of them (resolvePrimaryHrSource, without a record's own contract
 * type): the connectors tagged PRIMARY, else all of them, by lowest ingest priority, then Recon
 * Config's source priority, then name. Without connector settings: the first HR source tag in
 * Recon Config's source priority.
 */
export function configuredPrimaryHrSource(
  connectors: HrConnectorRank[],
  hrSourceTags: string[],
  sourcePriorityOrder: string[],
): string | undefined {
  const order = sourcePriorityOrder.map((name) => name.toLowerCase());
  const orderOf = (name: string) => {
    const index = order.indexOf(name.toLowerCase());
    return index === -1 ? 999 : index;
  };
  if (connectors.length > 0) {
    const tagged = connectors.filter((c) => c.contractTag === 'PRIMARY');
    return [...(tagged.length > 0 ? tagged : connectors)].sort(
      (a, b) =>
        a.ingestPriority - b.ingestPriority ||
        orderOf(a.name) - orderOf(b.name) ||
        a.name.localeCompare(b.name),
    )[0]?.name;
  }
  return [...hrSourceTags].sort((a, b) => orderOf(a) - orderOf(b) || a.localeCompare(b))[0];
}

/** An HR source node's mastery fields as a setting: each field names that source. */
export function sourceMasterySetting(source: {
  name: string;
  masteryFields?: string[];
}): MasterySetting {
  return {
    label: `Field Mastery of source ${source.name}`,
    entries: Object.fromEntries(
      (source.masteryFields ?? []).map((field) => [field, [source.name]]),
    ),
  };
}

/**
 * Each entry of a contract-critical field that names a source other than `primary`, as
 * "<label>: <field> names <sources>". Empty when there is none. Without a primary every name of a
 * contract-critical field is one.
 */
export function contractCriticalMasteryProblems(
  settings: MasterySetting[],
  contractCriticalFields: string[],
  primary: string | undefined,
): string[] {
  const critical = new Set(contractCriticalFields);
  const isPrimary = (name: string) => !!primary && name.toLowerCase() === primary.toLowerCase();
  const problems: string[] = [];
  for (const { label, entries } of settings) {
    for (const [field, names] of Object.entries(entries)) {
      if (!critical.has(field)) continue;
      const others = (names ?? []).filter((name) => !isPrimary(name));
      if (others.length > 0) problems.push(`${label}: ${field} names ${others.join(', ')}`);
    }
  }
  return problems;
}

/** The 400 message for `problems`: what is refused, why, and what to do. */
export function contractCriticalMasteryMessage(
  problems: string[],
  primary: string | undefined,
): string {
  const driver = primary
    ? `the primary HR contract (now ${primary})`
    : 'the primary HR contract (none is configured)';
  return (
    `${problems.join('; ')}. Contract-critical fields always come from ${driver}; a secondary ` +
    'HR source or a target cannot master them. Remove these entries, and choose the primary ' +
    'contract through the Contract Tag and ingest priority of the HR sources.'
  );
}
