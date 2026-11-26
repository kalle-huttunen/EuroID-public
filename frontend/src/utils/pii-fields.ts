/**
 * Identity PII fields. The API returns them masked (e.g. "m•••@example.com",
 * "+358 •• ••• 4567"); the clear value comes only from the audited reveal
 * (revealPiiField in api/identity-api.ts).
 */

export const PII_FIELDS = ['personalEmail', 'mobilePhone', 'workPhone', 'officeExtension'] as const;
export type PiiFieldName = (typeof PII_FIELDS)[number];

/**
 * Drops PII fields whose value is still the one the API returned (the mask), so a save
 * never sends a masked value back. Fields edited after a reveal are kept.
 */
export function omitUnchangedPiiFields<T extends Record<string, unknown>>(
  values: T,
  original: Partial<Record<string, unknown>>,
): Partial<T> {
  const result: Record<string, unknown> = { ...values };
  for (const field of PII_FIELDS) {
    if (result[field] === original[field]) delete result[field];
  }
  return result as Partial<T>;
}

/** Copy without PII fields, for requests that must not echo masked values (e.g. simulation). */
export function withoutPiiFields<T extends object>(record: T): T {
  const result = { ...record } as Record<string, unknown>;
  for (const field of PII_FIELDS) delete result[field];
  return result as T;
}
