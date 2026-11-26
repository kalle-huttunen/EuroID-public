/**
 * Bulk Provisioning Workflow
 *
 * Temporal workflow for handling mass user provisioning with mixed operations
 * (CREATE/UPDATE/DELETE) across multiple target systems.
 *
 * ARCHITECTURE:
 * - Executes operations in phases: CREATE → UPDATE → DISABLE → DELETE
 * - Implements batch processing with configurable concurrency
 * - Respects API rate limits
 * - Provides rollback capabilities
 * - Supports human approval gates for destructive operations
 *
 * SAFETY FEATURES:
 * - Pre-flight validation
 * - Dry-run mode
 * - Progressive execution with error handling
 * - Comprehensive result reporting
 */

import {
  proxyActivities,
  defineQuery,
  defineSignal,
  setHandler,
  sleep,
  condition,
  log,
  ApplicationFailure,
} from '@temporalio/workflow';
import type { BulkProvisioningActivities } from '../activities/bulk-provisioning.activities';
import type { RateLimiterActivities } from '../activities/rate-limiter.activities';
import {
  BulkOperationRequest,
  BulkOperationResult,
  BulkOperation,
  OperationResult,
  OperationPartitions,
  ValidationResult,
} from './workflow-types';
import { BATCH_OPERATION_RETRY } from '../infrastructure/config/retry-policies';
import { isPatched } from './workflow-versioning';
import { buildBulkResult, dryRunResults } from './bulk-provisioning-results';
import { rollBackSuccesses } from './bulk-provisioning-compensation';
import { runOperation } from './bulk-provisioning-operation';
import { markRemovedAccounts } from './bulk-provisioning-removals';
import { workflowNow } from './workflow-time';

/**
 * Fail-fast (continueOnError=false) keeps the failed batch's results, rolls back the successful
 * operations so far and stops the deletes at the first failed one. Histories from before this
 * patch end the run at the failed batch without rollback.
 */
const FAIL_FAST_ROLLBACK_PATCH = 'bulk-provisioning:fail-fast-rollback';
/** DISABLE operations run (after updates, before deletes); older histories skipped them. */
const RUN_DISABLES_PATCH = 'bulk-provisioning:run-disables';
/**
 * The cancel signal is read before every batch and every delete, and a cancelled run compensates
 * what it changed (the rollback of a failed fail-fast run) and ends CANCELLED with its results.
 * Histories from before this patch read it only between phases and at the delete approval, and
 * ended FAILED without a rollback.
 */
const CANCEL_PATCH = 'bulk-provisioning:cancel-compensates';
const BATCH_EXECUTION_FAILED = 'BatchExecutionFailed';
const WORKFLOW_CANCELLED = 'WorkflowCancelled';
const CANCELLED_BY_USER = 'Workflow cancelled by user';

// Proxy activities with appropriate timeouts
const bulkActivities = proxyActivities<
  Pick<BulkProvisioningActivities, 'validateBatch' | 'partitionOperations'>
>({
  startToCloseTimeout: '2 minutes',
  retry: BATCH_OPERATION_RETRY,
});

const rateLimiterActivities = proxyActivities<RateLimiterActivities>({
  startToCloseTimeout: '10 seconds',
});

// Queries - allow external systems to inspect workflow state
export const getCurrentPhaseQuery = defineQuery<string>('getCurrentPhase');
export const getProgressQuery = defineQuery<WorkflowProgress>('getProgress');
export const getResultsQuery = defineQuery<OperationResult[]>('getResults');

// Signals - allow external control (signals don't take parameters in Temporal)
export const approveDeletesSignal = defineSignal('approveDeletes');
export const cancelWorkflowSignal = defineSignal('cancelWorkflow');

/**
 * Parse duration string to ms (pure, deterministic). Supports: '1 hour', '30m', '60s'
 */
function parseDurationToMs(s: string | undefined): number {
  if (!s || typeof s !== 'string') return 3600000;
  const m = s.trim().match(/^(\d+)\s*(hour|h|minute|min|m|second|sec|s)?$/i);
  if (!m) return 3600000;
  const n = parseInt(m[1], 10);
  const unit = (m[2] || 'h').toLowerCase();
  if (unit === 'h' || unit === 'hour') return n * 3600000;
  if (unit === 'm' || unit === 'min' || unit === 'minute') return n * 60000;
  if (unit === 's' || unit === 'sec' || unit === 'second') return n * 1000;
  return 3600000;
}

/**
 * Progress tracking interface
 */
interface WorkflowProgress {
  phase: string;
  currentOperation: number;
  totalOperations: number;
  percentComplete: number;
  operationsSuccessful: number;
  operationsFailed: number;
  estimatedTimeRemainingMs: number;
}

