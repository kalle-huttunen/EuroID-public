/**
 * UPN Generator - Pure logic for generating candidate UPNs
 *
 * No API calls, no side effects. Used by EntraService to resolve
 * an available UPN before provisioning. Patterns are configurable.
 */

import type { UpnPattern } from './entra.interface';
import { DEFAULT_UPN_PATTERNS } from './entra.interface';

/** Minimal user shape for UPN generation */
export interface UpnUserInput {
  firstName?: string | null;
  lastName?: string | null;
  middleName?: string | null;
}

/** Sanitize for UPN: lowercase, trim, replace spaces/special chars */
function sanitize(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '')
    .replace(/[^a-z0-9._-]/g, '');
}

/**
 * Check if a UPN matches our domain (e.g., ends with @example.com)
 */
function matchesDomain(upn: string, domain: string): boolean {
  const cleanDomain = domain.replace(/^@/, '').trim();
  return upn.toLowerCase().endsWith(`@${cleanDomain.toLowerCase()}`);
}

/**
 * Generate UPN candidates in priority order.
 * Domain should NOT include @ (e.g., "example.com").
 *
 * @param user - User with firstName, lastName, middleName
 * @param domain - M365-verified domain (e.g., "example.com")
 * @param patterns - Pattern order (default: firstname.lastname, firstname.middleinitial.lastname, firstname.lastname{n})
 * @param maxNumericSuffix - Max suffix for firstname.lastname{n} (default: 10)
 * @param preferredUpn - Optional UPN from HR to try first (if it matches domain)
 */
export function generateUpnCandidates(
  user: UpnUserInput,
  domain: string,
  patterns: UpnPattern[] = DEFAULT_UPN_PATTERNS,
  maxNumericSuffix = 10,
  preferredUpn?: string | null,
): string[] {
  const first = sanitize(user.firstName || '');
  const last = sanitize(user.lastName || '');
  const middleInitial = user.middleName
    ? sanitize(user.middleName).charAt(0)
    : '';

  if (!first || !last) {
    return [];
  }

  const cleanDomain = domain.replace(/^@/, '').trim();
  const atDomain = cleanDomain ? `@${cleanDomain}` : '';

  const candidates: string[] = [];
  // If HR sent a UPN in our domain, try it first
  if (preferredUpn?.trim() && matchesDomain(preferredUpn, domain)) {
    candidates.push(preferredUpn.trim().toLowerCase());
  }

  for (const pattern of patterns) {
    switch (pattern) {
      case 'firstname.lastname': {
        candidates.push(`${first}.${last}${atDomain}`);
        break;
      }
      case 'firstname.middleinitial.lastname': {
        if (middleInitial) {
          candidates.push(`${first}.${middleInitial}.${last}${atDomain}`);
        } else {
          candidates.push(`${first}.${last}${atDomain}`);
        }
        break;
      }
      case 'firstname.lastname{n}': {
        for (let n = 1; n <= maxNumericSuffix; n++) {
          candidates.push(`${first}.${last}${n}${atDomain}`);
        }
        break;
      }
      case 'firstnamelastname': {
        candidates.push(`${first}${last}${atDomain}`);
        break;
      }
      case 'firstname_lastname': {
        candidates.push(`${first}_${last}${atDomain}`);
        break;
      }
      case 'flastname': {
        candidates.push(`${first.charAt(0)}${last}${atDomain}`);
        break;
      }
      default:
        break;
    }
  }

  // De-duplicate while preserving order
  return [...new Set(candidates)];
}
