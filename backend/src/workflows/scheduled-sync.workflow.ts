/**
 * Scheduled Sync Workflow
 *
 * Runs a single connector sync (ingest or discover) for a tenant.
 * Dispatched by SyncSchedulerService Cron — decouples scheduling from execution.
 * One slow connector no longer blocks others; Temporal handles concurrency and retries.
 */

import { proxyActivities, log } from '@temporalio/workflow';
import { SCHEDULED_SYNC_RETRY } from '../infrastructure/config/retry-policies';

export interface ScheduledSyncInput {
  tenantId: string;
  connectorName: string;
  correlationId?: string;
}

export interface ScheduledSyncResult {
  success: boolean;
  connectorName: string;
  tenantId: string;
  type: 'ingest' | 'discover';
  count?: number;
  error?: string;
}

const scheduledSyncActivities = proxyActivities<{
  runScheduledSync: (input: ScheduledSyncInput) => Promise<ScheduledSyncResult>;
}>({
  startToCloseTimeout: '30 minutes',
  retry: SCHEDULED_SYNC_RETRY,
});

/**
 * Execute a scheduled sync for one connector in one tenant.
 */
export async function scheduledSyncWorkflow(
  input: ScheduledSyncInput,
): Promise<ScheduledSyncResult> {
  log.info('[ScheduledSync] Starting', {
    tenantId: input.tenantId,
    connectorName: input.connectorName,
  });

  const result = await scheduledSyncActivities.runScheduledSync(input);

  log.info('[ScheduledSync] Complete', {
    connectorName: input.connectorName,
    success: result.success,
    count: result.count,
  });

  return result;
}
