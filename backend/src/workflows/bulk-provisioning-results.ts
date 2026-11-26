/**
 * Pure result builders for bulkProvisioningWorkflow: dry-run results and the final
 * BulkOperationResult (summary, breakdown, metrics). No Temporal APIs, no I/O, no clock:
 * the workflow passes in the timestamps, so these stay deterministic inside the workflow.
 */
import type {
  BulkOperation,
  BulkOperationRequest,
  BulkOperationResult,
  OperationResult,
} from './workflow-types';

/** Successful results that execute nothing, one per operation (dry run). */
export function dryRunResults(operations: BulkOperation[], now: Date): OperationResult[] {
  return operations.map((op) => {
    const u = op.user as { sourceUserId?: string; email?: string };
    return {
      operationId: op.id,
      success: true,
      type: op.type,
      userId: u.sourceUserId || u.email || '',
      email: u.email || '',
      systemResults: [],
      startedAt: now,
      completedAt: now,
      durationMs: 0,
    };
  });
}

/** Sum of per-operation rate-limit hits (rate limiter throttles). */
export function countRateLimitHits(results: OperationResult[]): number {
  return results.reduce((sum, r) => sum + (r.rateLimitHits ?? 0), 0);
}

function breakdownFor(
  type: string,
  operations: BulkOperation[],
  results: OperationResult[],
): { total: number; successful: number; failed: number } {
  return {
    total: operations.filter((op) => op.type === type).length,
    successful: results.filter((r) => r.type === type && r.success).length,
    failed: results.filter((r) => r.type === type && !r.success).length,
  };
}

/**
 * Build the workflow result from the operation results so far. With `errors` the batch
 * ended early: status is FAILED (CANCELLED when `endedAs` says so) and `summary.total` counts
 * every requested operation.
 */
export function buildBulkResult(
  request: BulkOperationRequest,
  results: OperationResult[],
  startedAt: Date,
  completedAt: Date,
  errors?: string[],
  endedAs?: 'CANCELLED',
): BulkOperationResult {
  const successful = results.filter((r) => r.success && !r.rolledBack).length;
  const failed = results.filter((r) => !r.success).length;
  const status = endedAs
    ? endedAs
    : errors
      ? 'FAILED'
      : failed === 0
        ? 'COMPLETED'
        : successful > 0
          ? 'PARTIAL_SUCCESS'
          : 'FAILED';

  return {
    batchId: request.batchId,
    status,
    dryRun: request.dryRun || false,
    summary: {
      total: errors ? request.operations.length : results.length,
      successful,
      failed,
      rolledBack: results.filter((r) => r.rolledBack).length,
      skipped: results.filter((r) => r.systemResults.some((sr) => sr.skipped)).length,
    },
    breakdown: {
      creates: breakdownFor('CREATE', request.operations, results),
      updates: breakdownFor('UPDATE', request.operations, results),
      deletes: breakdownFor('DELETE', request.operations, results),
      disables: breakdownFor('DISABLE', request.operations, results),
    },
    results,
    metrics: {
      totalDurationMs: completedAt.getTime() - startedAt.getTime(),
      averageOperationMs:
        results.length > 0 ? results.reduce((sum, r) => sum + r.durationMs, 0) / results.length : 0,
      apiCallsTotal: results.reduce(
        (sum, r) => sum + r.systemResults.reduce((s, sr) => s + sr.apiCallsUsed, 0),
        0,
      ),
      rateLimitHits: countRateLimitHits(results),
    },
    startedAt,
    completedAt,
    ...(errors ? { errors } : {}),
  };
}
