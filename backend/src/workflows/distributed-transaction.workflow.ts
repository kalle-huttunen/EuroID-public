/**
 * Distributed Transaction Workflow
 *
 * Implements 2-phase commit pattern for atomic operations across multiple systems.
 *
 * PHASES:
 * 1. PREPARE: Validate and lock on all systems
 * 2. COMMIT: Execute on all systems (if prepare succeeded)
 * 3. ROLLBACK: Undo on all systems (if commit failed)
 *
 * GUARANTEES:
 * - All systems succeed, or the committed ones are rolled back
 * - A system that cannot be restored is reported as ROLLBACK_FAILED, never as ROLLED_BACK
 * - A system that fails to commit releases its lock at once (no wait for the lock TTL)
 * - A CREATE whose commit failed after making the account has that account deleted too
 * - A cancel of the run rolls back what was committed (CANCEL_ROLLBACK_PATCH)
 */

import {
  proxyActivities,
  defineQuery,
  sleep,
  setHandler,
  log,
  ApplicationFailure,
  CancellationScope,
  CancelledFailure,
  isCancellation,
} from '@temporalio/workflow';
import type { DistributedTransactionActivities } from '../activities/distributed-transaction.activities';
import type { IdentityActivities } from '../activities/identity.activities';
import {
  DistributedTransactionRequest,
  DistributedTransactionResult,
  SystemTransaction,
  SystemTransactionStatus,
  TransactionPhase,
} from './workflow-types';
import { BATCH_OPERATION_RETRY } from '../infrastructure/config/retry-policies';
import { isPatched } from './workflow-versioning';
import { workflowNow } from './workflow-time';

/**
 * Per-system state is a plain object keyed by system. It used to be a Map, which Temporal
 * serialises to {}: the commit activity failed on it, and the workflow's own Map calls threw.
 * Histories from before this patch keep that Map check after the commit.
 */
const PLAIN_OBJECT_PATCH = 'distributed-transaction:plain-object-systems';

/**
 * After the rollback the phase is ROLLBACK_FAILED when a committed system could not be restored
 * (status ROLLBACK_FAILED, or still COMMITTED in rollback results from before this patch).
 * Histories from before this patch reported ROLLED_BACK whatever the restore did.
 */
const ROLLBACK_STATUS_PATCH = 'distributed-transaction:rollback-failed-status';

/**
 * A cancel of the run (Temporal UI or CLI; no EuroID route cancels one) leaves no committed
 * system in place. Prepare and commit run to their end in a non-cancellable scope, so the run
 * knows what they changed; a cancel during or after them goes to the rollback, which runs
 * non-cancellable too and restores every committed system (and a CREATE's account made by a
 * failed commit), autoRollback or not. The run then ends ROLLED_BACK, ROLLBACK_FAILED or FAILED
 * with its per-system results. Histories from before this patch let the cancel interrupt the
 * commit, so the rollback saw PREPARED systems, and the rollback activity, scheduled in the
 * cancelled scope, never ran.
 */
const CANCEL_ROLLBACK_PATCH = 'distributed-transaction:cancel-rolls-back';

/** Systems whose committed change is still in place after the rollback. */
function unrestoredSystems(systems: Record<string, SystemTransaction>): string[] {
  return Object.values(systems)
    .filter(
      (t) =>
        t.status === SystemTransactionStatus.ROLLBACK_FAILED ||
        t.status === SystemTransactionStatus.COMMITTED,
    )
    .map((t) => t.system);
}

/** The pre-patch commit check, kept for replay: it throws unless `systems` is a real Map. */
function legacyAllCommitted(systems: Record<string, SystemTransaction>): boolean {
  const map = systems as unknown as Map<string, SystemTransaction>;
  return Array.from(map.values()).every((t) => t.status === 'COMMITTED');
}

// Proxy activities
const txActivities = proxyActivities<DistributedTransactionActivities>({
  startToCloseTimeout: '2 minutes',
  retry: BATCH_OPERATION_RETRY,
});

const identityActivities = proxyActivities<IdentityActivities>({
  startToCloseTimeout: '30 seconds',
});

// Queries
export const getTransactionPhaseQuery = defineQuery<TransactionPhase>('getTransactionPhase');
export const getSystemStatusQuery =
  defineQuery<Record<string, SystemTransaction>>('getSystemStatus');

/**
 * Main distributed transaction workflow
 */
