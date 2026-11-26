/**
 * The transaction log behind the Transaction Viewer (GET /dev/transactions, collection
 * transaction_logs). The API records a transaction as PREPARING when it starts the workflow;
 * DistributedTransactionActivities then record every phase transition, with each system's
 * state, so the stored log follows what the workflow did.
 *
 * Recording never fails an activity: a failed write after a commit would make Temporal retry the
 * whole commit and re-run the systems that already committed. A failed write is logged, and the
 * log then shows the last phase it could store.
 */
import type { Logger } from '@nestjs/common';
import {
  SystemTransactionStatus,
  type SystemTransactions,
} from '@shared/dtos/distributed-transaction.dto';
import type { DevToolsService } from '../modules/dev-tools/dev-tools.service';
import type {
  SystemParticipant,
  TransactionPhase,
} from '../modules/dev-tools/schemas/transaction-log.schema';

const isoOf = (value?: Date | string): string | undefined =>
  value ? new Date(value).toISOString() : undefined;

/** Each system's state as the log stores it. */
export function participantsOf(systems: SystemTransactions): SystemParticipant[] {
  return Object.values(systems).map((t) => ({
    systemName: t.system,
    status: t.status === SystemTransactionStatus.PENDING ? 'PREPARING' : t.status,
    preparedAt: isoOf(t.preparedAt),
    committedAt: isoOf(t.committedAt),
    rolledBackAt: isoOf(t.rolledBackAt),
    error: t.error,
  }));
}

/** The phase after the rollback: ROLLBACK_FAILED while a committed change is still in place. */
export function phaseAfterRollback(systems: SystemTransactions): TransactionPhase {
  return Object.values(systems).some(
    (t) =>
      t.status === SystemTransactionStatus.ROLLBACK_FAILED ||
      t.status === SystemTransactionStatus.COMMITTED,
  )
    ? 'ROLLBACK_FAILED'
    : 'ROLLED_BACK';
}

/**
 * Record `phase` for the transaction, with the systems' state when given (an empty set keeps
 * the participants already stored, e.g. a rollback after a prepare that failed). Never throws.
 */
export async function recordPhase(
  log: Pick<DevToolsService, 'updateTransactionPhase'>,
  logger: Logger,
  transactionId: string,
  phase: TransactionPhase,
  systems?: SystemTransactions,
): Promise<void> {
  const participants =
    systems && Object.keys(systems).length > 0 ? participantsOf(systems) : undefined;
  try {
    await log.updateTransactionPhase(transactionId, phase, participants);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`[DistTx] Could not record phase ${phase} of ${transactionId}: ${message}`);
  }
}
