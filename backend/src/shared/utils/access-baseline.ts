/**
 * Access baseline: the profile values an identity's policy access was last applied with, kept on
 * the identity (`accessBaseline`). It is the "before" side of the access preview and of
 * POST /identity/:id/access/re-evaluate: the policies are evaluated against the baseline and
 * against the current profile, and the difference is what the mover applies.
 *
 * Recorded at the first SYNCED provisioning of the identity (the profile onboarding evaluated)
 * and advanced by every mover run that completes (the attributes it evaluated). An HR sync or a
 * change outside the mover's trigger attributes does not advance it, so the preview shows it.
 *
 * Pure and dependency-free (the mover workflow imports it).
 */

/**
 * Profile keys a baseline leaves out: names, contact data and identifiers no access policy
 * reads (this covers identity-pii.ts PII_FIELDS; access-baseline.spec.ts pins it), and
 * bookkeeping that changes without any change in access.
 */
export const ACCESS_BASELINE_EXCLUDED_KEYS: readonly string[] = [
  'firstName',
  'middleName',
  'lastName',
  'preferredName',
  'displayName',
  'email',
  'personalEmail',
  'mobilePhone',
  'workPhone',
  'officeExtension',
  'address',
  'postalCode',
  'userPrincipalName',
  'samAccountName',
  'employeeId',
  'employeeNumber',
  '_id',
  'id',
  'tenantId',
  'sourceSystem',
  'sourceUserId',
  'correlationId',
  'overrides',
  'isLoginDisabled',
  'createdAt',
  'createdBy',
  'updatedAt',
  'lastSyncedAt',
];

const EXCLUDED = new Set(ACCESS_BASELINE_EXCLUDED_KEYS);

export type AccessBaselineAttributes = Record<string, unknown>;

/** Stored on the identity as `accessBaseline`. */
export interface AccessBaseline {
  attributes: AccessBaselineAttributes;
  recordedAt: Date;
  /** provisioning: the first SYNCED target; mover: a completed mover run. */
  recordedBy: 'provisioning' | 'mover';
}

/** The baseline attributes of a policy profile (IdentityService.buildProfileWithContractsForPolicy). */
export function toAccessBaseline(profile: Record<string, unknown>): AccessBaselineAttributes {
  const out: AccessBaselineAttributes = {};
  for (const [key, value] of Object.entries(profile)) {
    if (EXCLUDED.has(key) || value === undefined) continue;
    out[key] = value;
  }
  return out;
}

/** JSON with sorted keys; a Date and its ISO string compare equal, as do null and undefined. */
function canonical(value: unknown): string {
  if (value === undefined || value === null) return 'null';
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const quote = (key: string) => JSON.stringify(key);
    return `{${entries.map(([k, v]) => quote(k) + ':' + canonical(v)).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * The attributes whose value in `current` differs from the baseline, each with its baseline value
 * (null when the baseline has none). Spread over the current profile it gives the profile access
 * was last applied with: the mover's `previousAttributes`.
 */
export function accessBaselineChanges(
  baseline: AccessBaselineAttributes,
  current: AccessBaselineAttributes,
): Record<string, unknown> {
  const changes: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(baseline), ...Object.keys(current)]);
  for (const key of keys) {
    if (EXCLUDED.has(key)) continue;
    if (canonical(baseline[key]) !== canonical(current[key])) changes[key] = baseline[key] ?? null;
  }
  return changes;
}

/**
 * The before-values of the access attributes among `fields` (the fields an edit wrote) whose
 * value differs between `before` and `after`, null when `before` has none: identity.updated's
 * `previousAttributes`, the "before" profile of an edit for the mover. Names, contact data and
 * identifiers are left out, and so is a field the edit wrote with its old value.
 */
export function changedAccessAttributes(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  fields: string[],
): Record<string, unknown> {
  const pick = (source: Record<string, unknown>) =>
    Object.fromEntries(fields.map((field) => [field, source[field]]));
  return accessBaselineChanges(pick(before), pick(after));
}

/** The values `profile` has for `fields` (null when it has none): what a mover run applied. */
export function appliedAttributes(
  profile: Record<string, unknown>,
  fields: string[],
): AccessBaselineAttributes {
  const out: AccessBaselineAttributes = {};
  for (const field of fields) {
    if (!EXCLUDED.has(field)) out[field] = profile[field] ?? null;
  }
  return out;
}
