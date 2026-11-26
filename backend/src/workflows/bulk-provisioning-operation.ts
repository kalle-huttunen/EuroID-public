/**
 * One bulk operation in bulkProvisioningWorkflow: the Golden Record save, then one activity per
 * target system. Workflow code: bundled into the workflow, so it must stay deterministic (no I/O,
 * clock or randomness outside activities).
 */
import {
  proxyActivities,
  workflowInfo,
  ActivityFailure,
  ApplicationFailure,
  isCancellation,
} from '@temporalio/workflow';
import type { BulkProvisioningActivities } from '../activities/bulk-provisioning.activities';
import type { IdentityActivities } from '../activities/identity.activities';
import {
  BulkOperationType,
  type BulkOperation,
  type HubWrite,
  type OperationResult,
  type SystemOperationResult,
} from './workflow-types';
import { BATCH_OPERATION_RETRY } from '../infrastructure/config/retry-policies';
import { RATE_LIMITED_FAILURE_TYPE } from '../shared/errors/rate-limited.exception';
import { isPatched } from './workflow-versioning';
import { workflowNow } from './workflow-time';

/**
 * Any activity failure in an operation (a Hub save, a system activity) becomes a failed result,
 * so continueOnError and the fail-fast rollback handle it like any other failure. Older histories
 * failed the run on it without rollback (only an exhausted 429 became a result).
 */
const FAILURES_AS_RESULTS_PATCH = 'bulk-provisioning:failures-as-results';
/**
 * The Golden Record is saved with saveToHubWithSnapshot, which keeps what the write overwrote so
 * the rollback can undo it (result.hubWrite). Histories from before this patch call saveToHub.
 */
const HUB_COMPENSATION_PATCH = 'bulk-provisioning:hub-compensation';
/**
 * Each system activity gets a key that is the same for every attempt, so the Entra pre-change
 * snapshot is taken once: a retry after the first attempt changed the account keeps the state
 * from before it. Histories from before this patch call executeSystemOperation without a key.
 */
const ENTRA_SNAPSHOT_KEY_PATCH = 'bulk-provisioning:entra-snapshot-key';
/**
 * A DISABLE or DELETE writes no Golden Record: it changes the target account, and the request
 * body is no Hub record (an upsert from it minted an identity or overwrote one, its status
 * included, so a deleted Entra user could stay ACTIVE in the Hub; hunt 2026-11-25 02 F7).
 * Histories from before this patch save the body to the Hub for every operation type.
 */
const NO_HUB_WRITE_FOR_REMOVALS_PATCH = 'bulk-provisioning:no-hub-write-for-removals';

/** An operation on the target account only: the Golden Record is not written from its body. */
function removesAccess(op: BulkOperation): boolean {
  return op.type === BulkOperationType.DISABLE || op.type === BulkOperationType.DELETE;
}

const bulkActivities = proxyActivities<
  Pick<
    BulkProvisioningActivities,
    'executeOperation' | 'executeSystemOperation' | 'saveToHubWithSnapshot'
  > &
    Pick<IdentityActivities, 'saveToHub'>
>({
  startToCloseTimeout: '2 minutes',
  retry: BATCH_OPERATION_RETRY,
});

/** An activity failure to record as a failed result (not a cancellation), see the patch. */
function isRecordableFailure(error: unknown): error is ActivityFailure {
  return (
    error instanceof ActivityFailure &&
    !isCancellation(error) &&
    isPatched(FAILURES_AS_RESULTS_PATCH)
  );
}

/**
 * Run one operation: save the Golden Record, then one activity per target system, so a 429
 * retry re-runs only the rate-limited system and never one that already succeeded. A system
 * that runs out of attempts (on 429s or any other failure) is recorded as failed, and a failed
 * Hub save fails the operation before any system runs; the caller's continueOnError check then
 * decides whether the batch goes on. Histories from before this patch replay the single
 * executeOperation activity.
 */
export async function runOperation(op: BulkOperation, tenantId: string): Promise<OperationResult> {
  if (!isPatched('bulk-provisioning:per-system-activities')) {
    return bulkActivities.executeOperation(op, tenantId);
  }
  const startedAt = workflowNow();
  const systemResults: SystemOperationResult[] = [];
  let rateLimitHits = 0;
  let hubError: string | undefined;
  let hubWrite: HubWrite | undefined;
  try {
    // Golden Record first: no system without it. A removal writes none (see the patch).
    if (removesAccess(op) && isPatched(NO_HUB_WRITE_FOR_REMOVALS_PATCH)) {
      // The target system activities below change the account
    } else if (isPatched(HUB_COMPENSATION_PATCH)) {
      // Same key on every attempt of the activity: a retry keeps the first snapshot.
      const snapshotKey = `${workflowInfo().runId}/${op.id}`;
      hubWrite = await bulkActivities.saveToHubWithSnapshot(op.user, tenantId, snapshotKey);
    } else {
      await bulkActivities.saveToHub(op.user, tenantId);
    }
  } catch (error: unknown) {
    if (!isRecordableFailure(error)) throw error;
    hubError = `Golden Record save failed: ${error.cause?.message || error.message}`;
  }
  for (const system of hubError ? [] : op.targetSystems) {
    const systemStartedAt = workflowNow();
    try {
      // The identity the Hub write saved: a trailing argument, so no change to the commands
      const outcome = isPatched(ENTRA_SNAPSHOT_KEY_PATCH)
        ? await bulkActivities.executeSystemOperation(
            op,
            system,
            tenantId,
            undefined,
            `${workflowInfo().runId}/${op.id}/${system}`,
            hubWrite?.identityId,
          )
        : await bulkActivities.executeSystemOperation(op, system, tenantId);
      systemResults.push(outcome.result);
      rateLimitHits += outcome.rateLimitHits;
    } catch (error: unknown) {
      const cause = error instanceof ActivityFailure ? error.cause : undefined;
      const rateLimited =
        cause instanceof ApplicationFailure && cause.type === RATE_LIMITED_FAILURE_TYPE;
      if (!rateLimited && !isRecordableFailure(error)) throw error;
      systemResults.push({
        system,
        success: false,
        error: rateLimited
          ? `Rate limit retries exhausted: ${cause.message}`
          : cause?.message || (error as Error).message,
        apiCallsUsed: 0,
        durationMs: workflowNow().getTime() - systemStartedAt.getTime(),
      });
    }
  }
  const completedAt = workflowNow();
  const u = op.user as { sourceUserId?: string; email?: string };
  return {
    operationId: op.id,
    success: !hubError && systemResults.every((r) => r.success),
    type: op.type,
    userId: u.sourceUserId || u.email || '',
    email: u.email || '',
    systemResults,
    rateLimitHits,
    startedAt,
    completedAt,
    durationMs: completedAt.getTime() - startedAt.getTime(),
    ...(hubError ? { error: hubError } : {}),
    ...(hubWrite ? { hubWrite } : {}),
  };
}
