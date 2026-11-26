/**
 * Text search of the identity list (GET /identity?q=): the work email and the names, never the
 * PII fields. Pure: the Mongo filter only, applied by IdentityQueryService.findAllPaginated.
 */
import { escapeRegex } from '@shared/utils/escape-regex';

export const IDENTITY_SEARCH_MAX_LENGTH = 100;
/** Words of a search that count; more are ignored. */
const IDENTITY_SEARCH_MAX_WORDS = 5;
const IDENTITY_SEARCH_FIELDS = [
  'profile.email',
  'profile.firstName',
  'profile.lastName',
  'profile.displayName',
];

/**
 * Mongo filter of a text search: every word (up to five) must match one of the search fields,
 * anywhere in it and ignoring case. The words are escaped: no regex reaches MongoDB from input.
 */
export function identitySearchFilter(search: string): Record<string, unknown> {
  const words = search.split(/\s+/).filter(Boolean).slice(0, IDENTITY_SEARCH_MAX_WORDS);
  return {
    $and: words.map((word) => ({
      $or: IDENTITY_SEARCH_FIELDS.map((field) => ({
        [field]: { $regex: escapeRegex(word), $options: 'i' },
      })),
    })),
  };
}