/**
 * Main bulk provisioning workflow
 */
export async function bulkProvisioningWorkflow(
  request: BulkOperationRequest,
): Promise<BulkOperationResult> {
  const startTime = workflowNow();
  const tenantId = request.tenantId ?? '';

  // Workflow state
  let currentPhase = 'INITIALIZING';
  let progress: WorkflowProgress = {
    phase: currentPhase,
    currentOperation: 0,
    totalOperations: request.operations.length,
    percentComplete: 0,
    operationsSuccessful: 0,
    operationsFailed: 0,
    estimatedTimeRemainingMs: 0,
  };
  let results: OperationResult[] = [];
  let cancelled = false;
  let deletesApproved = false;

  // Set up query handlers
  setHandler(getCurrentPhaseQuery, () => currentPhase);
  setHandler(getProgressQuery, () => progress);
  setHandler(getResultsQuery, () => results);

  // Set up signal handlers
  setHandler(approveDeletesSignal, () => {
    deletesApproved = true;
  });
  setHandler(cancelWorkflowSignal, () => {
    cancelled = true;
  });
  const isCancelled = () => cancelled;

  try {
    // ============================================================
    // PHASE 1: PRE-FLIGHT VALIDATION
    // ============================================================
    currentPhase = 'VALIDATION';
    progress.phase = currentPhase;

    const validationResult: ValidationResult = await bulkActivities.validateBatch(
      request.operations,
      tenantId,
    );

    if (!validationResult.safe) {
      throw ApplicationFailure.nonRetryable(
        `Validation failed: ${validationResult.errors.map((e) => e.message).join(', ')}`,
        'ValidationFailed',
      );
    }

    if (validationResult.risk.level === 'CRITICAL' || validationResult.risk.level === 'HIGH') {
      log.warn(`[BulkWorkflow] HIGH RISK batch`, {
        reasons: validationResult.risk.reasons.join(', '),
      });
    }

    // ============================================================
    // PHASE 2: INITIALIZE RATE LIMITERS
    // ============================================================
    currentPhase = 'RATE_LIMIT_INIT';
    progress.phase = currentPhase;

    const targetSystems = [...new Set(request.operations.flatMap((op) => op.targetSystems))].sort();
    for (const system of targetSystems) {
      await rateLimiterActivities.initializeRateLimit(system);
    }

    // ============================================================
    // PHASE 3: PARTITION OPERATIONS
    // ============================================================
    currentPhase = 'PARTITIONING';
    progress.phase = currentPhase;

    const partitions: OperationPartitions = await bulkActivities.partitionOperations(
      request.operations,
    );

    // ============================================================
    // PHASE 4: EXECUTE CREATES (Parallel Batches)
    // ============================================================
    if (partitions.creates.length > 0) {
      currentPhase = 'EXECUTING_CREATES';
      progress.phase = currentPhase;

      const createResults = await executeBatch(
        partitions.creates,
        request.batchSize || 10,
        'CREATE',
        request.dryRun || false,
        request.continueOnError || false,
        progress,
        results,
        tenantId,
        request.batchDelayMs ?? 500,
        isCancelled,
      );

      results.push(...createResults);
      progress.operationsSuccessful += createResults.filter((r) => r.success).length;
      progress.operationsFailed += createResults.filter((r) => !r.success).length;
    }

    // Check if cancelled
    if (cancelled) {
      throw ApplicationFailure.nonRetryable(CANCELLED_BY_USER, WORKFLOW_CANCELLED);
    }

    // ============================================================
    // PHASE 5: EXECUTE UPDATES (Parallel Batches)
    // ============================================================
    if (partitions.updates.length > 0) {
      currentPhase = 'EXECUTING_UPDATES';
      progress.phase = currentPhase;

      const updateResults = await executeBatch(
        partitions.updates,
        request.batchSize || 10,
        'UPDATE',
        request.dryRun || false,
        request.continueOnError || false,
        progress,
        results,
        tenantId,
        request.batchDelayMs ?? 500,
        isCancelled,
      );

      results.push(...updateResults);
      progress.operationsSuccessful += updateResults.filter((r) => r.success).length;
      progress.operationsFailed += updateResults.filter((r) => !r.success).length;
    }

    // Check if cancelled
    if (cancelled) {
      throw ApplicationFailure.nonRetryable(CANCELLED_BY_USER, WORKFLOW_CANCELLED);
    }

    // ============================================================
    // PHASE 5b: EXECUTE DISABLES (Parallel Batches)
    // ============================================================
    if (partitions.disables?.length > 0 && isPatched(RUN_DISABLES_PATCH)) {
      currentPhase = 'EXECUTING_DISABLES';
      progress.phase = currentPhase;

      const disableResults = await executeBatch(
        partitions.disables,
        request.batchSize || 10,
        'DISABLE',
        request.dryRun || false,
        request.continueOnError || false,
        progress,
        results,
        tenantId,
        request.batchDelayMs ?? 500,
        isCancelled,
      );

      results.push(...disableResults);
      progress.operationsSuccessful += disableResults.filter((r) => r.success).length;
      progress.operationsFailed += disableResults.filter((r) => !r.success).length;

      if (cancelled) {
        throw ApplicationFailure.nonRetryable(CANCELLED_BY_USER, WORKFLOW_CANCELLED);
      }
    }

    // ============================================================
    // PHASE 6: EXECUTE DELETES (With Approval Gate)
    // ============================================================
    if (partitions.deletes.length > 0) {
      currentPhase = 'AWAITING_DELETE_APPROVAL';
      progress.phase = currentPhase;

      // If human approval is required, wait for signal
      if (request.requireApprovalForDeletes && !deletesApproved) {
        log.info(`[BulkWorkflow] Waiting for approval to delete`, {
          count: partitions.deletes.length,
        });

        const req = request as { deleteApprovalTimeoutMs?: number; deleteApprovalTimeout?: string };
        const deleteApprovalTimeoutMs =
          req.deleteApprovalTimeoutMs ?? parseDurationToMs(req.deleteApprovalTimeout);
        const approvalReceived = await condition(
          () => deletesApproved || cancelled,
          deleteApprovalTimeoutMs,
        );

        if (!approvalReceived && !deletesApproved) {
          throw ApplicationFailure.nonRetryable(
            'Delete approval timeout: No approval received within 1 hour',
            'ApprovalTimeout',
          );
        }

        if (cancelled) {
          throw ApplicationFailure.nonRetryable(
            'Workflow cancelled before deletes could execute',
            WORKFLOW_CANCELLED,
          );
        }
      }

      currentPhase = 'EXECUTING_DELETES';
      progress.phase = currentPhase;

      // Execute deletes SEQUENTIALLY (not in parallel) for safety
      const deleteResults = await executeSequential(
        partitions.deletes,
        'DELETE',
        request.dryRun || false,
        request.continueOnError || false,
        progress,
        results,
        tenantId,
        request.deleteSequentialDelayMs ?? 1000,
        isCancelled,
      );

      results.push(...deleteResults);
      progress.operationsSuccessful += deleteResults.filter((r) => r.success).length;
      progress.operationsFailed += deleteResults.filter((r) => !r.success).length;
    }

    // ============================================================
    // PHASE 7: ROLLBACK ON FAILURES (if not continueOnError)
    // ============================================================
    if (!request.continueOnError && progress.operationsFailed > 0) {
      currentPhase = 'ROLLBACK';
      progress.phase = currentPhase;

      await rollBackSuccesses(results, tenantId);
    }

    // ============================================================
    // PHASE 8: FINALIZE & RETURN RESULTS
    // ============================================================
    await markRemovedAccounts(request, results, tenantId);
    currentPhase = 'COMPLETED';
    progress.phase = currentPhase;
    progress.percentComplete = 100;

    return buildBulkResult(request, results, startTime, workflowNow());
  } catch (error: unknown) {
    const errors = [error instanceof Error ? error.message : String(error)];
    const failedFast = error instanceof ApplicationFailure && error.type === BATCH_EXECUTION_FAILED;
    const cancelledRun = error instanceof ApplicationFailure && error.type === WORKFLOW_CANCELLED;
    if (cancelledRun && isPatched(CANCEL_PATCH)) {
      // Compensate what the run changed, keep the results, end CANCELLED (CANCEL_PATCH)
      currentPhase = 'ROLLBACK';
      progress.phase = currentPhase;
      try {
        await rollBackSuccesses(results, tenantId);
      } catch (rollbackError: unknown) {
        const message =
          rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        errors.push(`Rollback failed: ${message}`);
      }
      await markRemovedAccounts(request, results, tenantId);
      currentPhase = 'CANCELLED';
      progress.phase = currentPhase;
      return buildBulkResult(request, results, startTime, workflowNow(), errors, 'CANCELLED');
    }
    if (failedFast && isPatched(FAIL_FAST_ROLLBACK_PATCH)) {
      currentPhase = 'ROLLBACK';
      progress.phase = currentPhase;
      try {
        await rollBackSuccesses(results, tenantId);
      } catch (rollbackError: unknown) {
        const message =
          rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        errors.push(`Rollback failed: ${message}`);
      }
    }
    await markRemovedAccounts(request, results, tenantId);
    currentPhase = 'FAILED';
    progress.phase = currentPhase;

    // Return partial results with error
    return buildBulkResult(request, results, startTime, workflowNow(), errors);
  }
}

