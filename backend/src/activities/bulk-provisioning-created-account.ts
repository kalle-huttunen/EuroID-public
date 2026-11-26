/**
 * A bulk CREATE or UPDATE records the Entra ID account it provisioned for the operation's
 * identity (IdentityService.recordTargetAccountId: the target source only, no profile write), so
 * access requests, offboarding and expiry find the account by its object id, as for an onboarded
 * identity; recordEntraSynced (below) then marks the identity's Entra ID provisioning entry. Before HX-E3 bulk provisioning recorded none, and access
 * requests for those people ended REJECTED.
 *
 * The identity is the one the operation's Hub write saved (`identityId`, from result.hubWrite),
 * else the one with the operation's source key, else its email: the matching markRemovedAccounts
 * uses (findOperationIdentity). Nothing is created. A recorded id is never replaced, and an
 * account another identity has is not recorded. A rollback that undoes the Hub write puts back
 * the identity's sources as they were (restoreHubState), so the recorded id goes with it.
 *
 * Never throws: the account exists in Entra ID whatever happens here, so the operation stays
 * done; what could not be recorded is logged, and an access request finds the account by its
 * identifiers later (EntraEntitlementChanges).
 */
import { ENTRA_SYSTEM } from '../modules/connectors/entra-connector/entra.constants';
import type { IdentityService } from '../modules/identity/identity.service';
import type { RecordTargetAccountOutcome } from '../modules/identity/identity-provisioning.service';
import { isEntraEntry } from '../modules/identity/identity-hub-state';
import { findOperationIdentity, type OperationIdentityKeys } from './bulk-provisioning-removals';

export interface CreatedAccountDeps {
  identity: Pick<
    IdentityService,
    'findIdentityBySourceKey' | 'findIdentityByEmail' | 'recordTargetAccountId'
  >;
  tenantId: string;
  logger: { warn: (message: string) => void };
  /** The identity the operation's Hub write saved, when the run passed it. */
  identityId?: string;
}

export async function recordCreatedAccount(
  user: OperationIdentityKeys,
  objectId: string,
  deps: CreatedAccountDeps,
): Promise<RecordTargetAccountOutcome | 'identity-not-found' | 'failed'> {
  const what = `Entra ID account ${objectId} of a bulk operation`;
  try {
    const identityId = deps.identityId ?? (await findOperationIdentity(user, deps))?._id;
    if (!identityId) {
      deps.logger.warn(`[BulkProvisioning] ${what} not recorded: no identity found for it`);
      return 'identity-not-found';
    }
    const outcome = await deps.identity.recordTargetAccountId(
      String(identityId),
      ENTRA_SYSTEM,
      objectId,
    );
    if (outcome !== 'recorded' && outcome !== 'already') {
      deps.logger.warn(`[BulkProvisioning] ${what} not recorded for ${identityId}: ${outcome}`);
    }
    return outcome;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    deps.logger.warn(`[BulkProvisioning] ${what} not recorded: ${message}`);
    return 'failed';
  }
}

export interface EntraSyncedDeps {
  identity: Pick<
    IdentityService,
    | 'findIdentityBySourceKey'
    | 'findIdentityByEmail'
    | 'findIdentityById'
    | 'updateProvisioningState'
  >;
  tenantId: string;
  logger: { warn: (message: string) => void };
  /** The identity the operation's Hub write saved, when the run passed it. */
  identityId?: string;
}

/**
 * After a successful Entra ID CREATE or UPDATE: the operation's identity gets its Entra ID
 * provisioning entry SYNCED with the time (IdentityService.updateProvisioningState), as
 * onboarding writes it, so provisionedSystems lists Entra ID for it and the mover and offboarding
 * reach the account. Before HX-E4 bulk provisioning wrote none.
 *
 * The identity is found as for recordCreatedAccount; nothing is created or upserted from the
 * operation body (HX-C's 36d99c0a stands). An existing Entra ID entry (`entra-id`, `entra`) is
 * the one marked; without one the entry is `entra-id`. The rollback puts the entry back as it was
 * before the Hub write (the Hub snapshot's entraProvisioning, hubRestoreUpdate). Never throws.
 */
export async function recordEntraSynced(
  user: OperationIdentityKeys,
  deps: EntraSyncedDeps,
): Promise<'synced' | 'identity-not-found' | 'failed'> {
  try {
    const identity = deps.identityId
      ? await deps.identity.findIdentityById(deps.identityId)
      : await findOperationIdentity(user, deps);
    if (!identity) {
      deps.logger.warn('[BulkProvisioning] No Entra ID entry marked SYNCED: no identity found');
      return 'identity-not-found';
    }
    const existing = (identity.provisioning ?? []).find(isEntraEntry);
    await deps.identity.updateProvisioningState(
      String(identity._id),
      existing?.targetSystem ?? ENTRA_SYSTEM,
      'SYNCED',
    );
    return 'synced';
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    deps.logger.warn(`[BulkProvisioning] Entra ID entry not marked SYNCED: ${message}`);
    return 'failed';
  }
}

/**
 * What executeEntraOperation does after a successful Entra ID CREATE or UPDATE: records the
 * account's object id (when the provisioning returned one) and marks the Entra ID entry SYNCED,
 * only when the id is now the identity's (`recorded`, `already`) or there was no id. An id
 * another live identity holds (`taken`), one a deprovision removed (`removed`), another id
 * recorded (`other-recorded`), no identity found or a failed write mark nothing (logged): a
 * SYNCED entry would make offboarding and the mover treat the identity as owning that account.
 */
export async function recordProvisionedEntraAccount(
  user: OperationIdentityKeys,
  objectId: string | undefined,
  deps: CreatedAccountDeps & EntraSyncedDeps,
): Promise<void> {
  if (objectId) {
    const outcome = await recordCreatedAccount(user, objectId, deps);
    if (outcome !== 'recorded' && outcome !== 'already') {
      deps.logger.warn(
        `[BulkProvisioning] Entra ID entry not marked SYNCED: account ${objectId} ${outcome}`,
      );
      return;
    }
  }
  await recordEntraSynced(user, deps);
}
