/**
 * Entitlement delta between two policy evaluations, and which target system an operation
 * belongs to. Pure and dependency-free: the mover workflow imports it (Temporal bundles it into
 * the workflow sandbox), the mover activity and the access preview use the same functions, so
 * the preview shows exactly what a mover run would change.
 */
import { getSystemType, normalizeSystemName } from './normalize-system-name';
import type { MoverAccessOperation, MoverConnector } from '../types/mover';

/** The part of a policy operation the delta reads. */
export interface EntitlementOperation {
  type: string;
  action: string;
  target: string;
  targetId: string;
  sourcePolicy?: string;
}

export interface EntitlementDelta<T extends EntitlementOperation = EntitlementOperation> {
  toAdd: T[];
  toRemove: T[];
}

/** type|target|targetId identifies one entitlement. */
const keyOf = (op: EntitlementOperation) => `${op.type}|${op.target}|${op.targetId}`;

/**
 * toAdd: 'add' operations of the new evaluation that the old one lacks. toRemove: 'add'
 * operations of the old evaluation that the new one lacks, turned into 'remove'. Other actions
 * (an explicit remove, set attribute) are not compared.
 */
export function computeEntitlementDelta<T extends EntitlementOperation>(
  oldOps: T[],
  newOps: T[],
): EntitlementDelta<T> {
  const oldAdds = oldOps.filter((op) => op.action === 'add');
  const newAdds = newOps.filter((op) => op.action === 'add');
  const oldSet = new Set(oldAdds.map(keyOf));
  const newSet = new Set(newAdds.map(keyOf));
  return {
    toAdd: newAdds.filter((op) => !oldSet.has(keyOf(op))),
    toRemove: oldAdds
      .filter((op) => !newSet.has(keyOf(op)))
      .map((op) => ({ ...op, action: 'remove' })),
  };
}

/** Operations meant for `system`: by its name, `<name>-id`, `all`, or an Entra/AD alias. */
export function operationsForSystem<T extends EntitlementOperation>(ops: T[], system: string): T[] {
  const systemType = getSystemType(system);
  return ops.filter(
    (op) =>
      op.target === system ||
      op.target === `${system}-id` ||
      op.target === 'all' ||
      (systemType === 'entra' && (op.target === 'entra' || op.target === 'entra-id')) ||
      (systemType === 'ad' && (op.target === 'ad' || op.target === 'active-directory')),
  );
}

/**
 * Entitlement types the mover applies, per connector. Entra ID applies them through its
 * provisioning path (groups and directory roles added and removed, licenses added); Active
 * Directory, Okta and SCIM change group memberships only. Anything else is reported as not
 * updated by the mover.
 */
export const MOVER_OPERATION_TYPES: Record<MoverConnector, readonly string[]> = {
  entra: ['group', 'role', 'license'],
  ad: ['group'],
  okta: ['group'],
  scim: ['group'],
};

/** The connector the mover changes `system` through; null for a system it does not update. */
export function moverConnectorOf(system: string): MoverConnector | null {
  const type = getSystemType(system);
  if (type !== 'unknown') return type;
  const name = normalizeSystemName(system);
  return name === 'okta' || name === 'scim' ? name : null;
}

/** Whether a mover run applies the operation (target 'all': in some connector). */
export function isAppliedByMover(op: Pick<EntitlementOperation, 'type' | 'target'>): boolean {
  if (op.target === 'all') {
    return Object.values(MOVER_OPERATION_TYPES).some((types) => types.includes(op.type));
  }
  const connector = moverConnectorOf(op.target);
  return connector !== null && MOVER_OPERATION_TYPES[connector].includes(op.type);
}

/** What a mover run does in one target system. */
export interface MoverSystemPlan {
  connector: MoverConnector | null;
  /** What the connector applies: removals first, then additions. */
  operations: MoverAccessOperation[];
  /** Entitlement ids of `operations`. */
  applied: { added: string[]; removed: string[] };
  /** Entitlement ids of the changes the mover does not apply in this system. */
  notApplied: { added: string[]; removed: string[] };
}

/** Split the delta's changes for `system` into what its connector applies and what it does not. */
export function moverSystemPlan(delta: EntitlementDelta, system: string): MoverSystemPlan {
  const connector = moverConnectorOf(system);
  const types = connector ? MOVER_OPERATION_TYPES[connector] : [];
  const removes = operationsForSystem(delta.toRemove, system);
  const adds = operationsForSystem(delta.toAdd, system);
  const ids = (ops: EntitlementOperation[], applied: boolean) =>
    ops.filter((op) => types.includes(op.type) === applied).map((op) => op.targetId);
  const toOperation =
    (action: 'add' | 'remove') =>
    (op: EntitlementOperation): MoverAccessOperation => ({
      type: op.type,
      action,
      targetId: op.targetId,
    });
  return {
    connector,
    operations: [
      ...removes.filter((op) => types.includes(op.type)).map(toOperation('remove')),
      ...adds.filter((op) => types.includes(op.type)).map(toOperation('add')),
    ],
    applied: { added: ids(adds, true), removed: ids(removes, true) },
    notApplied: { added: ids(adds, false), removed: ids(removes, false) },
  };
}

/** An entitlement an active access request grants the identity: its native id in its system. */
export interface RequestGrant {
  system: string;
  /** Operation type (toOperationType): group, role, license. */
  type: string;
  nativeId: string;
}

/**
 * The removals without those of an entitlement an active access request also grants (same type,
 * same id, a system the removal is meant for): the policies no longer giving it does not end the
 * access the request gave. The request's own end (expiry, revoke) removes it.
 */
export function withoutRequestGrants<T extends EntitlementOperation>(
  toRemove: T[],
  grants: RequestGrant[],
): T[] {
  return toRemove.filter(
    (op) =>
      !grants.some(
        (grant) =>
          grant.type === op.type &&
          grant.nativeId === op.targetId &&
          operationsForSystem([op], grant.system).length > 0,
      ),
  );
}
