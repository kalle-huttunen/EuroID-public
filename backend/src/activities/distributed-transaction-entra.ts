/**
 * The Entra ID side of a distributed transaction (DistributedTransactionActivities): the prepare
 * check, the account state captured before the commit, the commit itself and the restore on
 * rollback. The activities store the captured state in the snapshot store and load it back.
 *
 * A CREATE never takes over an existing account. Prepare resolves the UPN the account will get
 * (resolveAvailableUpn, the UPN pattern included) and refuses when any account already has that
 * UPN, the user's own UPN, email or employee id. The commit creates the account under that UPN
 * only (EntraService.createAccount: an account in the way since fails it with a conflict), so the
 * object id it returns is always an account it created, and the restore deletes that id and
 * nothing else. A CREATE committed without the id is reported as not restored. DELETE disables
 * the account and the
 * restore sets accountEnabled back to the value captured at prepare (an account that was already
 * disabled stays disabled). UPDATE writes the user's attributes (EntraService.updateUser) to the
 * account captured at prepare, and the restore writes back the values those attributes had then
 * (EntraService.captureUserState / restoreUserState).
 *
 * No snapshot, no destructive change: a failed read of the account fails the prepare, a DELETE or
 * an UPDATE needs the account to exist, and one without its snapshot is neither committed nor
 * reported as restored.
 *
 * Logs name the system and the account's object id, never the email.
 */
import type { Logger } from '@nestjs/common';
import { ProvisioningException } from '@shared/exceptions/domain-exceptions';
import { maskEmails } from './deprovision-failure';
import type { StandardUserDto } from '@shared/dtos/standard-user.dto';
import type { UserSnapshot } from '@shared/dtos/distributed-transaction.dto';
import type { EntraActivities } from './entra.activities';
import type { EntraService } from '../modules/connectors/entra-connector/entra.service';

export interface EntraTransactionDeps {
  entraActivities: Pick<EntraActivities, 'provisionUserToEntra' | 'disableEntraUser'>;
  entraService: Pick<
    EntraService,
    | 'resolveAvailableUpn'
    | 'existingAccountFor'
    | 'getUserByEmail'
    | 'deleteUser'
    | 'patchUser'
    | 'captureUserState'
    | 'updateUser'
    | 'restoreUserState'
  >;
  logger: Logger;
}

/** Whether the operation can go ahead on Entra ID, and the UPN a CREATE gives the account. */
export type EntraPrepare = { ok: true; accountUpn?: string } | { ok: false; reason: string };

/**
 * A CREATE goes ahead with the UPN resolved for it when no account is in the way (any account
 * with that UPN, the user's own UPN, email or employee id): it never takes over one. A check that
 * fails refuses too, with its reason (email addresses masked: it reaches the transaction log).
 */
