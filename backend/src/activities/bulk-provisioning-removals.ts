/**
 * The Hub after a bulk DISABLE or DELETE: the provisioning entry of each removed account becomes
 * DEPROVISIONED, so offboarding and the mover no longer take the account for active (they read
 * the entries; before, the entry stayed SYNCED until reconciliation found the drift).
 *
 * The operation body is no Hub record and writes none (patch
 * bulk-provisioning:no-hub-write-for-removals): the identity is looked up by the operation's
 * source key, else by its email, and only its existing entries for the removed systems are
 * marked. Nothing is created or upserted; an operation whose identity is not found changes
 * nothing in the Hub (reported in `notFound`). Marking an entry DEPROVISIONED again changes
 * nothing, so a retried activity is safe.
 */
import type { IdentityService } from '../modules/identity/identity.service';
import { getSystemType } from '@shared/utils/normalize-system-name';
import { toSourceName } from '@shared/utils/source-name';

/** One removal that stayed done, with the target systems where it succeeded. */
export interface RemovedAccount {
  operationId: string;
  email: string;
  sourceSystem?: string;
  sourceUserId?: string;
  systems: string[];
}

export interface RemovedAccountsMarked {
  /** Operations whose identity got at least one entry marked. */
  marked: string[];
  /** Operations whose identity was not found. */
  notFound: string[];
}

export interface RemovalDeps {
  identity: Pick<
    IdentityService,
    'findIdentityBySourceKey' | 'findIdentityByEmail' | 'updateProvisioningState'
  >;
  tenantId: string;
}

/** Whether a provisioning entry is for the bulk target `system` (`entra-id` is the entry `entra`). */
function entryIsFor(entryTarget: string, system: string): boolean {
  const type = getSystemType(system);
  return type === 'unknown' ? entryTarget === system : getSystemType(entryTarget) === type;
}

/** What a bulk operation's body says about its identity. */
export interface OperationIdentityKeys {
  email?: string;
  sourceSystem?: string;
  sourceUserId?: string;
}

/**
 * The identity of a bulk operation, by its source key, else by its email; null when neither
 * finds one. Also used to record a CREATE's account (bulk-provisioning-created-account.ts).
 */
export async function findOperationIdentity(
  keys: OperationIdentityKeys,
  deps: { identity: Pick<IdentityService, 'findIdentityBySourceKey' | 'findIdentityByEmail'> } & {
    tenantId: string;
  },
) {
  const bySourceKey =
    keys.sourceSystem && keys.sourceUserId
      ? await deps.identity.findIdentityBySourceKey(
          toSourceName(keys.sourceSystem),
          keys.sourceUserId,
          deps.tenantId,
        )
      : null;
  return (
    bySourceKey ??
    (keys.email
      ? await deps.identity.findIdentityByEmail(keys.email, { tenantId: deps.tenantId })
      : null)
  );
}

export async function markRemovedAccounts(
  removals: RemovedAccount[],
  deps: RemovalDeps,
): Promise<RemovedAccountsMarked> {
  const outcome: RemovedAccountsMarked = { marked: [], notFound: [] };
  for (const removal of removals) {
    const identity = await findOperationIdentity(removal, deps);
    if (!identity) {
      outcome.notFound.push(removal.operationId);
      continue;
    }
    const entries = (identity.provisioning ?? []).filter(
      (entry) =>
        entry.status !== 'DEPROVISIONED' &&
        removal.systems.some((system) => entryIsFor(entry.targetSystem, system)),
    );
    for (const entry of entries) {
      await deps.identity.updateProvisioningState(
        String(identity._id),
        entry.targetSystem,
        'DEPROVISIONED',
      );
    }
    if (entries.length > 0) outcome.marked.push(removal.operationId);
  }
  return outcome;
}
