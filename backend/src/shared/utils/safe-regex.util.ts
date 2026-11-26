/**
 * Safe regex evaluation — ReDoS protection.
 * Validates patterns with safe-regex2 before execution; rejects dangerous patterns.
 */

import safe from 'safe-regex2';

/**
 * Safely test a string against a regex pattern.
 * Returns false if the pattern is unsafe (ReDoS risk) or if evaluation would block.
 */
export function safeRegexTest(pattern: string, value: string, flags = 'i'): boolean {
  if (!pattern || typeof pattern !== 'string') return false;
  if (!safe(pattern)) return false;
  try {
    const re = new RegExp(pattern, flags);
    return re.test(value);
  } catch {
    return false;
  }
}

/**
 * Validate a regex pattern for ReDoS safety. Use when saving policies.
 * @returns true if safe, false if dangerous
 */
export function isSafeRegex(pattern: string): boolean {
  if (!pattern || typeof pattern !== 'string') return false;
  return safe(pattern);
}
