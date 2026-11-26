/**
 * The `identity.sources[].sourceName` an inbound record lands under: its `sourceSystem`
 * lower-cased with whitespace turned into dashes (`'CSV HR'` -> `'csv-hr'`), `'hr-feed'` when unset.
 * Identity correlation stores sources under this name; HR leaver detection looks them up by it.
 */
export function toSourceName(sourceSystem?: string | null): string {
  return (sourceSystem || 'hr-feed').toLowerCase().replace(/\s+/g, '-');
}
