/**
 * The Mongo clauses of a reconciliation run's scan scope (shared/utils/reconciliation-scope.ts),
 * which IdentityQueryService.findUsersPageForReconciliation adds to the count and to every page,
 * so a run's batches neither skip nor repeat an identity. Pure. Entries are escaped and anchored:
 * no regex reaches MongoDB from input, and "Sales" never matches "Sales Support".
 */
import * as mongoose from 'mongoose';
import { escapeRegex } from '@shared/utils/escape-regex';
import { excludedUsersOf, type ReconciliationScope } from '@shared/utils/reconciliation-scope';

const exactIgnoringCase = (value: string) => new RegExp(`^${escapeRegex(value)}$`, 'i');

export function identityScanScopeClauses(scope?: ReconciliationScope): Record<string, unknown>[] {
  const clauses: Record<string, unknown>[] = [];
  const departments = (scope?.includedDepartments ?? []).map((d) => d.trim()).filter(Boolean);
  if (departments.length > 0) {
    const names = departments.map(exactIgnoringCase);
    clauses.push({
      $or: [
        { 'profile.departmentName': { $in: names } },
        { 'profile.departmentCode': { $in: names } },
      ],
    });
  }
  const { ids, emails } = excludedUsersOf(scope?.excludedUsers);
  if (ids.length > 0) {
    clauses.push({ _id: { $nin: ids.map((id) => new mongoose.Types.ObjectId(id)) } });
  }
  if (emails.length > 0) {
    clauses.push({ 'profile.email': { $nin: emails.map(exactIgnoringCase) } });
  }
  return clauses;
}
