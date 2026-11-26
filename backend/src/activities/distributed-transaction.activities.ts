/**
 * Distributed Transaction Coordinator Activities
 *
 * Implements 2-phase commit pattern for distributed transactions across
 * multiple target systems, ensuring atomic operations and consistency.
 *
 * PATTERN:
 * 1. PREPARE: Check if all systems can accept the operation (validate, lock)
 * 2. COMMIT: Execute on all systems (if prepare succeeded)
 * 3. ROLLBACK: Undo on all systems (if commit failed)
 *
 * The per-system state crosses the workflow boundary between phases, so it is a plain object
 * keyed by system: Temporal's JSON payload converter turns a Map into {}.
 *
 * LOCKS: each system's lock is held by the transaction (owner token: tenant and transaction id)
 * and only that owner can release it. The commit releases a system's lock and the rollback
 * releases it again; the second release, or one from a retried activity, finds the lock gone or
 * taken by another transaction and leaves it alone. A lock is per tenant, system and account,
 * keyed by a hash of the email (lockKeyOf): no email in Redis keys or in the lockId that the
 * workflow history records.
 *
 * TRANSACTION LOG: each phase transition is recorded where the Transaction Viewer reads it
 * (DevToolsService.updateTransactionPhase, see distributed-transaction-log.ts).
 *
 * SNAPSHOTS: the account state captured before the commit is personal data. It is stored
 * encrypted in the rollback snapshot store (RollbackSnapshotService, kind entra-account), and
 * only `previousState.snapshotRef` crosses the workflow boundary into the Temporal history.
 *
 * SYSTEMS: the commit can change Entra ID only (SUPPORTED_SYSTEMS). Prepare refuses any other
 * target system before taking a lock, so nothing is committed anywhere; transactions prepared
 * before that check still fail such a system at commit and roll the others back.
 *
 * RETRIES: each system's commit outcome is heartbeated and a retried commit keeps it
 * (commit-retry.ts). An outcome that did not reach Temporal runs the Entra ID change again:
 * UPDATE (same attributes) and DELETE (disable) are idempotent; CREATE first takes the account
 * with the UPN prepare resolved when Entra ID created it after the prepare (accountMadeBefore).
 *
 * LOGS carry the transaction id, the system and the account's object id, never the email.
 */

import { Injectable, Logger, Inject } from '@nestjs/common';
import { ApplicationFailure } from '@temporalio/activity';
import { StandardUserDto } from '@shared/dtos/standard-user.dto';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { validateActivityContext } from '@shared/utils/activity-context';
import {
  DistributedTransactionRequestInput,
  SystemTransaction,
  SystemTransactions,
  SystemTransactionStatus,
  UserSnapshot,
} from '@shared/dtos/distributed-transaction.dto';
import { EntraActivities } from './entra.activities';
import { IdentityActivities } from './identity.activities';
import { EntraService } from '../modules/connectors/entra-connector/entra.service';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DomainEventType } from '@infrastructure/events/event-types';
import { DeadLetterService } from '../modules/dead-letter/dead-letter.service';
import { ProvisioningException, ConnectorException } from '@shared/exceptions/domain-exceptions';
import { OWNED_LOCK_STORE, type OwnedLockStore } from '@infrastructure/cache/owned-lock.store';
import { DevToolsService } from '../modules/dev-tools/dev-tools.service';
import { RollbackSnapshotService } from '../modules/bulk-provisioning/rollback-snapshot.service';
import { maskEmail } from '../modules/identity/identity-pii';
import { phaseAfterRollback, recordPhase } from './distributed-transaction-log';
import {
  accountMadeBefore,
  activityAttempt,
  createdAccountOf,
  earlierOutcomes,
  keepOutcome,
  outcomeOf,
} from './commit-retry';
import { heartbeat } from './activity-heartbeat';
import { LOCK_PREFIX, LOCK_TTL_MS, lockKeyOf, lockOwner } from './distributed-transaction-locks';
import {
  captureEntraSnapshot,
  commitEntraOperation,
  restoreEntraAccount,
  validateEntraPrepare,
  type EntraPrepare,
  type EntraTransactionDeps,
} from './distributed-transaction-entra';

/** The systems the commit can change (executeOperation); prepare refuses any other. */
const SUPPORTED_SYSTEMS: ReadonlySet<string> = new Set(['entra-id']);

export { lockKeyOf } from './distributed-transaction-locks';

