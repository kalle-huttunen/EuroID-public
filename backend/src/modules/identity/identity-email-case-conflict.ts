/**
 * Live identities whose email differs from a record's only in case, found without a scan.
 *
 * Every email is stored and compared lower-cased since the 2026-11-25 release (shared/utils/
 * email.ts). Migration 20261125000003 left alone two or more live identities of a tenant with one
 * address in different cases and raised each group as a correlation conflict (matchedBy email,
 * matchedValue the flagged identity's own email). Until a person merges them (or one of them
 * syncs, which lower-cases it), the exact lookups miss them, and a new record of that person
 * would mint a third identity. Before a mint, correlation therefore also looks for an open email
 * conflict naming the address in any case and holds the record on it.
 *
 * Only open conflicts are read: the partial index EMAIL_CONFLICT_INDEX covers identities with
 * `metadata.requiresReview: true`, so the case-insensitive match runs over the tenant's open
 * conflicts, never over all of its identities. A mixed-case pair with no open conflict (the
 * conflict dismissed) is not found; its first sync lower-cases one member, which the exact
 * lookups then find.
 */
import { escapeRegex } from '@shared/utils/escape-regex';
import { normalizeEmail } from '@shared/utils/email';

/** Name of the partial index (identity.schema.ts, migration 20261126000003). */
export const EMAIL_CONFLICT_INDEX = 'tenantId_1_open_conflict_matchedBy_1';

/** The index key and options; the schema and the migration both use these. */
export const EMAIL_CONFLICT_INDEX_KEY = {
  tenantId: 1,
  'metadata.conflictDetails.matchedBy': 1,
} as const;
export const EMAIL_CONFLICT_INDEX_OPTIONS = {
  name: EMAIL_CONFLICT_INDEX,
  partialFilterExpression: { 'metadata.requiresReview': true },
};

/** A live identity of the tenant with an open email conflict naming `email` in any case. */
export function emailCaseConflictFilter(tenantId: string, email: string): Record<string, unknown> {
  return {
    tenantId,
    'metadata.requiresReview': true,
    'metadata.conflictDetails.matchedBy': 'email',
    'metadata.conflictDetails.matchedValue': {
      $regex: `^${escapeRegex(normalizeEmail(email))}$`,
      $options: 'i',
    },
    deletedAt: null,
  };
}
