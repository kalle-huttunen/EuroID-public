/**
 * Entitlement Expiry Workflow
 *
 * Runs hourly via Temporal Schedule. Finds identities with expired provisioning
 * entries (expiresAt <= now) and deprovisions them. Also emits notification
 * events for entitlements expiring in 7 days and 1 day.
 *
 * Batches run until one neither deprovisions nor fails anything (patch
 * entitlement-expiry:continue-past-failures; before it, until one deprovisions
 * nothing, so a batch of entries that all failed ended the run). Every entry a
 * batch attempts is deprovisioned or gets its failure recorded, which keeps it
 * out of the rest of the run (same nowIso), so the batches run out.
 *
 * Pure workflow: uses Temporal-patched Date for deterministic time.
 */

import { proxyActivities, log } from '@temporalio/workflow';
import { SCHEDULED_SYNC_RETRY } from '../infrastructure/config/retry-policies';
import { workflowNow } from './workflow-time';
import { isPatched } from './workflow-versioning';

export interface EntitlementExpiryInput {
  tenantId?: string;
  batchSize?: number;
}

export interface EntitlementExpiryResult {
  processed: number;
  /** Expired entries whose deprovision failed (recorded on the entry, retried or skipped later). */
  failed: number;
  expiringSoonCount: number;
  expiringTomorrowCount: number;
}

/** One runEntitlementExpiryCheck result; histories from before the patch carry no `failed`. */
type ExpiryBatch = Omit<EntitlementExpiryResult, 'failed'> & { failed?: number };

const DEFAULT_BATCH_SIZE = 50;
const CONTINUE_PAST_FAILURES_PATCH = 'entitlement-expiry:continue-past-failures';

const { runEntitlementExpiryCheck } = proxyActivities<{
  runEntitlementExpiryCheck: (
    tenantId: string,
    nowIso: string,
    limit: number,
  ) => Promise<ExpiryBatch>;
}>({
  startToCloseTimeout: '10 minutes',
  retry: SCHEDULED_SYNC_RETRY,
});

export async function entitlementExpiryWorkflow(
  input?: EntitlementExpiryInput,
): Promise<EntitlementExpiryResult> {
  const tenantId = input?.tenantId ?? '';
  const batchSize = input?.batchSize ?? DEFAULT_BATCH_SIZE;
  const nowIso = workflowNow().toISOString();
  log.info('[EntitlementExpiry] Starting', { tenantId: tenantId || 'all' });

  let totalProcessed = 0;
  let totalFailed = 0;
  let totalExpiringSoon = 0;
  let totalExpiringTomorrow = 0;

  let batch: ExpiryBatch;
  do {
    batch = await runEntitlementExpiryCheck(tenantId, nowIso, batchSize);
    totalProcessed += batch.processed;
    totalFailed += batch.failed ?? 0;
    totalExpiringSoon += batch.expiringSoonCount;
    totalExpiringTomorrow += batch.expiringTomorrowCount;
  } while (
    batch.processed > 0 ||
    ((batch.failed ?? 0) > 0 && isPatched(CONTINUE_PAST_FAILURES_PATCH))
  );

  log.info('[EntitlementExpiry] Complete', {
    totalProcessed,
    totalFailed,
    totalExpiringSoon,
    totalExpiringTomorrow,
  });
  return {
    processed: totalProcessed,
    failed: totalFailed,
    expiringSoonCount: totalExpiringSoon,
    expiringTomorrowCount: totalExpiringTomorrow,
  };
}
