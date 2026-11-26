/**
 * CredentialGenerationService — centralized password generation for target system provisioning
 *
 * Replaces connector-local password generators (AD, Entra) with a single, configurable service.
 * Connectors are "dumb pipes" and must not contain credential policy logic.
 * The password policy (length, character classes, exclusions) is a Brain responsibility.
 */

import { Injectable } from '@nestjs/common';
import { randomInt } from 'crypto';

export interface CredentialPolicy {
  /** Total password length (minimum: 4, one per class). Default: 20 */
  length?: number;
  /** Uppercase character pool. Default: full A-Z */
  upperChars?: string;
  /** Lowercase character pool. Default: full a-z */
  lowerChars?: string;
  /** Digit character pool. Default: 0-9 */
  digitChars?: string;
  /** Special character pool. Default: '!@#$%^&*()-_=+' */
  specialChars?: string;
}

const DEFAULT_UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DEFAULT_LOWER = 'abcdefghijklmnopqrstuvwxyz';
const DEFAULT_DIGITS = '0123456789';
const DEFAULT_SPECIAL = '!@#$%^&*()-_=+';
const DEFAULT_LENGTH = 20;
const MIN_LENGTH = 4; // One guaranteed character per class

@Injectable()
export class CredentialGenerationService {
  /**
   * Generate a cryptographically secure password satisfying the given policy.
   *
   * Guarantees at least one character from each class (upper, lower, digit, special)
   * and applies Fisher-Yates shuffle to avoid positional predictability.
   */
  generatePassword(policy?: CredentialPolicy): string {
    const upper = policy?.upperChars ?? DEFAULT_UPPER;
    const lower = policy?.lowerChars ?? DEFAULT_LOWER;
    const digits = policy?.digitChars ?? DEFAULT_DIGITS;
    const special = policy?.specialChars ?? DEFAULT_SPECIAL;
    const length = Math.max(policy?.length ?? DEFAULT_LENGTH, MIN_LENGTH);

    const all = upper + lower + digits + special;
    if (all.length === 0) {
      throw new Error('CredentialPolicy must define at least one character in a pool');
    }

    // Guarantee at least one character from each non-empty class
    const guaranteed: string[] = [];
    if (upper.length > 0) guaranteed.push(upper[randomInt(upper.length)]);
    if (lower.length > 0) guaranteed.push(lower[randomInt(lower.length)]);
    if (digits.length > 0) guaranteed.push(digits[randomInt(digits.length)]);
    if (special.length > 0) guaranteed.push(special[randomInt(special.length)]);

    // Fill remaining positions from the full character set
    const remaining = Array.from(
      { length: length - guaranteed.length },
      () => all[randomInt(all.length)],
    );

    // Fisher-Yates shuffle to avoid predictable positions for guaranteed chars
    const chars = [...guaranteed, ...remaining];
    for (let i = chars.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [chars[i], chars[j]] = [chars[j], chars[i]];
    }

    return chars.join('');
  }
}
