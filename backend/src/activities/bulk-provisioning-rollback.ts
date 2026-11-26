/**
 * Compensation for a bulk operation, per target system that it changed.
 *
 * Entra ID: a CREATE or UPDATE is undone from the snapshot taken before it (the attributes of an
 * account that existed are written back; an account the operation created is disabled), also
 * when it failed after its change began (a failed license or group step), and a DISABLE is undone
 * by enabling the account again. A DISABLE of an account disabled before the batch changed
 * nothing (skipped) and is left disabled. A DELETE cannot be undone. The other bulk
 * connectors (file outbound, Discord webhook, GitHub, Google Sheets) can only provision, so
 * their changes are reported as not reversible, with the reason, instead of claimed as undone.
 *
 * The Golden Record write comes last (it was first): restored or removed when every system
 * change was undone, kept otherwise (see bulk-provisioning-hub.ts).
 */
import {
  BulkOperationType,
  type OperationResult,
  type OperationRollback,
  type SystemOperationResult,
} from '@shared/dtos/bulk-operation.dto';
import type { EntraActivities } from './entra.activities';
import type { EntraService } from '../modules/connectors/entra-connector/entra.service';
import type { EntraUserState } from '../modules/connectors/entra-connector/entra.types';
import { compensateHubWrite, HUB_KEPT, type HubRollbackDeps } from './bulk-provisioning-hub';

export interface RollbackDeps extends HubRollbackDeps {
  entraActivities: Pick<EntraActivities, 'disableEntraUser' | 'enableEntraUser'>;
  entraService: Pick<EntraService, 'disableUser' | 'restoreUserState'>;
  correlationId?: string;
}

type SystemRollback = OperationRollback['systems'][number];

/** Operation-level reason when every changed system was compensated. */
export const ROLLED_BACK_REASON = 'Batch failed, compensating transaction';

const undone = (system: string, reason: string): SystemRollback => ({
  system,
  rolledBack: true,
  reason,
});
const notUndone = (system: string, reason: string): SystemRollback => ({
  system,
  rolledBack: false,
  reason,
});

/** Undo what `result` changed on each system where it succeeded. Never throws per system. */
export async function compensateOperation(
  result: OperationResult,
  deps: RollbackDeps,
): Promise<OperationRollback> {
  const systems: SystemRollback[] = [];
  for (const systemResult of result.systemResults) {
    if (systemResult.skipped) continue; // nothing was changed
    // A failed system changed nothing, unless it failed after its change began: then it carries
    // the snapshot taken before (an Entra account made before a failed license or group step)
    if (!systemResult.success && !systemResult.previousState) continue;
    try {
      systems.push(await compensateSystem(result, systemResult, deps));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      systems.push(notUndone(systemResult.system, `rollback failed: ${message}`));
    }
  }
  const left = systems.filter((s) => !s.rolledBack);
  const hub = !result.hubWrite
    ? undefined
    : left.length > 0
      ? HUB_KEPT
      : await compensateHubWrite(result.hubWrite, deps);
  const stays = [
    ...left.map((s) => `${s.system}: ${s.reason}`),
    ...(hub && !hub.rolledBack ? [`hub: ${hub.reason}`] : []),
  ];
  return {
    rolledBack: stays.length === 0,
    reason: stays.length === 0 ? ROLLED_BACK_REASON : `Not rolled back: ${stays.join('; ')}`,
    systems,
    ...(hub ? { hub } : {}),
  };
}

async function compensateSystem(
  result: OperationResult,
  systemResult: SystemOperationResult,
  deps: RollbackDeps,
): Promise<SystemRollback> {
  const { system } = systemResult;
  if (result.type === BulkOperationType.DELETE) {
    // EuroID has no restore call. Entra keeps a deleted user under "Deleted users" for 30 days,
    // where an admin can restore it by hand.
    return notUndone(system, 'a DELETE is not reversible');
  }
  if (system !== 'entra-id') {
    return notUndone(
      system,
      `the ${system} connector cannot deprovision, so a ${result.type} stays`,
    );
  }
  if (result.type === BulkOperationType.DISABLE) {
    const enabled = await deps.entraActivities.enableEntraUser(
      result.email,
      deps.tenantId,
      deps.correlationId,
    );
    return enabled
      ? undone(system, 'account enabled again')
      : notUndone(system, 'account to enable not found');
  }
  return compensateEntraChange(result, systemResult, deps);
}

/** Entra CREATE or UPDATE: put back the state captured before the change. */
async function compensateEntraChange(
  result: OperationResult,
  systemResult: SystemOperationResult,
  deps: RollbackDeps,
): Promise<SystemRollback> {
  const { system, previousState } = systemResult;
  if (previousState?.existed && previousState.objectId) {
    // Results recorded before the encrypted snapshot store carry the values themselves.
    const attributes = previousState.snapshotRef
      ? await loadEntraAttributes(previousState.snapshotRef, previousState.snapshotKind, deps)
      : (previousState.attributes ?? {});
    if (!attributes) return notUndone(system, 'the snapshot taken before the change has expired');
    await deps.entraService.restoreUserState(previousState.objectId, attributes);
    return undone(system, 'attributes restored from the snapshot taken before the change');
  }
  if (previousState && !previousState.existed) {
    if (systemResult.objectId) {
      await deps.entraService.disableUser(systemResult.objectId);
      return undone(system, 'created account disabled');
    }
    // A CREATE that failed before it returned the object id may or may not have made the account
    if (!systemResult.success) {
      const disabled = await deps.entraActivities.disableEntraUser(
        result.email,
        deps.tenantId,
        deps.correlationId,
      );
      return undone(system, disabled ? 'created account disabled' : 'no account was created');
    }
    return notUndone(system, 'the created account has no object ID');
  }
  // Results from before snapshots were captured: a CREATE is undone as it always was.
  if (result.type === BulkOperationType.CREATE) {
    const disabled = await deps.entraActivities.disableEntraUser(
      result.email,
      deps.tenantId,
      deps.correlationId,
    );
    return disabled
      ? undone(system, 'created account disabled')
      : notUndone(system, 'account to disable not found');
  }
  return notUndone(system, 'no snapshot of the attributes was taken before the UPDATE');
}

/** The attribute values stored before the change, or null when the snapshot has expired. */
async function loadEntraAttributes(
  ref: string,
  kind: 'entra-state' | undefined,
  deps: RollbackDeps,
): Promise<Record<string, unknown> | null> {
  if (kind === 'entra-state') {
    const state = await deps.snapshots.load<EntraUserState>(deps.tenantId, 'entra-state', ref);
    return state ? (state.attributes ?? {}) : null;
  }
  return deps.snapshots.load<Record<string, unknown>>(deps.tenantId, 'entra-attributes', ref);
}
