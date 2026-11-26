/**
 * SoD policy labels and the rules the backend applies (`modules/policy/sod.service.ts`): which
 * entitlements a policy can name, how a reference is matched, and what the confirmations say.
 *
 * A policy entitlement is `{ system, type, targetId }`, matched against the operations one
 * evaluation grants: system and type case-insensitively (a directory role is `role`, also when
 * stored as `directoryrole`), targetId exactly. The policy engine names its operations `group`,
 * `license` and `role` with the group id, license SKU or role template id; an access request
 * names the requested catalog entry by its system, the same operation type and its nativeId.
 * The pickers therefore offer catalog entries and store their nativeId, as the Policy Engine's
 * own group, license and role pickers do.
 */
import { getConnectorById } from '@features/blueprints/shared';
import type { CatalogEntitlementType } from '@api/entitlement-catalog-api';
import type { ISodPolicy, SodAction, SodEntitlementRef, SodSeverity } from '../../interfaces';

export const SEVERITIES: SodSeverity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];

export const SEVERITY_LABEL: Record<SodSeverity, string> = {
  CRITICAL: 'Critical',
  HIGH: 'High',
  MEDIUM: 'Medium',
  LOW: 'Low',
};

/** Ant Design Tag presets (theme-driven, no raw colors). */
export const SEVERITY_TAG: Record<SodSeverity, string> = {
  CRITICAL: 'error',
  HIGH: 'volcano',
  MEDIUM: 'gold',
  LOW: 'default',
};

export const ACTION_LABEL: Record<SodAction, string> = { BLOCK: 'Block', WARN: 'Warn' };
export const ACTION_TAG: Record<SodAction, string> = { BLOCK: 'error', WARN: 'warning' };

/** One kind of entitlement a policy can name, and where the picker reads its values. */
export interface SodKind {
  key: string;
  system: string;
  catalogType: CatalogEntitlementType;
  /** The type the policy stores: the policy engine's operation type. */
  refType: string;
  label: string;
}

const kind = (
  system: string,
  catalogType: CatalogEntitlementType,
  refType: string,
  noun: string,
): SodKind => ({
  key: `${system}:${refType}`,
  system,
  catalogType,
  refType,
  label: `${getConnectorById(system)?.name ?? system} ${noun}`,
});

/**
 * The catalog's kinds: what connector discovery writes to the entitlement catalog (Entra ID
 * groups, licenses and directory roles; AD groups; Okta groups), under the registry's names.
 */
export const SOD_KINDS: SodKind[] = [
  kind('entra-id', 'Group', 'group', 'group'),
  kind('entra-id', 'License', 'license', 'license'),
  kind('entra-id', 'DirectoryRole', 'role', 'directory role'),
  kind('ad', 'Group', 'group', 'group'),
  kind('okta', 'Group', 'group', 'group'),
];

/** The kind a stored reference belongs to, matched like the backend (case-insensitive). */
export function kindOfRef(ref: SodEntitlementRef): SodKind | undefined {
  return SOD_KINDS.find(
    (k) =>
      k.system === ref.system.toLowerCase() &&
      (k.refType === ref.type.toLowerCase() ||
        k.catalogType.toLowerCase() === ref.type.toLowerCase()),
  );
}

/** Label of a reference's kind; a kind outside the catalog shows its system and type. */
export function kindLabelOfRef(ref: SodEntitlementRef): string {
  return (
    kindOfRef(ref)?.label ??
    `${getConnectorById(ref.system.toLowerCase())?.name ?? ref.system} ${ref.type}`
  );
}

/** Key of one cataloged entitlement, for name lookups. */
export const catalogKey = (system: string, catalogType: string, targetId: string) =>
  `${system.toLowerCase()}:${catalogType}:${targetId}`;

/** The catalog lists the policies' entitlements need to be named, each once. */
export function catalogListsFor(policies: ISodPolicy[]): SodKind[] {
  const keys = new Set(
    policies.flatMap((p) => p.conflictingEntitlements.map((ref) => kindOfRef(ref)?.key)),
  );
  return SOD_KINDS.filter((k) => keys.has(k.key));
}

/** A picked entitlement in the create form. */
export interface SodFormEntitlement {
  kind?: string;
  targetId?: string;
}

/** The index of the first entitlement that repeats an earlier one, with that earlier index. */
export function findDuplicate(
  items: SodFormEntitlement[],
): { index: number; firstIndex: number } | undefined {
  const seen = new Map<string, number>();
  for (let i = 0; i < items.length; i++) {
    const { kind: k, targetId } = items[i] ?? {};
    if (!k || !targetId) continue;
    const key = `${k}|${targetId}`;
    const firstIndex = seen.get(key);
    if (firstIndex !== undefined) return { index: i, firstIndex };
    seen.set(key, i);
  }
  return undefined;
}

/** A picked entitlement as the API stores it. */
export function toRef(item: SodFormEntitlement): SodEntitlementRef {
  const k = SOD_KINDS.find((x) => x.key === item.kind) as SodKind;
  return { system: k.system, type: k.refType, targetId: item.targetId as string };
}

/** Body of the confirmation before turning a policy on or off. */
export function toggleConsequence(policy: ISodPolicy): string {
  if (policy.isActive) {
    return 'Access requests, onboarding, mover runs and bulk creates are no longer checked against it, and risk scores stop counting it the next time they are calculated. You can turn it on again.';
  }
  return policy.action === 'BLOCK'
    ? 'From now on it refuses access requests, and stops onboarding, mover runs and bulk creates, that would give one person all of its entitlements. Risk scores count it the next time they are calculated.'
    : 'From now on access requests that would give one person all of its entitlements show a warning and go ahead. Risk scores count it the next time they are calculated.';
}

export const DELETE_CONSEQUENCE =
  'The API has no permanent delete: this deactivates the policy. It stops being checked at once, as when you turn it off, and stays in this list as inactive, where it can be turned on again. The audit log records it as sod_policy.deleted.';

export const DELETE_DISABLED_REASON =
  'Already inactive. Delete only deactivates a policy; the API has no permanent delete.';
