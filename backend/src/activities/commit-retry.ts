/**
 * The commit of a distributed transaction across Temporal retries. Temporal retries the commit
 * activity (a timeout, a worker that died) with the PREPARED states it was first given, so a
 * system an earlier attempt had committed would run again. Each system's outcome is heartbeated
 * as soon as it is known; a retried attempt reads the last heartbeat and keeps those outcomes
 * (COMMITTED or FAILED, with the account a CREATE made) instead of running the systems again.
 * A retried CREATE whose outcome did not reach Temporal first looks for the account an earlier
 * attempt made, by the UPN prepare resolved (accountMadeBefore).
 */
import type { Logger } from '@nestjs/common';
import { ApplicationFailure, Context } from '@temporalio/activity';
import { ENTRA_CHANGES_FAILED } from '@shared/types/entra-provisioning';
import { ProvisioningException } from '@shared/exceptions/domain-exceptions';
import type { EntraService } from '../modules/connectors/entra-connector/entra.service';
import {
  SystemTransactionStatus,
  type SystemTransaction,
  type SystemTransactions,
} from '@shared/dtos/distributed-transaction.dto';
import { lastHeartbeat } from './activity-heartbeat';

/** The heartbeat details of the commit activity. */
export interface CommitProgress {
  outcomes: SystemTransactions;
}

const FINAL: ReadonlySet<string> = new Set([
  SystemTransactionStatus.COMMITTED,
  SystemTransactionStatus.FAILED,
]);

/** The outcomes an earlier attempt of this activity heartbeated (none on a first attempt). */
export function earlierOutcomes(): SystemTransactions {
  const outcomes = lastHeartbeat<CommitProgress>()?.outcomes ?? {};
  return Object.fromEntries(
    Object.entries(outcomes).filter(([, t]) => t && FINAL.has(t.status)),
  ) as SystemTransactions;
}

/** This activity's attempt (1 outside an activity). */
export function activityAttempt(): number {
  try {
    return Context.current().info.attempt;
  } catch {
    return 1;
  }
}

/** A system's outcome as the heartbeat carries it: no lock or snapshot reference. */
export function outcomeOf(transaction: SystemTransaction): SystemTransaction {
  return {
    system: transaction.system,
    status: transaction.status,
    ...(transaction.committedAt ? { committedAt: transaction.committedAt } : {}),
    ...(transaction.createdAccountId ? { createdAccountId: transaction.createdAccountId } : {}),
    ...(transaction.error ? { error: transaction.error } : {}),
  };
}

/** The prepared state with an earlier attempt's outcome (its lock and snapshot stay). */
export function keepOutcome(transaction: SystemTransaction, known: SystemTransaction): void {
  transaction.status = known.status;
  if (known.committedAt) transaction.committedAt = known.committedAt;
  if (known.createdAccountId) transaction.createdAccountId = known.createdAccountId;
  if (known.error) transaction.error = known.error;
}

/**
 * The account a failed Entra ID provision created anyway: EntraChangesFailed carries it when a
 * group, directory role or license change was refused after the account was made
 * (activities/entra-changes-failure.ts). Undefined for any other failure.
 */
export function createdAccountOf(error: unknown): string | undefined {
  if (!(error instanceof ApplicationFailure) || error.type !== ENTRA_CHANGES_FAILED)
    return undefined;
  const account = error.details?.[0] as { objectId?: unknown } | undefined;
  return typeof account?.objectId === 'string' && account.objectId ? account.objectId : undefined;
}

/**
 * How much earlier than the prepare Graph's `createdDateTime` of an account the transaction made
 * may be: Graph gives it in whole seconds, and Entra ID's clock is not the worker's. Taking an
 * account created within this margin before the prepare is safe: prepare refused the CREATE when
 * any account already had the UPN (validateEntraPrepare), so one that has it now was made after
 * that check.
 */
export const ACCOUNT_CREATED_TOLERANCE_MS = 5_000;

/**
 * The Entra ID account an earlier attempt of a CREATE made: the account with the UPN prepare
 * resolved (`previousState.accountUpn`, the one the commit creates it under), which Entra ID
 * created after the prepare (`preparedAt`, less ACCOUNT_CREATED_TOLERANCE_MS). Undefined when no
 * account has that UPN (or the transaction has none: its commit refuses it). An account with the
 * UPN created earlier, or at a time Graph does not give, existed before the transaction: it
 * throws, so the system is FAILED and a rollback deletes nothing. Other systems are refused at
 * prepare (SUPPORTED_SYSTEMS).
 */
export async function accountMadeBefore(
  entraService: Pick<EntraService, 'findAccountByUpn'>,
  logger: Logger,
  system: string,
  previousState: Record<string, unknown> | undefined,
  preparedAt: Date | string | undefined,
): Promise<string | undefined> {
  const upn = previousState?.accountUpn;
  if (system !== 'entra-id' || typeof upn !== 'string' || !upn) return undefined;
  const account = await entraService.findAccountByUpn(upn);
  if (!account) return undefined;
  const createdAt = account.createdDateTime ? Date.parse(account.createdDateTime) : NaN;
  const prepared = preparedAt ? new Date(preparedAt).getTime() : NaN;
  if (!(createdAt >= prepared - ACCOUNT_CREATED_TOLERANCE_MS)) {
    throw new ProvisioningException(
      `Entra ID account ${account.id} has the UPN resolved for this CREATE and was not created ` +
        'after its prepare: a CREATE never takes over an existing account',
    );
  }
  logger.log(`[DistTx] ${system}: account ${account.id} made by an earlier attempt, kept`);
  return account.id;
}
