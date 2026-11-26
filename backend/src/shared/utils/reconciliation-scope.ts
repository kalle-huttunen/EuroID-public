/**
 * The scan scope of a reconciliation run: ReconciliationConfig.includedDepartments and
 * excludedUsers (POST /reconciliation/start-daily). One reading for every place that applies it:
 * the API's check, the identity query that counts and pages the run's identities, and orphan
 * detection.
 *
 * - includedDepartments: an identity is in scope when its profile.departmentName or
 *   profile.departmentCode equals an entry, ignoring case (as an access review's department
 *   scope). Absent or empty: every department.
 * - excludedUsers: an entry is an identity id (24 hex characters), which matches the identity's
 *   _id, or an email address, which matches profile.email ignoring case. An excluded identity is
 *   never scanned, so never corrected, and its orphan accounts are left alone.
 */
import { z } from 'zod';

export interface ReconciliationScope {
  includedDepartments?: string[];
  excludedUsers?: string[];
}

const IDENTITY_ID = /^[0-9a-f]{24}$/i;
const EMAIL = z.string().email();

/** Whether an excludedUsers entry is one the run can match: an identity id or an email address. */
export function isExcludedUserEntry(entry: string): boolean {
  return IDENTITY_ID.test(entry) || EMAIL.safeParse(entry).success;
}

/** The identity ids and the email addresses (lower case) of excludedUsers entries. */
export function excludedUsersOf(entries: readonly string[] = []): {
  ids: string[];
  emails: string[];
} {
  const ids: string[] = [];
  const emails: string[] = [];
  for (const raw of entries) {
    const entry = raw.trim().toLowerCase();
    if (IDENTITY_ID.test(entry)) ids.push(entry);
    else if (entry) emails.push(entry);
  }
  return { ids, emails };
}