export async function distributedTransactionWorkflow(
  request: DistributedTransactionRequest,
): Promise<DistributedTransactionResult> {
  const startTime = workflowNow();
  const tenantId = request.tenantId ?? '';
  let phase: TransactionPhase = TransactionPhase.PREPARING;
  let systemTransactions: Record<string, SystemTransaction> = {};

  // Set up query handlers
  setHandler(getTransactionPhaseQuery, () => phase);
  setHandler(getSystemStatusQuery, () => systemTransactions);

  const cancelSafe = isPatched(CANCEL_ROLLBACK_PATCH);
  /** Run a phase's activity to its end even when the run is cancelled (CANCEL_ROLLBACK_PATCH). */
  const toTheEnd = <T>(fn: () => Promise<T>): Promise<T> =>
    cancelSafe ? CancellationScope.nonCancellable(fn) : fn();

  try {
    // ============================================================
    // PHASE 1: PREPARE
    // ============================================================
    phase = TransactionPhase.PREPARING;
    log.info('[DistTx] PREPARE', { transactionId: request.transactionId });

    // Save to Identity Hub first (if not already there)
    await identityActivities.saveToHub(request.user, tenantId);

    // Prepare on all target systems
    systemTransactions = await toTheEnd(() => txActivities.prepareTransaction(request, tenantId));

    phase = TransactionPhase.PREPARED;
    log.info('[DistTx] All systems PREPARED');

    // Small delay to ensure locks are stable
    await sleep('500 ms');

    // ============================================================
    // PHASE 2: COMMIT
    // ============================================================
    phase = TransactionPhase.COMMITTING;
    log.info('[DistTx] COMMIT', { transactionId: request.transactionId });

    const prepared = systemTransactions;
    systemTransactions = await toTheEnd(() =>
      txActivities.commitTransaction(request, prepared, tenantId),
    );
    // Cancelled while committing: what was committed is rolled back below
    if (cancelSafe && CancellationScope.current().consideredCancelled) {
      throw new CancelledFailure('The transaction was cancelled during the commit');
    }

    // Check if all commits succeeded
    const allCommitted = isPatched(PLAIN_OBJECT_PATCH)
      ? Object.values(systemTransactions).every((t) => t.status === 'COMMITTED')
      : legacyAllCommitted(systemTransactions);

    if (!allCommitted) {
      throw ApplicationFailure.nonRetryable('One or more systems failed to commit', 'CommitFailed');
    }

    phase = TransactionPhase.COMMITTED;
    log.info('[DistTx] All systems COMMITTED');

    // ============================================================
    // SUCCESS: Return result
    // ============================================================
    const endTime = workflowNow();
    return {
      transactionId: request.transactionId,
      success: true,
      phase,
      systems: systemTransactions,
      startedAt: startTime,
      completedAt: endTime,
      durationMs: endTime.getTime() - startTime.getTime(),
      prepareSuccess: true,
      commitSuccess: true,
      rolledBack: false,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    // ============================================================
    // FAILURE: ROLLBACK
    // ============================================================
    log.error('[DistTx] Transaction failed', { error: message });

    // Store phase before rollback for proper status reporting
    const failedAtPhase = phase;
    phase = TransactionPhase.ROLLING_BACK;

    // Rollback if auto-rollback is enabled (default: true), and always after a cancel
    const cancelled = cancelSafe && isCancellation(error);
    if (request.autoRollback !== false || cancelled) {
      try {
        const toRestore = systemTransactions;
        systemTransactions = await toTheEnd(() =>
          txActivities.rollbackTransaction(request, toRestore, tenantId),
        );
        const unrestored = isPatched(ROLLBACK_STATUS_PATCH)
          ? unrestoredSystems(systemTransactions)
          : [];
        if (unrestored.length > 0) {
          phase = TransactionPhase.ROLLBACK_FAILED;
          log.error('[DistTx] ROLLBACK_FAILED: committed changes are still in place', {
            systems: unrestored,
          });
        } else {
          phase = TransactionPhase.ROLLED_BACK;
          log.info('[DistTx] Successfully ROLLED_BACK');
        }
      } catch (rollbackError: unknown) {
        const rollbackMsg =
          rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        log.error('[DistTx] Rollback failed', { error: rollbackMsg });
        phase = TransactionPhase.FAILED;
      }
    } else {
      phase = TransactionPhase.FAILED;
    }

    const endTime = workflowNow();
    const finalPhase = phase; // Store final phase to avoid type narrowing issues

    return {
      transactionId: request.transactionId,
      success: false,
      phase: finalPhase,
      systems: systemTransactions,
      startedAt: startTime,
      completedAt: endTime,
      durationMs: endTime.getTime() - startTime.getTime(),
      prepareSuccess: failedAtPhase !== TransactionPhase.PREPARING,
      commitSuccess: false,
      rolledBack: finalPhase === TransactionPhase.ROLLED_BACK,
      error: message,
    };
  }
}