/**
 * Before the next batch or delete of a cancelled run (CANCEL_PATCH): the phase's results so far
 * join the run's, which the caller compensates and reports.
 */
function stopIfCancelled(
  isCancelled: () => boolean,
  allResults: OperationResult[],
  results: OperationResult[],
): void {
  if (!isCancelled() || !isPatched(CANCEL_PATCH)) return;
  allResults.push(...results);
  throw ApplicationFailure.nonRetryable(CANCELLED_BY_USER, WORKFLOW_CANCELLED);
}

/**
 * Execute operations in parallel batches
 */
async function executeBatch(
  operations: BulkOperation[],
  batchSize: number,
  operationType: string,
  dryRun: boolean,
  continueOnError: boolean,
  progress: WorkflowProgress,
  allResults: OperationResult[],
  tenantId: string,
  batchDelayMs: number,
  isCancelled: () => boolean,
): Promise<OperationResult[]> {
  const results: OperationResult[] = [];

  if (dryRun) {
    log.info(`[BulkWorkflow] DRY RUN`, { count: operations.length, operationType });
    return dryRunResults(operations, workflowNow());
  }

  // Process in batches
  for (let i = 0; i < operations.length; i += batchSize) {
    stopIfCancelled(isCancelled, allResults, results);
    const batchEnd = i + batchSize < operations.length ? i + batchSize : operations.length;
    const batch = operations.slice(i, batchEnd);

    log.info(`[BulkWorkflow] Executing batch`, {
      operationType,
      batchNumber: ((i / batchSize) | 0) + 1,
      batchSize: batch.length,
    });

    // Execute batch in parallel
    const batchPromises = batch.map((op) => runOperation(op, tenantId));
    const batchResults = await Promise.all(batchPromises);

    results.push(...batchResults);

    // Update progress
    progress.currentOperation += batch.length;
    progress.percentComplete =
      ((progress.currentOperation / progress.totalOperations) * 100 + 0.5) | 0;

    // Check for failures
    const failures = batchResults.filter((r) => !r.success);
    if (failures.length > 0 && !continueOnError) {
      if (isPatched(FAIL_FAST_ROLLBACK_PATCH)) {
        allResults.push(...results); // failed batch included: rolled back and reported by the caller
      }
      throw ApplicationFailure.nonRetryable(
        `Batch execution failed: ${failures.length} operations failed. Stopping execution.`,
        BATCH_EXECUTION_FAILED,
      );
    }

    // Small delay between batches to avoid overwhelming systems
    await sleep(`${batchDelayMs} ms`);
  }

  return results;
}

