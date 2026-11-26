/** Parsed SCIM filter for MongoDB-compatible queries */
export interface SCIMFilterResult {
  [key: string]: unknown; // MongoDB query object
}

/**
 * SCIM attribute → MongoDB field name mapping.
 * Extend this map when new SCIM attributes need filter support.
 */
const ATTRIBUTE_MAP: Record<string, string> = {
  userName: 'userName',
  displayName: 'displayName',
  'name.givenName': 'name.givenName',
  'name.familyName': 'name.familyName',
  'emails.value': 'emails.value',
  active: 'active',
  externalId: 'externalId',
  title: 'title',
  // The entitlement catalog field ScimFilterService.parseGroupFilter names (SH-1, allowlist)
  name: 'name',
};

/** A SCIM filter operator this parser reads (RFC 7644 section 3.4.2.2). */
export type SCIMFilterOperator = 'eq' | 'ne' | 'co' | 'sw' | 'gt' | 'ge' | 'lt' | 'le' | 'pr';

/** One `attribute op "value"` clause, as written (the attribute is not checked here). */
export interface SCIMFilterClause {
  attribute: string;
  op: SCIMFilterOperator;
  /** The value, quotes removed; absent for `pr`. */
  value?: string;
}

/**
 * Parse a single-clause SCIM filter (`userName eq "john"`, `active eq true`, `title pr`).
 * Complex filters (and/or/not/grouping) and a missing value throw an Error.
 */
export function parseSCIMFilterClause(filterString: string): SCIMFilterClause {
  const trimmed = filterString.trim();

  // Reject complex filters early
  if (/\b(and|or|not)\b/i.test(trimmed) || trimmed.includes('(')) {
    throw new Error(
      'Complex SCIM filters (and/or/not/grouping) are not supported. Use a single attribute filter.',
    );
  }

  // Pattern: attribute op "value"  (quoted value) or attribute op value (boolean/number)
  const match = trimmed.match(/^(\S+)\s+(eq|co|sw|ne|gt|ge|lt|le|pr)\s*(?:"([^"]*)"|(\S+))?$/i);
  if (!match) {
    throw new Error(`Invalid SCIM filter syntax: "${filterString}"`);
  }

  const [, attribute, rawOp, quotedValue, unquotedValue] = match;
  const op = rawOp.toLowerCase() as SCIMFilterOperator;
  const value = quotedValue ?? unquotedValue;
  if (op !== 'pr' && value === undefined) {
    throw new Error(`SCIM filter operator "${op}" requires a value`);
  }
  return op === 'pr' ? { attribute, op } : { attribute, op, value };
}

/**
 * Parse a basic SCIM filter string to a MongoDB-compatible query.
 *
 * Supports:
 *   eq  → exact match
 *   co  → contains (case-insensitive regex)
 *   sw  → starts with (case-insensitive regex)
 *
 * Only single-clause filters are supported (e.g. `userName eq "john"`).
 * Complex filters (and/or/not/grouping) throw an error.
 *
 * @param filterString - The raw SCIM filter expression
 * @returns A MongoDB-compatible query object
 * @throws Error when the filter syntax is unsupported
 */
export function parseSCIMFilter(filterString: string): SCIMFilterResult {
  const { attribute, op, value } = parseSCIMFilterClause(filterString);

  // Reject unknown attributes (SH-1 — defense-in-depth against NoSQL injection)
  const mongoField = ATTRIBUTE_MAP[attribute];
  if (mongoField === undefined) {
    throw new Error(`Unsupported SCIM filter attribute: "${attribute}"`);
  }

  // "pr" (present) operator — no value required
  if (op === 'pr' || value === undefined) {
    return { [mongoField]: { $exists: true, $ne: null } };
  }

  switch (op) {
    case 'eq': {
      // Boolean-aware: "true"/"false" → boolean
      if (value.toLowerCase() === 'true') return { [mongoField]: true };
      if (value.toLowerCase() === 'false') return { [mongoField]: false };
      return { [mongoField]: value };
    }
    case 'ne':
      return { [mongoField]: { $ne: value } };
    case 'co':
      return { [mongoField]: { $regex: escapeRegex(value), $options: 'i' } };
    case 'sw':
      return { [mongoField]: { $regex: `^${escapeRegex(value)}`, $options: 'i' } };
    case 'gt':
      return { [mongoField]: { $gt: value } };
    case 'ge':
      return { [mongoField]: { $gte: value } };
    case 'lt':
      return { [mongoField]: { $lt: value } };
    case 'le':
      return { [mongoField]: { $lte: value } };
    default:
      throw new Error(`Unsupported SCIM filter operator: "${op}"`);
  }
}

/** Escape special regex characters in a user-provided string */
export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
