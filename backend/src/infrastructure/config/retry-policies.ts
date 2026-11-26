/**
 * Centralized Temporal retry policies for workflow activities.
 *
 * Workflow-safe: plain constants only. No process.env — Temporal workflows must be deterministic.
 * Import from: backend/src/infrastructure/config/retry-policies.ts
 */

import type { RetryPolicy } from '@temporalio/common';

/**
 * Connector provisioning/deprovisioning: allow more retries for transient failures
 * (network timeouts, API rate limits, temporary unavailability).
 * 5 attempts with exponential backoff: 1s, 2s, 4s, 8s, 16s.
 */
export const CONNECTOR_RETRY: RetryPolicy = {
  initialInterval: '1s',
  maximumAttempts: 5,
  backoffCoefficient: 2,
};

/**
 * Health checks: fail fast if system is unreachable.
 * 3 attempts with default 1s interval — total wait ~3s before declaring unhealthy.
 */
export const HEALTH_CHECK_RETRY: RetryPolicy = {
  maximumAttempts: 3,
};

/**
 * Lightweight queries (config, pipeline status): few retries, fail loudly.
 * Used for internal service calls that should succeed immediately.
 */
export const QUERY_RETRY: RetryPolicy = {
  maximumAttempts: 2,
};

/**
 * Bulk provisioning and distributed transactions: moderate retries for batch ops.
 * 3 attempts with exponential backoff for prepare/commit/rollback phases.
 */
export const BATCH_OPERATION_RETRY: RetryPolicy = {
  initialInterval: '1s',
  maximumAttempts: 3,
  backoffCoefficient: 2,
};

/**
 * Reconciliation (drift detection): fail loudly; parent workflow retries batches.
 * 2 attempts with Temporal default 1s interval — child batches fail fast so parent can retry.
 */
export const RECONCILIATION_RETRY: RetryPolicy = {
  maximumAttempts: 2,
};

/**
 * Access review campaign operations: moderate retries for campaign lifecycle.
 * 3 attempts with Temporal default 1s interval.
 */
export const ACCESS_REVIEW_RETRY: RetryPolicy = {
  maximumAttempts: 3,
};

/**
 * Archival (storage export): longer interval for I/O-bound operations.
 * 3 attempts with 5s interval — storage APIs may be slow to recover.
 */
export const ARCHIVAL_RETRY: RetryPolicy = {
  initialInterval: '5s',
  maximumAttempts: 3,
};

/**
 * Scheduled connector sync: slow recovery for external system sync.
 * 2 attempts with 30s interval — sync jobs can take minutes to stabilize.
 */
export const SCHEDULED_SYNC_RETRY: RetryPolicy = {
  initialInterval: '30s',
  maximumAttempts: 2,
};

/**
 * Long batch activities that heartbeat their progress (risk scores per tenant, orphan
 * detection): a timed-out or crashed attempt is retried, and the risk score activity resumes
 * from its last heartbeat. 5 attempts, 30s then doubling up to 10 minutes.
 */
export const HEARTBEAT_BATCH_RETRY: RetryPolicy = {
  initialInterval: '30s',
  backoffCoefficient: 2,
  maximumInterval: '10 minutes',
  maximumAttempts: 5,
};
