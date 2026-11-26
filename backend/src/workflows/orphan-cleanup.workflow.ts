/**
 * Orphan Cleanup Workflow
 *
 * Manages the grace-period lifecycle for orphaned accounts, after detection recorded the drift
 * and emitted orphan.detected: grace period 1 -> disable -> grace period 2 -> resolve
 * (ADOPT/DELETE).
 *
 * DETERMINISM: No Date.now(), Math.random(), or direct DB calls. All I/O in activities.
 */

import {
  proxyActivities,
  defineSignal,
  setHandler,
  sleep,
  condition,
  log,
  patched,
} from '@temporalio/workflow';
import type { OrphanActivities } from '../activities/orphan.activities';
import { isPatched } from './workflow-versioning';
import { orphanDeleteRefusal } from '../shared/utils/orphan-delete-policy';

const activities = proxyActivities<OrphanActivities>({
  startToCloseTimeout: '5 minutes',
});

/**
 * orphan.detected is emitted once per orphan, by detection (OrphanDetectionService) when it
 * records the drift. Histories from before this patch emitted it here a second time.
 */
const DETECTION_EMITS_PATCH = 'orphan-cleanup:detection-emits-orphan-detected';

/**
 * input.requireApprovalForDeletes: no delete after the extended grace, whatever the orphan
 * config's autoDeleteAfterExtended says; the account stays disabled until a person decides.
 * Histories from before this patch auto-deleted.
 */
const APPROVAL_FOR_DELETES_PATCH = 'orphan-cleanup:approval-for-deletes';

/**
 * Before it disables or deletes the account, the cleanup asks confirmOrphan whether its drift is
 * still undecided and the account still an orphan (an identity may have been created for it since,
 * or it was excluded); otherwise it ends without touching the account, and confirmOrphan has
 * closed the drift. A disable that changed nothing (no such account, a target it cannot disable)
 * leaves disabledAt unset. Histories from before this patch disabled and deleted without asking
 * and stamped disabledAt whatever the disable did.
 */
const RECHECK_PATCH = 'orphan-cleanup:recheck-before-acting';

/**
 * The person an ADOPT or DELETE signal names (the operator of POST
 * /reconciliation/orphans/:driftId/signal) is recorded as the decision's decidedBy; before this
 * patch, and for a signal without one, it is 'workflow-signal'.
 */
const SIGNAL_ACTOR_PATCH = 'orphan-cleanup:signal-actor';

/**
 * EuroID never deletes an Active Directory account (shared/utils/orphan-delete-policy.ts): where
 * the cleanup would delete an AD orphan (the auto-delete after the extended grace, a DELETE
 * signal), it records the reason on the drift (keepOrphanAccount) and leaves the account as it
 * is, disabled after the first grace period, the drift quarantined. Histories from before this
 * patch called deleteOrphanAccount, which fails for AD, and only logged it.
 */
const AD_NEVER_DELETED_PATCH = 'orphan-cleanup:ad-never-deleted';

/**
 * The delete gets the drift's externalId too (the id detection recorded for the account), and a
 * SCIM user or Entra ID account is deleted by it (OrphanActivities.deleteOrphanAccount). Histories
 * from before this patch passed the account identifier only: SCIM found the user by userName or
 * email, Entra ID deleted by the UPN or mail.
 */
const DELETE_BY_EXTERNAL_ID_PATCH = 'orphan-cleanup:delete-by-external-id';

/** ADOPT_ACCOUNT: the identity to link the account to, and who decided. */
export const adoptAccountSignal = defineSignal<[string, string?]>('ADOPT_ACCOUNT');
/** DELETE_ACCOUNT: who decided. */
export const deleteAccountSignal = defineSignal<[string?]>('DELETE_ACCOUNT');
export const extendGracePeriodSignal = defineSignal<[number]>('EXTEND_GRACE_PERIOD');

export interface OrphanCleanupInput {
  driftId: string;
  targetSystem: string;
  externalId: string;
  accountIdentifier: string;
  tenantId: string;
  /**
   * The requireApprovalForDeletes of the reconciliation run that started the cleanup
   * (dailyReconciliationWorkflow). Unset in cleanups started before, and in those the signal
   * route starts (they apply the person's action at once).
   */
  requireApprovalForDeletes?: boolean;
}

