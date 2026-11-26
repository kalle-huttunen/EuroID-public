/**
 * The Golden Record (Hub) write of a bulk operation, and its compensation.
 *
 * saveToHubWithSnapshot saves the user to the Hub. Just before the first write it stores what the
 * write overwrites (or that it creates a new identity) encrypted in the rollback snapshot store,
 * under a key that is the same for every attempt of the activity: a retry keeps the state from
 * before the first attempt. Only the reference goes back to the workflow. A write that creates the
 * identity emits identity.created.
 *
 * A write that mints a new identity after a low-confidence correlation match first flags the
 * matched identity as a conflict (correlationConflict, requiresReview, conflictDetails). Those
 * flags as they were go into the store too, under a key of their own taken just before the
 * flagging, and the Hub snapshot refers to them.
 *
 * The user's `nationalIdHash` is the national ID hash the batch start computed, or null
 * (BulkProvisioningService removes the value and any correlationId the body brought), so the Hub
 * save matches on it; neither it nor a correlationId is saved from the user. A batch started
 * before that field existed carries the hash in `correlationId` (and no `nationalIdHash`), as that
 * build put it, and is saved as before.
 *
 * compensateHubWrite puts that state back, or removes the identity the write created and puts
 * back the conflict flags of the identity it flagged. It runs only when every target system
 * change of the operation was undone: while a target still holds the change, the Golden Record
 * keeps describing it.
 */
import type { StandardUserDto } from '@shared/dtos/standard-user.dto';
import type { UserPayload } from '@shared/types/user-payload';
import type { HubWrite, OperationRollback } from '@shared/dtos/bulk-operation.dto';
import type { IdentityService } from '../modules/identity/identity.service';
import type { ConflictFlagsState, IdentityHubState } from '../modules/identity/identity-hub-state';
import type { RollbackSnapshotService } from '../modules/bulk-provisioning/rollback-snapshot.service';

/**
 * What the snapshot store keeps for one Hub write. `conflictRef`: the conflict flags snapshot of
 * the identity a low-confidence match flagged before this write minted the identity.
 */
type HubSnapshot =
  | { existed: false; conflictRef?: string }
  | { existed: true; state: IdentityHubState };

type HubRollback = NonNullable<OperationRollback['hub']>;

export interface HubWriteDeps {
  identity: Pick<IdentityService, 'saveOrUpdateReportingCreated'>;
  snapshots: Pick<RollbackSnapshotService, 'save'>;
  tenantId: string;
}

export interface HubRollbackDeps {
  identity: Pick<IdentityService, 'restoreHubState' | 'removeIdentity' | 'restoreConflictFlags'>;
  snapshots: Pick<RollbackSnapshotService, 'load'>;
  tenantId: string;
}

/** Reason recorded on an identity removed by a rollback (IDENTITY_DELETED event). */
export const HUB_ROLLBACK_REASON = 'bulk-rollback';

export async function saveToHubWithSnapshot(
  user: StandardUserDto | UserPayload,
  snapshotKey: string,
  deps: HubWriteDeps,
): Promise<HubWrite> {
  let snapshotRef: string | undefined;
  let conflictRef: string | undefined;
  const { user: hubUser, nationalIdHash } = withoutNationalIdHash(user);
  const record = await deps.identity.saveOrUpdateReportingCreated(
    hubUser as StandardUserDto,
    async (before) => {
      const snapshot: HubSnapshot = before
        ? { existed: true, state: before }
        : { existed: false, ...(conflictRef ? { conflictRef } : {}) };
      snapshotRef = await deps.snapshots.save(deps.tenantId, 'hub-identity', snapshot, snapshotKey);
    },
    async (flagsBefore) => {
      // Keyed too: a retry that flags again keeps the flags from before the first attempt.
      conflictRef = await deps.snapshots.save(
        deps.tenantId,
        'hub-conflict-flags',
        flagsBefore,
        `${snapshotKey}/conflict`,
      );
    },
    typeof nationalIdHash === 'string' ? { nationalIdHash } : undefined,
  );
  if (!snapshotRef || !record._id) {
    throw new Error('Golden Record saved without a rollback snapshot');
  }
  return { identityId: String(record._id), snapshotRef };
}

/**
 * The user as the Hub saves it and the national ID hash it matches on: from `nationalIdHash`
 * (batches from the final review fix on), with `correlationId` and `nationalIdHash` removed; for
 * an older batch, without that field, the hash in `correlationId`, the user as it is.
 */
function withoutNationalIdHash(user: StandardUserDto | UserPayload): {
  user: StandardUserDto | UserPayload;
  nationalIdHash: unknown;
} {
  const fields = user as unknown as Record<string, unknown>;
  if (!('nationalIdHash' in fields)) return { user, nationalIdHash: fields.correlationId };
  const { nationalIdHash, correlationId: _dropped, ...rest } = fields;
  return { user: rest as unknown as StandardUserDto, nationalIdHash };
}

const undone = (reason: string): HubRollback => ({ rolledBack: true, reason });
const notUndone = (reason: string): HubRollback => ({ rolledBack: false, reason });

/** Kept: a target system still has the operation's change, which the Golden Record describes. */
export const HUB_KEPT = notUndone('kept, because a target system still has the change');

/** Undo a Hub write: restore the snapshot, or remove the identity it created. Never throws. */
export async function compensateHubWrite(
  hubWrite: HubWrite,
  deps: HubRollbackDeps,
): Promise<HubRollback> {
  try {
    const snapshot = await deps.snapshots.load<HubSnapshot>(
      deps.tenantId,
      'hub-identity',
      hubWrite.snapshotRef,
    );
    if (!snapshot)
      return notUndone('the Golden Record snapshot taken before the change has expired');
    if (!snapshot.existed) {
      const removed = await deps.identity.removeIdentity(hubWrite.identityId, HUB_ROLLBACK_REASON);
      if (!removed) return notUndone('the created Golden Record was not found');
      return snapshot.conflictRef
        ? undoConflictFlags(hubWrite.identityId, snapshot.conflictRef, deps)
        : undone('created Golden Record removed');
    }
    if (snapshot.state.id !== hubWrite.identityId) {
      return notUndone('the snapshot belongs to another Golden Record');
    }
    const restored = await deps.identity.restoreHubState(hubWrite.identityId, snapshot.state);
    return restored
      ? undone('Golden Record restored from the snapshot taken before the change')
      : notUndone('the Golden Record to restore was not found');
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return notUndone(`rollback failed: ${message}`);
  }
}

/**
 * After the created identity is removed: put back the conflict flags of the identity the
 * low-confidence match flagged. Nothing to do when that conflict was resolved or replaced since.
 */
async function undoConflictFlags(
  createdId: string,
  conflictRef: string,
  deps: HubRollbackDeps,
): Promise<HubRollback> {
  const removed = 'created Golden Record removed';
  try {
    const flags = await deps.snapshots.load<ConflictFlagsState>(
      deps.tenantId,
      'hub-conflict-flags',
      conflictRef,
    );
    if (!flags) {
      return notUndone(
        `${removed}, but the snapshot of the conflict flags it set on another identity has expired`,
      );
    }
    const restored = await deps.identity.restoreConflictFlags(flags, createdId);
    return undone(
      restored
        ? `${removed} and the conflict flags it set on identity ${flags.id} put back`
        : `${removed}; identity ${flags.id} no longer had the conflict flags it set`,
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return notUndone(`${removed}, but putting back the conflict flags failed: ${message}`);
  }
}