@Injectable()
export class DistributedTransactionActivities {
  private readonly logger = new Logger(DistributedTransactionActivities.name);

  constructor(
    private readonly entraActivities: EntraActivities,
    private readonly identityActivities: IdentityActivities,
    private readonly entraService: EntraService,
    private readonly eventEmitter: DomainEventEmitterService,
    private readonly deadLetterService: DeadLetterService,
    @Inject(OWNED_LOCK_STORE) private readonly locks: OwnedLockStore,
    private readonly transactionLog: DevToolsService,
    private readonly snapshots: RollbackSnapshotService,
  ) {}

  private record(
    request: DistributedTransactionRequestInput,
    phase: Parameters<typeof recordPhase>[3],
    systems?: SystemTransactions,
  ): Promise<void> {
    return recordPhase(this.transactionLog, this.logger, request.transactionId, phase, systems);
  }

  /**
   * PHASE 1: PREPARE
   * Validate and lock resources on all target systems
   */
  async prepareTransaction(
    request: DistributedTransactionRequestInput,
    tenantId?: string,
    correlationId?: string,
  ): Promise<SystemTransactions> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      async () => {
        const u = request.user as StandardUserDto;
        const owner = lockOwner(request, tenantId);
        this.logger.log(`[DistTx] PREPARE: ${request.transactionId}`);

        const systemTransactions: SystemTransactions = {};
        await this.refuseUnsupportedSystems(request, systemTransactions);

        for (const system of request.targetSystems) {
          const transaction: SystemTransaction = {
            system,
            status: SystemTransactionStatus.PENDING,
          };

          try {
            // 1. Acquire distributed lock
            const lockId = await this.acquireLock(
              lockKeyOf(tenantId ?? '', system, u.email ?? ''),
              owner,
            );
            transaction.lockId = lockId;
            transaction.lockAcquiredAt = new Date();

            // 2. Capture current state (for rollback), stored encrypted: the history gets the
            // reference only. A snapshot that cannot be stored fails this system's prepare.
            const snapshot = await this.captureSnapshot(system, u, request.operation);
            if (snapshot) {
              const snapshotRef = await this.snapshots.save(
                tenantId ?? '',
                'entra-account',
                snapshot.state,
              );
              transaction.previousState = { snapshotRef };
            }

            // 3. Validate operation is possible (a CREATE: the UPN its account gets)
            const check = await this.validatePrepare(system, request.user, request.operation);
            if (!check.ok) {
              throw new ProvisioningException(
                `Prepare validation failed on ${system}: ${check.reason}`,
              );
            }
            if (check.accountUpn) {
              // A CREATE: the UPN its account gets, kept encrypted like a snapshot (personal data)
              const snapshotRef = await this.snapshots.save(tenantId ?? '', 'entra-account', {
                accountUpn: check.accountUpn,
              });
              transaction.previousState = { snapshotRef };
            }
            transaction.status = SystemTransactionStatus.PREPARED;
            transaction.preparedAt = new Date();
            this.logger.log(`[DistTx] PREPARED on ${system}`);
          } catch (error: unknown) {
            transaction.status = SystemTransactionStatus.FAILED;
            const message = error instanceof Error ? error.message : String(error);
            transaction.error = message;
            this.logger.error(`[DistTx] PREPARE failed on ${system}: ${message}`);

            // Release lock if acquired
            if (transaction.lockId) {
              await this.releaseLock(transaction.lockId, owner);
            }
          }

          systemTransactions[system] = transaction;
        }

        // Check if all systems prepared successfully
        const allPrepared = Object.values(systemTransactions).every(
          (t) => t.status === SystemTransactionStatus.PREPARED,
        );

        if (!allPrepared) {
          // Rollback all prepared systems
          for (const transaction of Object.values(systemTransactions)) {
            if (transaction.status === SystemTransactionStatus.PREPARED && transaction.lockId) {
              await this.releaseLock(transaction.lockId, owner);
            }
          }
          await this.record(request, 'FAILED', systemTransactions);
          throw new ProvisioningException('Prepare phase failed on one or more systems');
        }

        await this.record(request, 'PREPARED', systemTransactions);
        return systemTransactions;
      },
      { correlationId },
    );
  }

  /**
   * A system the commit cannot change would only fail at commit, after the others had changed:
   * refuse the whole transaction here, before any lock or read (not retried).
   */
  private async refuseUnsupportedSystems(
    request: DistributedTransactionRequestInput,
    systemTransactions: SystemTransactions,
  ): Promise<void> {
    const unsupported = request.targetSystems.filter((system) => !SUPPORTED_SYSTEMS.has(system));
    if (unsupported.length === 0) return;
    const message =
      `Distributed transactions can change ${[...SUPPORTED_SYSTEMS].join(', ')} only; ` +
      `not supported: ${unsupported.join(', ')}`;
    for (const system of unsupported) {
      systemTransactions[system] = {
        system,
        status: SystemTransactionStatus.FAILED,
        error: message,
      };
    }
    this.logger.error(`[DistTx] PREPARE refused for ${request.transactionId}: ${message}`);
    await this.record(request, 'FAILED', systemTransactions);
    throw ApplicationFailure.nonRetryable(message, 'UnsupportedSystem');
  }

  /**
   * PHASE 2: COMMIT
   * Execute the operation on all prepared systems
   */
  async commitTransaction(
    request: DistributedTransactionRequestInput,
    systemTransactions: SystemTransactions,
    tenantId?: string,
    correlationId?: string,
  ): Promise<SystemTransactions> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      async () => {
        const owner = lockOwner(request, tenantId);
        this.logger.log(`[DistTx] COMMIT: ${request.transactionId}`);
        await this.record(request, 'COMMITTING');
        // A retried attempt gets the PREPARED states again: what an earlier attempt heartbeated
        // is kept, never run twice (commit-retry.ts)
        const earlier = earlierOutcomes();
        const outcomes: SystemTransactions = { ...earlier };
        const retried = activityAttempt() > 1;

        for (const [system, transaction] of Object.entries(systemTransactions)) {
          if (transaction.status !== SystemTransactionStatus.PREPARED) {
            continue; // Skip non-prepared systems
          }
          const known = earlier[system];
          if (known) {
            keepOutcome(transaction, known);
            this.logger.log(`[DistTx] ${system}: ${known.status} in an earlier attempt, kept`);
            await this.releaseLockQuietly(system, transaction.lockId, owner);
            continue;
          }

          try {
            // A retried CREATE whose outcome did not reach Temporal: the account it made, if any
            const madeBefore =
              retried && request.operation === 'CREATE'
                ? await accountMadeBefore(
                    this.entraService,
                    this.logger,
                    system,
                    await this.previousStateOf(transaction.previousState, tenantId),
                    transaction.preparedAt,
                  )
                : undefined;
            const { createdAccountId } = madeBefore
              ? { createdAccountId: madeBefore }
              : await this.executeOperation(
                  system,
                  request.user,
                  request.operation,
                  transaction.previousState,
                  tenantId,
                  correlationId,
                );

            if (createdAccountId) transaction.createdAccountId = createdAccountId;
            transaction.status = SystemTransactionStatus.COMMITTED;
            transaction.committedAt = new Date();
            this.logger.log(`[DistTx] COMMITTED on ${system}`);
          } catch (error: unknown) {
            transaction.status = SystemTransactionStatus.FAILED;
            const message = error instanceof Error ? error.message : String(error);
            transaction.error = message;
            // An account the failed call made anyway: the rollback deletes it
            const createdAccountId = createdAccountOf(error);
            if (createdAccountId) transaction.createdAccountId = createdAccountId;
            this.logger.error(`[DistTx] COMMIT failed on ${system}: ${message}`);

            // Don't throw here - we'll handle rollback at workflow level
          }
          outcomes[system] = outcomeOf(transaction);
          heartbeat({ outcomes });

          // Committed, or nothing was committed (the rollback skips FAILED systems): either way
          // the lock has nothing left to protect, so release it now instead of at the TTL.
          await this.releaseLockQuietly(system, transaction.lockId, owner);
        }

        // When a system did not commit, the workflow rolls back next (or stops here without
        // autoRollback): FAILED is what is true now.
        const allCommitted = Object.values(systemTransactions).every(
          (t) => t.status === SystemTransactionStatus.COMMITTED,
        );
        await this.record(request, allCommitted ? 'COMMITTED' : 'FAILED', systemTransactions);
        return systemTransactions;
      },
      { correlationId },
    );
  }

  /**
   * PHASE 3: ROLLBACK
   * Undo operations on all committed systems
   */
  async rollbackTransaction(
    request: DistributedTransactionRequestInput,
    systemTransactions: SystemTransactions,
    tenantId?: string,
    correlationId?: string,
  ): Promise<SystemTransactions> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      async () => {
        const owner = lockOwner(request, tenantId);
        this.logger.warn(`[DistTx] ROLLBACK: ${request.transactionId}`);
        await this.record(request, 'ROLLING_BACK');
        try {
          await this.rollbackSystems(request, systemTransactions, owner, tenantId);
        } catch (error: unknown) {
          // The workflow ends FAILED when the rollback activity fails for good.
          await this.record(request, 'FAILED', systemTransactions);
          throw error;
        }
        await this.record(request, phaseAfterRollback(systemTransactions), systemTransactions);
        return systemTransactions;
      },
      { correlationId },
    );
  }

  /**
   * Restore each committed system, and a system whose failed commit made an account anyway (its
   * createdAccountId); release the locks of systems that never committed.
   */
  private async rollbackSystems(
    request: DistributedTransactionRequestInput,
    systemTransactions: SystemTransactions,
    owner: string,
    tenantId?: string,
  ): Promise<void> {
    for (const [system, transaction] of Object.entries(systemTransactions)) {
      const halfMade =
        transaction.status === SystemTransactionStatus.FAILED &&
        request.operation === 'CREATE' &&
        !!transaction.createdAccountId;
      if (transaction.status !== SystemTransactionStatus.COMMITTED && !halfMade) {
        // Release locks on prepared but not committed systems
        if (transaction.lockId && transaction.status === SystemTransactionStatus.PREPARED) {
          await this.releaseLock(transaction.lockId, owner);
        }
        continue;
      }

      try {
        // Restore previous state
        await this.restoreSnapshot(
          system,
          (request.user as StandardUserDto).email,
          transaction,
          request.operation,
          request.transactionId,
          tenantId,
        );

        transaction.status = SystemTransactionStatus.ROLLED_BACK;
        transaction.rolledBackAt = new Date();
        this.logger.log(`[DistTx] ROLLED_BACK on ${system}`);

        // Normally released at commit already: a no-op then, never another owner's lock.
        await this.releaseLockQuietly(system, transaction.lockId, owner);
      } catch (error: unknown) {
        // The committed change is still in place: never report this system as rolled back.
        const message = error instanceof Error ? error.message : String(error);
        transaction.status = SystemTransactionStatus.ROLLBACK_FAILED;
        transaction.error = message;
        this.logger.error(`[DistTx] ROLLBACK failed on ${system}: ${message}`);
      }
    }
  }

  /**
   * Acquire `lockKey` (lockKeyOf) for `owner` (OWNED_LOCK_STORE: Redis when configured,
   * in-process otherwise). Returns the lockId; releaseLock derives the key from it, so the
   * lockIds of transactions prepared before lockKeyOf still release their own keys.
   */
  private async acquireLock(lockKey: string, owner: string): Promise<string> {
    const holder = await this.locks.acquire(`${LOCK_PREFIX}${lockKey}`, owner, LOCK_TTL_MS);
    if (holder !== owner) {
      throw new ProvisioningException('Resource is locked by another transaction');
    }
    const lockId = `${lockKey}#${Date.now()}`;
    this.logger.debug(`[DistTx] Acquired lock: ${lockId}`);
    return lockId;
  }

  /**
   * Release a lock after the system's commit or restore. A failed release is logged, not thrown:
   * throwing would fail the activity after its systems were changed (Temporal would retry the
   * whole commit, re-running the systems that already committed). The lock then expires after
   * LOCK_TTL_MS.
   */
  private async releaseLockQuietly(system: string, lockId: string | undefined, owner: string) {
    if (!lockId) return;
    try {
      await this.releaseLock(lockId, owner);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `[DistTx] Could not release the lock on ${system}, it expires in ${LOCK_TTL_MS}ms: ${message}`,
      );
    }
  }

  /** Release the lock only if `owner` still holds it; another transaction's lock stays. */
  private async releaseLock(lockId: string, owner: string): Promise<void> {
    const hashIdx = lockId.indexOf('#');
    const lockKey = hashIdx >= 0 ? lockId.slice(0, hashIdx) : lockId;
    const released = await this.locks.release(`${LOCK_PREFIX}${lockKey}`, owner);
    this.logger.debug(
      released
        ? `[DistTx] Released lock: ${lockId}`
        : `[DistTx] Lock ${lockId} is no longer held by this transaction, left as it is`,
    );
  }

  /** The Entra dependencies of distributed-transaction-entra.ts. */
  private get entra(): EntraTransactionDeps {
    return {
      entraActivities: this.entraActivities,
      entraService: this.entraService,
      logger: this.logger,
    };
  }

  /** Capture current state snapshot before commit (Entra only). A failed read throws. */
  private async captureSnapshot(
    system: string,
    user: StandardUserDto,
    operation: string,
  ): Promise<UserSnapshot | null> {
    if (system === 'entra-id') return captureEntraSnapshot(this.entra, system, user, operation);
    this.logger.debug(`[DistTx] Snapshot not implemented for ${system}`);
    return null;
  }

  /**
   * The state captured before the commit: read back by reference from the snapshot store, or
   * the values themselves in transactions prepared before the store was used. Throws when the
   * snapshot has expired, so the restore is reported as failed, never as done.
   */
  private async previousStateOf(
    previousState: Record<string, unknown> | undefined,
    tenantId?: string,
  ): Promise<Record<string, unknown> | undefined> {
    const ref = previousState?.snapshotRef;
    if (typeof ref !== 'string') return previousState;
    const state = await this.snapshots.load<Record<string, unknown>>(
      tenantId ?? '',
      'entra-account',
      ref,
    );
    if (!state) throw new Error('The snapshot taken before the commit has expired');
    return state;
  }

  /**
   * Restore from snapshot on rollback.
   * On failure: emit ROLLBACK_FAILED and log to dead-letter queue. Both carry the email masked
   * (m•••@example.com, maskEmail), also inside the error message: Graph errors can quote the
   * address they were given. The error rethrown to rollbackSystems is masked the same way.
   */
  private async restoreSnapshot(
    system: string,
    email: string,
    transaction: SystemTransaction,
    operation: string,
    transactionId: string,
    tenantId?: string,
  ): Promise<void> {
    try {
      // A CREATE is undone by the id of the account it created: no snapshot needed (or expired)
      const previousState =
        operation === 'CREATE'
          ? undefined
          : await this.previousStateOf(transaction.previousState, tenantId);
      if (system === 'entra-id') {
        await restoreEntraAccount(
          this.entra,
          system,
          operation,
          previousState,
          transaction.createdAccountId,
        );
      }
    } catch (error: unknown) {
      const rawMessage = error instanceof Error ? error.message : String(error);
      const maskedEmail = maskEmail(email);
      const message = email ? rawMessage.split(email).join(maskedEmail) : rawMessage;
      this.logger.error(`[DistTx] Restore failed for ${transactionId} in ${system}: ${message}`);
      this.eventEmitter.emit(DomainEventType.ROLLBACK_FAILED, transactionId, {
        transactionId,
        system,
        email: maskedEmail,
        error: message,
      });
      await this.deadLetterService.capture({
        type: 'workflow_terminal',
        source: 'distributed-transaction',
        originalPayload: { transactionId, system, email: maskedEmail, operation },
        error: { message },
        tenantId,
      });
      throw message === rawMessage ? error : new Error(message);
    }
  }

  /** Whether the operation can go ahead on `system`, and the UPN a CREATE's account gets. */
  private async validatePrepare(
    system: string,
    user: StandardUserDto | import('@shared/types/user-payload').UserPayload,
    operation: string,
  ): Promise<EntraPrepare> {
    if (system === 'entra-id') {
      return validateEntraPrepare(this.entra, user as StandardUserDto, operation);
    }
    // not reached: prepare refuses systems outside SUPPORTED_SYSTEMS first
    return { ok: false, reason: `Unknown system: ${system}` };
  }

  /**
   * Execute operation on system
   */
  private async executeOperation(
    system: string,
    user: StandardUserDto | import('@shared/types/user-payload').UserPayload,
    operation: string,
    previousState: Record<string, unknown> | undefined,
    tenantId?: string,
    correlationId?: string,
  ): Promise<{ createdAccountId?: string }> {
    const u = user as StandardUserDto;
    this.logger.log(`[DistTx] Executing ${operation} on ${system}`);

    switch (system) {
      case 'entra-id':
        // The state captured at prepare, read back: an expired snapshot fails the commit.
        return commitEntraOperation(
          this.entra,
          u,
          operation,
          await this.previousStateOf(previousState, tenantId),
          tenantId,
          correlationId,
        );

      default:
        throw new ConnectorException(`Unknown system: ${system}`);
    }
  }
}
