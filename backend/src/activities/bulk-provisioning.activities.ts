/**
 * Bulk Provisioning Activities
 *
 * Temporal activities for handling bulk user provisioning operations.
 * These activities wrap the core provisioning logic with batch processing,
 * error handling, and rollback capabilities.
 */

import { Injectable, Logger } from '@nestjs/common';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { validateActivityContext } from '@shared/utils/activity-context';
import {
  BulkOperationInput,
  BulkOperationType,
  HubWrite,
  OperationResult,
  OperationRollback,
  SystemOperationResult,
  TargetStateSnapshot,
  ValidationResult,
  OperationPartitionsInput,
} from '@shared/dtos/bulk-operation.dto';
import type { StandardUserDto } from '@shared/dtos/standard-user.dto';
import { EntraActivities } from './entra.activities';
import { IdentityActivities } from './identity.activities';
import { RateLimiterActivities } from './rate-limiter.activities';
import { RateLimitedException } from '@shared/errors/rate-limited.exception';
import { validateBulkBatch } from './bulk-provisioning-validation';
import { compensateOperation as compensateBulkOperation } from './bulk-provisioning-rollback';
import { EntraService } from '../modules/connectors/entra-connector/entra.service';
import { PolicyEngineService } from '../modules/policy/policy-engine.service';
import { FileOutboundService } from '../modules/connectors/file-outbound-connector/file-outbound.service';
import { DiscordWebhookService } from '../modules/connectors/discord-webhook-connector/discord-webhook.service';
import { GitHubService } from '../modules/connectors/github-connector/github.service';
import { GoogleSheetsService } from '../modules/connectors/google-sheets-connector/google-sheets.service';
import type { EntraUserState } from '../modules/connectors/entra-connector/entra.types';
import { RollbackSnapshotService } from '../modules/bulk-provisioning/rollback-snapshot.service';
import { IdentityService } from '../modules/identity/identity.service';
import { saveToHubWithSnapshot } from './bulk-provisioning-hub';
import { recordProvisionedEntraAccount } from './bulk-provisioning-created-account';
import {
  markRemovedAccounts,
  type RemovedAccount,
  type RemovedAccountsMarked,
} from './bulk-provisioning-removals';
import { maskEmail } from '../modules/identity/identity-pii';

@Injectable()
export class BulkProvisioningActivities {
  private readonly logger = new Logger(BulkProvisioningActivities.name);

  constructor(
    private readonly entraActivities: EntraActivities,
    private readonly identityActivities: IdentityActivities,
    private readonly rateLimiter: RateLimiterActivities,
    private readonly policyEngine: PolicyEngineService,
    private readonly fileOutboundService: FileOutboundService,
    private readonly discordWebhookService: DiscordWebhookService,
    private readonly githubService: GitHubService,
    private readonly googleSheetsService: GoogleSheetsService,
    private readonly entraService: EntraService,
    private readonly snapshots: RollbackSnapshotService,
    private readonly identityService: IdentityService,
  ) {}

  /**
   * Validate a batch of operations before execution (SoD, required fields, risk level).
   * Logic lives in bulk-provisioning-validation.ts.
   */
  async validateBatch(
    operations: BulkOperationInput[],
    tenantId?: string,
  ): Promise<ValidationResult> {
    return validateBulkBatch(operations, tenantId, this.policyEngine);
  }

  /**
   * Partition operations by type for ordered execution
   */
  async partitionOperations(operations: BulkOperationInput[]): Promise<OperationPartitionsInput> {
    const partitions: OperationPartitionsInput = {
      creates: [],
      updates: [],
      deletes: [],
      disables: [],
    };

    for (const op of operations) {
      switch (op.type) {
        case BulkOperationType.CREATE:
          partitions.creates.push(op);
          break;
        case BulkOperationType.UPDATE:
          partitions.updates.push(op);
          break;
        case BulkOperationType.DELETE:
          partitions.deletes.push(op);
          break;
        case BulkOperationType.DISABLE:
          partitions.disables.push(op);
          break;
      }
    }

    this.logger.log(
      `[BulkProvisioning] Partitioned: ${partitions.creates.length} creates, ${partitions.updates.length} updates, ${partitions.deletes.length} deletes, ${partitions.disables.length} disables`,
    );

    return partitions;
  }

