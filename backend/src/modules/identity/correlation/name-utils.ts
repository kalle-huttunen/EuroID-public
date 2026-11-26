/**
 * Name normalization and matching utilities for heuristic correlation.
 * Handles diacritics (Mäkinen → Makinen), hyphens, case.
 */

/**
 * Normalize a name for comparison: lowercase, strip diacritics, remove hyphens.
 * "Mäkinen-Virtanen" → "makinen virtanen"
 * "José" → "jose"
 * "  Bob  " → "bob"
 */
export function normalizeName(name: string): string {
  if (!name || typeof name !== 'string') return '';
  return name
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ');
}

/**
 * Levenshtein distance between two strings.
 */
function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array(m + 1)
    .fill(null)
    .map(() => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      );
    }
  }
  return dp[m][n];
}

/**
 * Compute similarity between two names (0-1).
 * Uses Levenshtein distance normalized by max length.
 * "Robert" vs "Bob" → ~0.33 (low)
 * "John" vs "Johhn" → ~0.8 (high — likely typo)
 * "Virtanen" vs "Wirtanen" → ~0.875 (high — likely typo)
 */
export function nameSimilarity(a: string, b: string): number {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const maxLen = Math.max(na.length, nb.length);
  const distance = levenshteinDistance(na, nb);
  return 1 - distance / maxLen;
}

export type NameMatchType = 'exact' | 'fuzzy' | 'none';

/**
 * Check if two full names match (firstName + lastName).
 * Returns confidence (0-1) and match type.
 *
 * Confidence table:
 * - Exact first+last (case-insensitive, diacritics normalized): 0.85
 * - Exact last, fuzzy first (>0.8): 0.65
 * - Fuzzy last (>0.8), exact first: 0.6
 * - Both fuzzy (>0.8): 0.6
 * - Below threshold: none
 */
export function matchNames(
  incoming: { firstName: string; lastName: string },
  existing: { firstName: string; lastName: string },
  fuzzyThreshold = 0.8,
): { confidence: number; matchType: NameMatchType } {
  const inFirst = normalizeName(incoming.firstName || '');
  const inLast = normalizeName(incoming.lastName || '');
  const exFirst = normalizeName(existing.firstName || '');
  const exLast = normalizeName(existing.lastName || '');

  if (!inFirst || !inLast || !exFirst || !exLast) {
    return { confidence: 0, matchType: 'none' };
  }

  const firstExact = inFirst === exFirst;
  const lastExact = inLast === exLast;
  const firstSim = nameSimilarity(incoming.firstName, existing.firstName);
  const lastSim = nameSimilarity(incoming.lastName, existing.lastName);

  if (firstExact && lastExact) {
    return { confidence: 0.85, matchType: 'exact' };
  }

  if (lastExact && firstSim >= fuzzyThreshold && !firstExact) {
    return { confidence: 0.65, matchType: 'fuzzy' };
  }

  if (firstExact && lastSim >= fuzzyThreshold && !lastExact) {
    return { confidence: 0.6, matchType: 'fuzzy' };
  }

  if (firstSim >= fuzzyThreshold && lastSim >= fuzzyThreshold) {
    return { confidence: 0.6, matchType: 'fuzzy' };
  }

  return { confidence: 0, matchType: 'none' };
}