export async function validateEntraPrepare(
  deps: EntraTransactionDeps,
  user: StandardUserDto,
  operation: string,
): Promise<EntraPrepare> {
  if (operation !== 'CREATE') return { ok: true };
  try {
    const { chosenUpn } = await deps.entraService.resolveAvailableUpn(user);
    if (await deps.entraService.existingAccountFor(user, chosenUpn)) {
      return {
        ok: false,
        reason:
          'An Entra ID account already has the UPN, email or employee id of this user: a CREATE ' +
          'never takes over an existing account',
      };
    }
    return { ok: true, accountUpn: chosenUpn };
  } catch (error: unknown) {
    return {
      ok: false,
      reason: maskEmails(error instanceof Error ? error.message : String(error)),
    };
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The account as it is before the commit, or null when there is none (a CREATE). For an UPDATE,
 * the account's object id and the current values of the attributes the update writes. A failed
 * read throws, and so does a DELETE or UPDATE of an account that does not exist: the prepare
 * fails then, before anything is changed.
 */
export async function captureEntraSnapshot(
  deps: EntraTransactionDeps,
  system: string,
  user: StandardUserDto,
  operation: string,
): Promise<UserSnapshot | null> {
  const email = user.email ?? '';
  if (operation === 'UPDATE') {
    const captured = await deps.entraService.captureUserState(user);
    if (!captured.existed || !captured.objectId) {
      throw new ProvisioningException('No Entra ID account for this user: nothing to update');
    }
    return {
      system,
      userId: captured.objectId,
      email,
      state: { id: captured.objectId, attributes: captured.attributes ?? {} },
      capturedAt: new Date(),
    };
  }
  const account = await deps.entraService.getUserByEmail(email);
  if (!account) {
    if (operation === 'DELETE') {
      throw new ProvisioningException('No Entra ID account for this user: nothing to disable');
    }
    deps.logger.debug(`[DistTx] No existing account in ${system}: nothing to snapshot`);
    return null;
  }
  const snapshot: UserSnapshot = {
    system,
    userId: account.id,
    email: account.mail ?? account.userPrincipalName ?? email,
    state: {
      id: account.id,
      userPrincipalName: account.userPrincipalName,
      mail: account.mail,
      displayName: account.displayName,
      accountEnabled: account.accountEnabled,
    },
    capturedAt: new Date(),
  };
  deps.logger.debug(`[DistTx] Captured snapshot of account ${account.id} in ${system}`);
  return snapshot;
}

/**
 * Execute the operation on Entra. `previousState` is the state captured at prepare, loaded from
 * the snapshot store: a DELETE or UPDATE without it is not committed, since its rollback could
 * not restore the account. A CREATE creates the account under its `accountUpn` (resolved at
 * prepare) and nothing else, and answers its object id, which its rollback deletes; one prepared
 * without the UPN is not committed.
 */
export async function commitEntraOperation(
  deps: EntraTransactionDeps,
  user: StandardUserDto,
  operation: string,
  previousState: Record<string, unknown> | undefined,
  tenantId?: string,
  correlationId?: string,
): Promise<{ createdAccountId?: string }> {
  if (operation === 'CREATE') {
    const accountUpn = previousState?.accountUpn;
    if (typeof accountUpn !== 'string' || !accountUpn) {
      throw new ProvisioningException(
        'This CREATE was prepared without the UPN of its account (before the release that keeps ' +
          'it): nothing is created. Start the transaction again.',
      );
    }
    const created = await deps.entraActivities.provisionUserToEntra(
      user,
      undefined,
      undefined,
      tenantId,
      correlationId,
      undefined,
      undefined,
      accountUpn,
    );
    return created?.objectId ? { createdAccountId: created.objectId } : {};
  } else if (operation === 'DELETE') {
    if (!previousState) {
      throw new ProvisioningException(
        'No snapshot of the Entra ID account was taken before the commit: not disabling it',
      );
    }
    const disabled = await deps.entraActivities.disableEntraUser(
      user.email,
      tenantId,
      correlationId,
    );
    if (!disabled) throw new ProvisioningException('The Entra ID account to disable was not found');
  } else if (operation === 'UPDATE') {
    const id = previousState?.id;
    if (typeof id !== 'string' || !id || !isRecord(previousState?.attributes)) {
      throw new ProvisioningException(
        'No snapshot of the Entra ID attributes was taken before the commit: not updating them',
      );
    }
    await deps.entraService.updateUser(id, user);
  } else {
    throw new ProvisioningException(`Unsupported operation on Entra ID: ${operation}`);
  }
  return {};
}

/**
 * Restore the account from the state captured before the commit. A CREATE's account is deleted
 * by `createdAccountId`, the account the commit created; one gone already is restored. Without
 * the id nothing is deleted and the restore throws: an account found any other way (the email)
 * may have existed before the transaction.
 */
export async function restoreEntraAccount(
  deps: EntraTransactionDeps,
  system: string,
  operation: string,
  previousState: Record<string, unknown> | undefined,
  createdAccountId?: string,
): Promise<void> {
  if (operation === 'CREATE') {
    if (!createdAccountId) {
      throw new Error(
        'The commit recorded no account it created: nothing is deleted. Check Entra ID for an ' +
          'account made for this transaction and delete it there.',
      );
    }
    const deleted = await deps.entraService.deleteUser(createdAccountId);
    deps.logger.log(
      `[DistTx] Restored (deleted) account ${createdAccountId} created in ${system}` +
        (deleted ? '' : ' (already gone)'),
    );
  } else if (operation === 'DELETE') {
    // User existed; we disabled them. Restore = accountEnabled as it was before the commit, which
    // re-enables an enabled account and leaves one that was already disabled disabled. Without
    // the snapshot (object id, accountEnabled) it cannot be restored: never report it restored.
    const id = previousState?.id;
    if (typeof id !== 'string' || !id) {
      throw new Error('No snapshot of the account was taken before the commit: not re-enabled');
    }
    const accountEnabled = previousState?.accountEnabled;
    if (typeof accountEnabled !== 'boolean') {
      throw new Error('The snapshot has no accountEnabled value: not restored');
    }
    await deps.entraService.patchUser(id, { accountEnabled });
    deps.logger.log(
      `[DistTx] Restored account ${id} in ${system} (accountEnabled: ${accountEnabled})`,
    );
  } else if (operation === 'UPDATE') {
    // User existed; we wrote their attributes. Restore = write back the values captured before.
    const id = previousState?.id;
    const attributes = previousState?.attributes;
    if (typeof id !== 'string' || !id || !isRecord(attributes)) {
      throw new Error('No snapshot of the attributes was taken before the commit: not restored');
    }
    await deps.entraService.restoreUserState(id, attributes);
    deps.logger.log(`[DistTx] Restored (attributes written back) account ${id} in ${system}`);
  } else {
    throw new Error(`Unsupported operation on Entra ID: ${operation}`);
  }
}
