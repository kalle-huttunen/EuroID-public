/**
 * Which policy operations an access review exclusion suppresses (pure, no NestJS).
 *
 * A revoke in an access review is a durable exception (review-exclusion.service.ts): the policy
 * engine leaves what the reviewer revoked out of the identity's intent until a policy-admin lifts
 * the exclusion. An exclusion names the system and the entitlement as the review gathered it
 * (review-target-access.service.ts: an Entra ID group by object id and display name, an AD group
 * by DN and first RDN value, an Okta group by id and name, a SCIM group by value and display), or
 * for an account item (a target whose memberships the review cannot read) the whole system.
 *
 * - Entitlement exclusion: suppresses an operation of the same kind (a group, a directory role,
 *   a license) whose target is the system (as systemKey compares names: `entra` is `entra-id`,
 *   `active-directory` is `ad`) or `all`, and whose id or name (targetId, or the group, role or
 *   license named in its params) is the entitlement's id, its name, or for an AD group its first
 *   RDN (`CN=Sales`). An `all` operation is suppressed as a whole: it cannot be split per system.
 * - Account exclusion: suppresses every operation whose target is the system; `all` operations
 *   are kept (they would otherwise go from every other system too).
 * An exclusion never suppresses a `remove`: exclusions only take grants away, never keep access.
 */
import { normalizeSystemName, systemKey } from '@shared/utils/normalize-system-name';
import type { ProvisioningOperation } from './policy-engine.service';

/** What the policy trace says for an operation an exclusion suppressed. */
export const SUPPRESSED_BY_ACCESS_REVIEW = 'Suppressed by access review';

export type ReviewExclusionScope = 'entitlement' | 'account';

/** The fields of an active exclusion matching reads. */
export interface ReviewExclusionMatch {
  id: string;
  campaignId: string;
  /** systemKey of the reviewed system. */
  systemKey: string;
  scope: ReviewExclusionScope;
  /** The review entitlement type (group, directory-role, app-group, license, account, ...). */
  entitlementType: string;
  entitlementName: string;
  /** The entitlement's id in the target (group object id, DN, Okta or SCIM group id). */
  entitlementId?: string;
}

/** An operation the policies grant that an access review exclusion left out of the intent. */
export type SuppressedOperation = ProvisioningOperation & {
  suppressedBy: {
    reason: typeof SUPPRESSED_BY_ACCESS_REVIEW;
    exclusionId: string;
    campaignId: string;
  };
};

/** Review entitlement type -> the operation type a policy grants it as. */
const OPERATION_TYPE: Readonly<Record<string, ProvisioningOperation['type']>> = {
  group: 'group',
  'app-group': 'group',
  'other-group': 'group',
  'indirect-group': 'group',
  'directory-role': 'role',
  license: 'license',
};

/** Params of an operation that name its entitlement. */
const OPERATION_NAME_PARAMS = ['groupName', 'groupId', 'roleName', 'roleTemplateId', 'licenseSku'];

/** An id or name as exclusions compare it: trimmed, lower case, no spaces around a DN's commas. */
export function entitlementIdKey(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s*,\s*/g, ',');
}

/** The key one active exclusion per identity and system is unique on ('*': the account). */
export function exclusionKey(e: {
  scope: ReviewExclusionScope;
  entitlementId?: string;
  entitlementName: string;
}): string {
  return e.scope === 'account' ? '*' : entitlementIdKey(e.entitlementId || e.entitlementName);
}

/** "cn=sales,ou=groups,dc=corp" -> "cn=sales"; undefined for a value that is no DN. */
function firstRdn(key: string): string | undefined {
  const match = /^[^=,]+=(?:\\.|[^,\\])+/.exec(key);
  return match && match[0] !== key ? match[0] : undefined;
}

function exclusionIds(e: ReviewExclusionMatch): Set<string> {
  const ids = new Set<string>();
  for (const value of [e.entitlementId, e.entitlementName]) {
    const key = entitlementIdKey(value);
    if (key) ids.add(key);
  }
  const rdn = firstRdn(entitlementIdKey(e.entitlementId));
  if (rdn) ids.add(rdn);
  return ids;
}

function operationIds(op: ProvisioningOperation): string[] {
  const values = [op.targetId, ...OPERATION_NAME_PARAMS.map((p) => op.params?.[p])];
  return values.map(entitlementIdKey).filter((key) => key !== '');
}

/** Whether the exclusion takes this operation out of the identity's intent. */
export function suppresses(exclusion: ReviewExclusionMatch, op: ProvisioningOperation): boolean {
  if (op.action === 'remove') return false;
  const toAll = normalizeSystemName(op.target) === 'all';
  if (exclusion.scope === 'account') return !toAll && systemKey(op.target) === exclusion.systemKey;
  if (!toAll && systemKey(op.target) !== exclusion.systemKey) return false;
  const type = OPERATION_TYPE[exclusion.entitlementType.trim().toLowerCase()];
  if (type !== op.type) return false;
  const ids = exclusionIds(exclusion);
  return operationIds(op).some((id) => ids.has(id));
}

/** The operations no exclusion suppresses, and the others with the exclusion that took them. */
export function withoutReviewExclusions(
  operations: ProvisioningOperation[],
  exclusions: ReviewExclusionMatch[],
): { operations: ProvisioningOperation[]; suppressed: SuppressedOperation[] } {
  if (exclusions.length === 0) return { operations, suppressed: [] };
  const kept: ProvisioningOperation[] = [];
  const suppressed: SuppressedOperation[] = [];
  for (const op of operations) {
    const exclusion = exclusions.find((e) => suppresses(e, op));
    if (!exclusion) {
      kept.push(op);
      continue;
    }
    suppressed.push({
      ...op,
      suppressedBy: {
        reason: SUPPRESSED_BY_ACCESS_REVIEW,
        exclusionId: exclusion.id,
        campaignId: exclusion.campaignId,
      },
    });
  }
  return { operations: kept, suppressed };
}
