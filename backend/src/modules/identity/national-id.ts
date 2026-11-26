/**
 * The national ID of an incoming record (HETU, SSN): the hashedNationalId correlation rule reads
 * it from the field the rule names (`nationalIdSourceField`, default `hetu`) or from
 * `customAttributes.<field>`. Correlation hashes it into `correlationId` and then removes it, with
 * `hetu` always, from the record before anything holds it (rawData, the profile, a held conflict
 * row). An update of a stored identity (PATCH /identity/:id, SCIM inbound) loses them the same way
 * (IdentityMutationService). National identity numbers are restricted data (Finnish Data
 * Protection Act, GDPR art. 87). The strip-raw-national-id migration removes the same keys from
 * what was stored before.
 */
import { StandardUserSchema } from '@shared/dtos/standard-user.dto';
import type { CorrelationConfig, CorrelationRule } from '@shared/types/correlation-config';

/** The field a hashedNationalId rule reads when it names none, and a key always removed. */
export const DEFAULT_NATIONAL_ID_FIELD = 'hetu';

/**
 * StandardUserDto's own fields. A national ID never sits in one of them (a rule naming `email`
 * would remove the record's email), so they are left at the top level of a record.
 */
const STANDARD_USER_FIELDS: ReadonlySet<string> = new Set(Object.keys(StandardUserSchema.shape));

/** The tenant's hashedNationalId rule, if it has one. */
export function nationalIdRule(
  config: Pick<CorrelationConfig, 'rules'> | null | undefined,
): CorrelationRule | undefined {
  return config?.rules?.find((r) => r.strategy === 'hashedNationalId');
}

/** The field the rule reads: its `nationalIdSourceField`, else `hetu`. */
export function nationalIdField(rule: CorrelationRule): string {
  return rule.nationalIdSourceField?.trim() || DEFAULT_NATIONAL_ID_FIELD;
}

/** The keys removed from every record: the rule's field and `hetu`. */
export function nationalIdKeys(rule: CorrelationRule | undefined): string[] {
  return [...new Set([...(rule ? [nationalIdField(rule)] : []), DEFAULT_NATIONAL_ID_FIELD])];
}

/** Whether `key` may be removed from the top level of a record (not a StandardUserDto field). */
export function isRemovableTopLevelKey(key: string): boolean {
  return !STANDARD_USER_FIELDS.has(key);
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A value as text, '' for none. */
function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  return value != null ? String(value) : '';
}

/** The record's value of `field`: the field itself, else `customAttributes.<field>` ('' for none). */
export function nationalIdValue(record: Record<string, unknown>, field: string): string {
  const custom = isPlainObject(record.customAttributes) ? record.customAttributes : undefined;
  return asText(record[field] ?? custom?.[field]);
}

/**
 * Whether `record` can hold a national ID or a correlationId: a customAttributes, a correlationId
 * or a key that is no StandardUserDto field (where a rule's field can sit).
 */
export function mayCarryNationalId(record: Record<string, unknown>): boolean {
  return Object.keys(record).some(
    (key) => key === 'customAttributes' || key === 'correlationId' || isRemovableTopLevelKey(key),
  );
}

/**
 * Take the national ID out of `record`: the rule's field and `hetu` are removed in any case
 * (removeNationalIds). With the rule, a correlationId the record brings is removed too, since the
 * rule matches only on a hash EuroID computes, and `hash(value)` is returned when the record has a
 * value (null when `hash` gives none: no secret). Without the rule nothing is hashed. The caller
 * sets the hash as the record's correlationId after taking what it keeps of the record.
 */
export function takeNationalId(
  record: Record<string, unknown>,
  rule: CorrelationRule | undefined,
  hash: (value: string) => string | null,
): string | null {
  const value = rule ? nationalIdValue(record, nationalIdField(rule)) : '';
  removeNationalIds(record, nationalIdKeys(rule));
  if (!rule) return null;
  delete record.correlationId;
  return value.trim() ? hash(value) : null;
}

/**
 * Remove `keys` from `record` (top level, except StandardUserDto's own fields) and from its
 * customAttributes. customAttributes is replaced, not changed in place (a caller may share the
 * object), and left out when nothing else is in it. True when something was removed.
 */
export function removeNationalIds(
  record: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  let removed = false;
  for (const key of keys) {
    if (isRemovableTopLevelKey(key) && Object.prototype.hasOwnProperty.call(record, key)) {
      delete record[key];
      removed = true;
    }
  }
  const custom = record.customAttributes;
  if (isPlainObject(custom) && keys.some((k) => Object.prototype.hasOwnProperty.call(custom, k))) {
    const kept = Object.fromEntries(Object.entries(custom).filter(([k]) => !keys.includes(k)));
    if (Object.keys(kept).length > 0) record.customAttributes = kept;
    else delete record.customAttributes;
    removed = true;
  }
  return removed;
}

/** The `rawData` of a source entry (or of a held conflict row), when it has one. */
function rawDataOf(entry: unknown): Record<string, unknown> | undefined {
  return isPlainObject(entry) && isPlainObject(entry.rawData) ? entry.rawData : undefined;
}

/** removeNationalIds on a held conflict row (`conflictDetails.incomingSource.rawData`), in place. */
export function removeNationalIdsFromConflict(
  conflictDetails: unknown,
  keys: readonly string[],
): void {
  const raw = isPlainObject(conflictDetails)
    ? rawDataOf(conflictDetails.incomingSource)
    : undefined;
  if (raw) removeNationalIds(raw, keys);
}

/**
 * removeNationalIds on every record a stored identity keeps, in place: its profile, each source's
 * rawData and a held conflict row. For state captured before the cleanup (a bulk rollback
 * snapshot, IdentityMutationService.restoreHubState).
 */
export function removeNationalIdsFromHubState(
  state: { profile?: unknown; sources?: unknown; metadata?: unknown },
  keys: readonly string[],
): void {
  if (isPlainObject(state.profile)) removeNationalIds(state.profile, keys);
  for (const source of Array.isArray(state.sources) ? state.sources : []) {
    const raw = rawDataOf(source);
    if (raw) removeNationalIds(raw, keys);
  }
  if (isPlainObject(state.metadata)) {
    removeNationalIdsFromConflict(state.metadata.conflictDetails, keys);
  }
}