export async function orphanCleanupWorkflow(input: OrphanCleanupInput): Promise<void> {
  const { driftId, targetSystem, externalId, accountIdentifier, tenantId } = input;

  const config = await activities.getOrphanConfig();
  const { gracePeriodDays, extendedGraceDays, autoDeleteAfterExtended } = config;

  let adoptIdentityId: string | null = null;
  let deleteRequested = false;
  let extendedDays = 0;
  let signalActor: string | undefined;

  setHandler(adoptAccountSignal, (identityId: string, actor?: string) => {
    adoptIdentityId = identityId;
    signalActor = actor;
  });
  setHandler(deleteAccountSignal, (actor?: string) => {
    deleteRequested = true;
    signalActor = actor;
  });

  /** Who decided a signalled ADOPT or DELETE. */
  const decidedBy = (): string =>
    signalActor && isPatched(SIGNAL_ACTOR_PATCH) ? signalActor : 'workflow-signal';

  /** Whether the account may still be disabled or deleted (RECHECK_PATCH). */
  const stillOrphan = async (): Promise<boolean> => {
    if (!isPatched(RECHECK_PATCH)) return true;
    const check = await activities.confirmOrphan(driftId, accountIdentifier, tenantId);
    if (!check.orphan) {
      log.info(`[Orphan] Drift ${driftId}: ${check.reason}; the account is left as it is`);
    }
    return check.orphan;
  };

  /** Delete the account (DELETE signal or auto-delete) and close the drift when it is gone. */
  const deleteAccount = async (by: string, when: string): Promise<void> => {
    if (!(await stillOrphan())) return;
    const refusal = orphanDeleteRefusal(targetSystem);
    if (refusal && isPatched(AD_NEVER_DELETED_PATCH)) {
      await activities.keepOrphanAccount(driftId, refusal, tenantId);
      log.info(
        `[Orphan] Kept the account of drift ${driftId}${when}: ${targetSystem} is never deleted`,
      );
      return;
    }
    const result = isPatched(DELETE_BY_EXTERNAL_ID_PATCH)
      ? await activities.deleteOrphanAccount(
          targetSystem,
          accountIdentifier,
          tenantId,
          undefined,
          externalId,
        )
      : await activities.deleteOrphanAccount(targetSystem, accountIdentifier, tenantId);
    if (result.success) {
      await activities.updateOrphanDriftStatus(driftId, 'corrected', 'DELETE', by, tenantId);
      log.info(`[Orphan] Deleted the account of drift ${driftId}${when}`);
    } else {
      log.warn(`[Orphan] The account of drift ${driftId} was not deleted: ${result.error}`);
    }
  };
  setHandler(extendGracePeriodSignal, (days: number) => {
    extendedDays = days;
  });

  if (!patched(DETECTION_EMITS_PATCH)) {
    await activities.emitOrphanDetected(
      driftId,
      targetSystem,
      externalId,
      accountIdentifier,
      tenantId,
    );
  }

  const resolved = await condition(
    () => adoptIdentityId !== null || deleteRequested,
    `${gracePeriodDays}d`,
  );

  if (resolved) {
    if (adoptIdentityId) {
      await activities.adoptOrphanAccount(
        driftId,
        adoptIdentityId,
        targetSystem,
        externalId,
        decidedBy(),
        tenantId,
      );
      log.info(`[Orphan] Adopted the account of drift ${driftId} to ${adoptIdentityId}`);
      return;
    }
    if (deleteRequested) {
      await deleteAccount(decidedBy(), '');
      return;
    }
  }

  if (!(await stillOrphan())) return;
  const disabled = await activities.disableOrphanAccount(targetSystem, accountIdentifier, tenantId);
  if (disabled || !isPatched(RECHECK_PATCH)) {
    await activities.setOrphanDisabledAt(driftId, tenantId);
  } else {
    log.warn(`[Orphan] The account of drift ${driftId} was not disabled in ${targetSystem}`);
  }

  const resolved2 = await condition(
    () => adoptIdentityId !== null || deleteRequested,
    `${extendedGraceDays + extendedDays}d`,
  );

  if (resolved2) {
    if (adoptIdentityId) {
      await activities.adoptOrphanAccount(
        driftId,
        adoptIdentityId,
        targetSystem,
        externalId,
        decidedBy(),
        tenantId,
      );
      log.info(
        `[Orphan] Adopted the account of drift ${driftId} to ${adoptIdentityId} (after disable)`,
      );
      return;
    }
    if (deleteRequested) {
      await deleteAccount(decidedBy(), ' (after disable)');
      return;
    }
  }

  const heldForApproval =
    autoDeleteAfterExtended &&
    input.requireApprovalForDeletes === true &&
    isPatched(APPROVAL_FOR_DELETES_PATCH);
  if (autoDeleteAfterExtended && !heldForApproval) {
    await deleteAccount('auto-after-grace', ' after extended grace');
  } else if (heldForApproval) {
    log.info(`[Orphan] Kept the account of drift ${driftId} disabled (deletes need approval)`);
  } else {
    log.info(`[Orphan] Kept the account of drift ${driftId} disabled (no auto-delete)`);
  }
}