/**
 * Execute operations sequentially (for deletes)
 */
async function executeSequential(
  operations: BulkOperation[],
  operationType: string,
  dryRun: boolean,
  continueOnError: boolean,
  progress: WorkflowProgress,
  allResults: OperationResult[],
  tenantId: string,
  deleteSequentialDelayMs: number,
  isCancelled: () => boolean,
): Promise<OperationResult[]> {
  const results: OperationResult[] = [];

  if (dryRun) {
    log.info(`[BulkWorkflow] DRY RUN`, { count: operations.length, operationType });
    return dryRunResults(operations, workflowNow());
  }

  // Execute sequentially for safety
  for (let i = 0; i < operations.length; i++) {
    stopIfCancelled(isCancelled, allResults, results);
    const op = operations[i];

    const u = op.user as { email?: string };
    log.info(`[BulkWorkflow] Executing sequential`, {
      operationType,
      current: i + 1,
      total: operations.length,
      email: u.email,
    });

    const result = await runOperation(op, tenantId);
    results.push(result);

    // Update progress
    progress.currentOperation++;
    progress.percentComplete =
      ((progress.currentOperation / progress.totalOperations) * 100 + 0.5) | 0;

    // Deletes cannot be undone: fail fast before the next one rather than after all of them
    if (!result.success && !continueOnError && isPatched(FAIL_FAST_ROLLBACK_PATCH)) {
      allResults.push(...results);
      throw ApplicationFailure.nonRetryable(
        `${operationType} ${op.id} failed. Stopping execution before the remaining ${operationType}s.`,
        BATCH_EXECUTION_FAILED,
      );
    }

    // Delay between deletes for safety
    await sleep(`${deleteSequentialDelayMs} ms`);
  }

  return results;
}