  /**
   * Execute a single operation across all target systems in one activity.
   * Only bulk workflow histories recorded before the patch
   * `bulk-provisioning:per-system-activities` schedule this; newer runs call saveToHub and then
   * executeSystemOperation once per system, so a 429 retry re-runs only the rate-limited system.
   */
  async executeOperation(
    operation: BulkOperationInput,
    tenantId?: string,
    correlationId?: string,
  ): Promise<OperationResult> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      async () => {
        const startTime = new Date();
        const u = operation.user as StandardUserDto;
        this.logger.log(`[BulkProvisioning] Executing ${operation.type} for ${maskEmail(u.email)}`);

        // First, save to Identity Hub (Golden Record) — Golden Record First: do not proceed if Hub save fails
        try {
          await this.identityActivities.saveToHub(operation.user, tenantId, correlationId);
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.error(`[BulkProvisioning] Failed to save to Hub: ${message}`);
          throw error; // Do not proceed to target systems when Hub save fails (violates Golden Record First)
        }

        const systemResults: SystemOperationResult[] = [];
        let rateLimitHits = 0;
        for (const system of operation.targetSystems) {
          const outcome = await this.executeSystemOperation(
            operation,
            system,
            tenantId,
            correlationId,
          );
          systemResults.push(outcome.result);
          rateLimitHits += outcome.rateLimitHits;
        }

        const overallSuccess = systemResults.every((r) => r.success);
        const totalApiCalls = systemResults.reduce((sum, r) => sum + r.apiCallsUsed, 0);
        const endTime = new Date();
        const result: OperationResult = {
          operationId: operation.id,
          success: overallSuccess,
          type: operation.type,
          userId: u.sourceUserId || u.email,
          email: u.email,
          systemResults,
          rateLimitHits,
          startedAt: startTime,
          completedAt: endTime,
          durationMs: endTime.getTime() - startTime.getTime(),
        };

        this.logger.log(
          `[BulkProvisioning] Operation ${operation.id} completed. Success: ${overallSuccess}, Duration: ${result.durationMs}ms, API calls: ${totalApiCalls}`,
        );

        return result;
      },
      { correlationId },
    );
  }

  /**
   * Save the Golden Record of a bulk operation and keep what the write overwrote (encrypted, by
   * reference) so a rollback can undo it. `snapshotKey` is the same for every attempt of this
   * activity, so a retry keeps the state from before the first attempt.
   */
  async saveToHubWithSnapshot(
    user: BulkOperationInput['user'],
    tenantId?: string,
    snapshotKey?: string,
    correlationId?: string,
  ): Promise<HubWrite> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    if (!snapshotKey) throw new Error('snapshotKey is required');
    return withTenantContext(
      tenantId ?? '',
      () =>
        saveToHubWithSnapshot(user, snapshotKey, {
          identity: this.identityService,
          snapshots: this.snapshots,
          tenantId: tenantId ?? '',
        }),
      { correlationId },
    );
  }

  /**
   * Execute one operation on one target system. A 429 (RateLimitedException) fails this
   * activity, and RateLimitActivityInterceptor makes Temporal retry it after the target's
   * retry-after; other failures come back as a failed system result.
   * `snapshotKey` is the same for every attempt of this activity: the Entra pre-change snapshot
   * stored under it on the first attempt is the one every retry returns. Without it (histories
   * from before the patch `bulk-provisioning:entra-snapshot-key`) each attempt takes its own.
   * `identityId`: the identity the operation's Golden Record write saved (result.hubWrite). Entra
   * ID gets it on the profile, so its provisioning events go under it and reach the identity
   * timeline; without it (older histories) they go under the connector.
   */
  async executeSystemOperation(
    operation: BulkOperationInput,
    system: string,
    tenantId?: string,
    correlationId?: string,
    snapshotKey?: string,
    identityId?: string,
  ): Promise<{ result: SystemOperationResult; rateLimitHits: number }> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      async () => {
        const u = operation.user as StandardUserDto;
        const systemStartTime = Date.now();
        let rateLimitHits = 0;

        try {
          // Waits out a throttle here; an exhausted window throws RateLimitedException (see catch)
          const waitMs = await this.rateLimiter.checkAndWait(system);
          if (waitMs > 0) {
            rateLimitHits++;
            this.logger.warn(`[BulkProvisioning] Rate limit throttle for ${system}: ${waitMs}ms`);
          }

          let result: SystemOperationResult;

          switch (system) {
            case 'entra-id':
              result = await this.executeEntraOperation(
                operation,
                tenantId ?? '',
                correlationId,
                snapshotKey,
                identityId,
              );
              break;
            case 'file-outbound':
              result = await this.executeConnectorOperation(system, operation, () =>
                this.fileOutboundService.create(u),
              );
              break;
            case 'discord-webhook':
              result = await this.executeConnectorOperation(system, operation, () =>
                this.discordWebhookService.create(u),
              );
              break;
            case 'github':
              result = await this.executeConnectorOperation(system, operation, () =>
                this.githubService.create(u),
              );
              break;
            case 'google-sheets':
              result = await this.executeConnectorOperation(system, operation, () =>
                this.googleSheetsService.create(u),
              );
              break;
            default:
              result = {
                system,
                success: false,
                error: `Unknown system: ${system}`,
                apiCallsUsed: 0,
                durationMs: 0,
              };
          }

          // Record API usage for rate limiting
          await this.rateLimiter.recordApiCalls(system, result.apiCallsUsed);
          return { result, rateLimitHits };
        } catch (error: unknown) {
          // 429: fail the activity so RateLimitActivityInterceptor makes it a retryable
          // failure that Temporal retries after the target's retry-after delay.
          if (error instanceof RateLimitedException) throw error;
          const message = error instanceof Error ? error.message : String(error);
          this.logger.error(`[BulkProvisioning] System ${system} failed: ${message}`);

          return {
            result: {
              system,
              success: false,
              error: message,
              apiCallsUsed: 1, // Estimate
              durationMs: Date.now() - systemStartTime,
            },
            rateLimitHits,
          };
        }
      },
      { correlationId },
    );
  }

  /**
   * Execute a generic connector operation (File, Discord, GitHub, Sheets).
   */
  private async executeConnectorOperation(
    system: string,
    operation: BulkOperationInput,
    provisionFn: () => Promise<{ targetUserId: string } | string>,
  ): Promise<SystemOperationResult> {
    const startTime = Date.now();
    try {
      if (operation.type !== BulkOperationType.CREATE) {
        return {
          system,
          success: false,
          error: `Connector ${system} only supports CREATE operations`,
          apiCallsUsed: 0,
          durationMs: Date.now() - startTime,
        };
      }
      const result = await provisionFn();
      const targetUserId = typeof result === 'string' ? result : result.targetUserId;
      return {
        system,
        success: true,
        objectId: targetUserId,
        apiCallsUsed: 1,
        durationMs: Date.now() - startTime,
      };
    } catch (error: unknown) {
      if (error instanceof RateLimitedException) throw error; // retried by Temporal, see executeSystemOperation
      const message = error instanceof Error ? error.message : String(error);
      return {
        system,
        success: false,
        error: message,
        apiCallsUsed: 1,
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Execute Entra ID operation
   */
  private async executeEntraOperation(
    operation: BulkOperationInput,
    tenantId: string,
    correlationId?: string,
    snapshotKey?: string,
    identityId?: string,
  ): Promise<SystemOperationResult> {
    const startTime = Date.now();
    let apiCallsUsed = 0;
    const u = operation.user as StandardUserDto;
    // Taken before the change: a failure after the change began keeps it, so the rollback can
    // undo an account the provisioning made or changed before a later step (license, groups)
    let previousState: TargetStateSnapshot | undefined;

    try {
      switch (operation.type) {
        case BulkOperationType.CREATE:
        case BulkOperationType.UPDATE: {
          // CREATE: user check (1) + create (1) + license (1) + groups (2); UPDATE: lookup (1) +
          // update (1) + groups (1). Plus the snapshot (lookup + read) that a rollback restores.
          apiCallsUsed = (operation.type === BulkOperationType.CREATE ? 5 : 3) + 2;
          const captured = await this.entraService.captureUserState(u);
          previousState = snapshotKey
            ? await this.sealSnapshotOnce(captured, tenantId, snapshotKey)
            : await this.sealSnapshot(captured, tenantId);
          const provisioned = await this.entraActivities.provisionUserToEntra(
            identityId ? ({ ...u, _id: identityId } as StandardUserDto) : u,
            undefined,
            undefined,
            tenantId,
            correlationId,
          );
          const deps = { identity: this.identityService, tenantId, logger: this.logger };
          await recordProvisionedEntraAccount(u, provisioned.objectId, { ...deps, identityId });
          return {
            system: 'entra-id',
            success: provisioned.success,
            objectId: provisioned.objectId,
            skipped: provisioned.skipped,
            previousState,
            apiCallsUsed,
            durationMs: Date.now() - startTime,
          };
        }

        case BulkOperationType.DISABLE: {
          apiCallsUsed = 4; // Lookup and state (2) + lookup and disable (2)
          // An account disabled before the batch is left as it is (skipped), so a rollback,
          // which enables what the batch disabled, never enables it. Keyed: the state the
          // first attempt read wins, as a retry after it may find the account disabled.
          const enabledBefore = await this.accountEnabledBefore(u, tenantId, snapshotKey);
          if (enabledBefore === false) {
            return {
              system: 'entra-id',
              success: true,
              skipped: true,
              apiCallsUsed: 2,
              durationMs: Date.now() - startTime,
            };
          }
          const disableSuccess = await this.entraActivities.disableEntraUser(
            u.email ?? '',
            tenantId,
            correlationId,
          );
          return {
            system: 'entra-id',
            success: disableSuccess,
            apiCallsUsed,
            durationMs: Date.now() - startTime,
          };
        }

        case BulkOperationType.DELETE:
          // Not reversible: rollbackOperation cannot bring a deleted account back.
          apiCallsUsed = 1; // Delete (1); a user that is already gone counts as deleted
          await this.entraActivities.deleteUser(
            u.email ?? '',
            undefined,
            undefined,
            tenantId,
            correlationId,
          );
          return {
            system: 'entra-id',
            success: true,
            apiCallsUsed,
            durationMs: Date.now() - startTime,
          };

        default:
          return {
            system: 'entra-id',
            success: false,
            error: `Unsupported operation type: ${operation.type}`,
            apiCallsUsed: 0,
            durationMs: Date.now() - startTime,
          };
      }
    } catch (error: unknown) {
      if (error instanceof RateLimitedException) throw error; // retried by Temporal, see executeSystemOperation
      const message = error instanceof Error ? error.message : String(error);
      return {
        system: 'entra-id',
        success: false,
        error: message,
        ...(previousState ? { previousState } : {}),
        apiCallsUsed,
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Whether the Entra account was enabled before this operation (undefined: no such account).
   * With `snapshotKey` the state is stored under it on the first attempt and that one is read
   * back, as for a CREATE or UPDATE (sealSnapshotOnce).
   */
  private async accountEnabledBefore(
    user: StandardUserDto,
    tenantId: string,
    snapshotKey?: string,
  ): Promise<boolean | undefined> {
    const objectId = await this.entraService.checkUserExists(user.email ?? '');
    const now: EntraUserState = objectId
      ? {
          existed: true,
          objectId,
          attributes: {
            accountEnabled: (await this.entraService.getCredentialState(objectId)).accountEnabled,
          },
        }
      : { existed: false };
    if (!snapshotKey) return now.attributes?.accountEnabled as boolean | undefined;
    const ref = await this.snapshots.save(tenantId, 'entra-state', now, snapshotKey);
    const first = await this.snapshots.load<EntraUserState>(tenantId, 'entra-state', ref);
    return (first ?? now).attributes?.accountEnabled as boolean | undefined;
  }

  /**
   * The pre-change Entra state with its attribute values (personal data) moved into the
   * encrypted rollback snapshot store: the workflow history and the result get the reference.
   * A failed save fails the system before Entra is changed.
   */
  private async sealSnapshot(
    state: EntraUserState,
    tenantId: string,
  ): Promise<TargetStateSnapshot> {
    if (!state.existed) return { existed: false };
    const snapshotRef = await this.snapshots.save(
      tenantId,
      'entra-attributes',
      state.attributes ?? {},
    );
    return { existed: true, objectId: state.objectId, snapshotRef };
  }

  /**
   * Retry-safe form of sealSnapshot: the whole state (whether the account existed, its object
   * ID, the values) is stored under `key`, and the state from the first attempt wins. A retry
   * after the first attempt already created or changed the account would otherwise capture that
   * change as the "before" state, and the rollback would keep it.
   */
  private async sealSnapshotOnce(
    state: EntraUserState,
    tenantId: string,
    key: string,
  ): Promise<TargetStateSnapshot> {
    const snapshotRef = await this.snapshots.save(tenantId, 'entra-state', state, key);
    const first = await this.snapshots.load<EntraUserState>(tenantId, 'entra-state', snapshotRef);
    if (!first) throw new Error('The Entra snapshot taken before the change was not stored');
    if (!first.existed) return { existed: false };
    return { existed: true, objectId: first.objectId, snapshotRef, snapshotKind: 'entra-state' };
  }

  /**
   * Undo what a completed operation changed, per target system (see bulk-provisioning-rollback.ts).
   * Systems that cannot be compensated come back as not rolled back, with the reason.
   */
  async compensateOperation(
    result: OperationResult,
    tenantId?: string,
    correlationId?: string,
  ): Promise<OperationRollback> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      async () => {
        this.logger.warn(`[BulkProvisioning] Rolling back operation ${result.operationId}`);
        const outcome = await compensateBulkOperation(result, {
          entraActivities: this.entraActivities,
          entraService: this.entraService,
          snapshots: this.snapshots,
          identity: this.identityService,
          tenantId: tenantId ?? '',
          correlationId,
        });
        if (!outcome.rolledBack) {
          this.logger.error(`[BulkProvisioning] ${result.operationId}: ${outcome.reason}`);
        }
        return outcome;
      },
      { correlationId },
    );
  }

  /**
   * After a bulk run: mark the provisioning entries of the accounts its DISABLE and DELETE
   * operations removed DEPROVISIONED (see bulk-provisioning-removals.ts). Only bulk workflow
   * histories with the patch `bulk-provisioning:mark-removed-accounts` schedule it.
   */
  async markRemovedAccounts(
    removals: RemovedAccount[],
    tenantId?: string,
    correlationId?: string,
  ): Promise<RemovedAccountsMarked> {
    validateActivityContext({ tenantId: tenantId ?? '', correlationId });
    return withTenantContext(
      tenantId ?? '',
      async () => {
        const outcome = await markRemovedAccounts(removals, {
          identity: this.identityService,
          tenantId: tenantId ?? '',
        });
        if (outcome.notFound.length > 0) {
          this.logger.warn(
            `[BulkProvisioning] No identity found for removed accounts of operations ${outcome.notFound.join(', ')}`,
          );
        }
        return outcome;
      },
      { correlationId },
    );
  }

  /**
   * Boolean form of compensateOperation. Only bulk workflow histories recorded before the patch
   * `bulk-provisioning:compensate-operation` schedule it; true only when every changed system
   * was compensated.
   */
  async rollbackOperation(
    result: OperationResult,
    tenantId?: string,
    correlationId?: string,
  ): Promise<boolean> {
    return (await this.compensateOperation(result, tenantId, correlationId)).rolledBack;
  }
}
