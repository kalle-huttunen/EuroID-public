/**
 * A manual edit of a trigger attribute that an HR contract carries (department, job title)
 * overrides the HR contract's value in policy evaluation until HR changes that value.
 *
 * The policies evaluate the profile and, next to it, one contract per HR source with that source's
 * title and department (IdentityOnionService.buildProfileWithContractsForPolicy). After an edit of
 * the department in the profile, the HR record still carries the old one, so the identity matched
 * both departments and the mover never removed the old department's access. PATCH /identity/:id
 * therefore records, per edited attribute, the HR values the edit replaced, by source
 * (`metadata.manualOverrides`). While a source still sends the value recorded for it, its contract
 * takes the profile's value instead; once HR sends another value, HR wins again.
 *
 * Since 2026-11-24 PATCH /identity/:id refuses an edit of a field an HR source masters, so these
 * overrides come from edits of fields EuroID keeps (no HR source masters them). An HR-mastered
 * department or title is overridden by an attribute control instead (attribute-controls.ts,
 * controlledContractValue below), which holds until it is removed or expires.
 *
 * Pure and dependency-free.
 */

/** The profile attributes a contract carries, with the keys a source record holds each under. */
const CONTRACT_KEYS = {
  departmentName: ['departmentName', 'department', 'departmentCode'],
  jobTitle: ['jobTitle', 'title'],
} as const;

export type ContractAttribute = keyof typeof CONTRACT_KEYS;

const CONTRACT_ATTRIBUTES = Object.keys(CONTRACT_KEYS) as ContractAttribute[];

/**
 * Per edited attribute: source name -> the value that source's record had when a manual edit
 * replaced it. Stored on the identity as `metadata.manualOverrides`.
 */
export type ManualOverrides = Partial<Record<ContractAttribute, Record<string, string>>>;

/** The source records an edit compares: their names, roles and raw data. */
export interface SourceRecord {
  sourceName: string;
  sourceRole?: string;
  rawData?: Record<string, unknown>;
}

const text = (value: unknown): string =>
  value === undefined || value === null ? '' : String(value);

/** The value a source record holds for `attribute`, as a contract reads it ('' for none). */
export function sourceValue(
  attribute: ContractAttribute,
  raw: Record<string, unknown> | undefined,
): string {
  for (const key of CONTRACT_KEYS[attribute]) {
    const value = raw?.[key];
    if (value !== undefined && value !== null) return text(value);
  }
  return '';
}

/**
 * The manual overrides after an edit from `before` to `after` (profile values). For each contract
 * attribute the edit changed, the non-target sources whose value it replaces: those holding the
 * value the profile had, and those an earlier edit already overrides with the value they still
 * hold. A source that holds the new value needs no override. Attributes the edit left as they
 * were keep their entries. Undefined when nothing is overridden.
 */
export function overridesAfterEdit(
  current: ManualOverrides | undefined,
  sources: SourceRecord[],
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): ManualOverrides | undefined {
  const next: ManualOverrides = { ...current };
  for (const attribute of CONTRACT_ATTRIBUTES) {
    const replaced = text(before[attribute]);
    const value = text(after[attribute]);
    if (replaced === value) continue;
    const overridden: Record<string, string> = {};
    for (const source of sources) {
      if (source.sourceRole === 'target') continue;
      const held = sourceValue(attribute, source.rawData);
      if (!held || held === value) continue;
      if (held === replaced || current?.[attribute]?.[source.sourceName] === held) {
        overridden[source.sourceName] = held;
      }
    }
    if (Object.keys(overridden).length > 0) next[attribute] = overridden;
    else delete next[attribute];
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

/**
 * The value the contract built from `source` has for `attribute`: the profile's while a manual
 * edit overrides the value the source still holds, else the source's own.
 */
export function contractValue(
  attribute: ContractAttribute,
  source: SourceRecord,
  profile: Record<string, unknown>,
  overrides: ManualOverrides | undefined,
): string {
  const held = sourceValue(attribute, source.rawData);
  const recorded = overrides?.[attribute]?.[source.sourceName];
  return held && recorded === held ? text(profile[attribute]) : held;
}

/**
 * The value an attribute control (controls.manualDepartment / manualJobTitle,
 * attribute-controls.ts) gives the contract built from `source`, undefined when it gives none.
 * It replaces the attribute in the primary HR contract, the one the profile takes it from, and in
 * every other HR contract that holds the primary's own value (the same job reported by two
 * sources), whatever value HR sends meanwhile: the profile and the contracts agree while the
 * control is set. A contract with another value (a second employment) keeps it.
 */
export function controlledContractValue(
  attribute: ContractAttribute,
  source: SourceRecord,
  primary: SourceRecord | undefined,
  control: string | undefined,
): string | undefined {
  if (control === undefined) return undefined;
  if (!primary || source === primary || source.sourceName === primary.sourceName) return control;
  const held = sourceValue(attribute, source.rawData);
  return held && held === sourceValue(attribute, primary.rawData) ? control : undefined;
}
