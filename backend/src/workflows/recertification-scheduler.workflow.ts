/**
 * Recertification Scheduler Workflow
 *
 * Runs daily via Temporal Schedule. Finds completed campaigns with recurrence
 * enabled and nextRunAt due, clones them, activates the new campaign, and
 * hands the recurrence to it (recertification.activities.ts). Pure workflow: uses
 * Temporal-patched Date for deterministic time.
 */

import { proxyActivities, log } from '@temporalio/workflow';
import { SCHEDULED_SYNC_RETRY } from '../infrastructure/config/retry-policies';
import { workflowNow } from './workflow-time';

export interface RecertificationSchedulerInput {
  tenantId?: string;
}

export interface RecertificationSchedulerResult {
  campaignsCreated: number;
  errors: number;
}

const { runRecertificationScheduler } = proxyActivities<{
  runRecertificationScheduler: (
    tenantId: string,
    nowIso: string,
  ) => Promise<RecertificationSchedulerResult>;
}>({
  startToCloseTimeout: '10 minutes',
  retry: SCHEDULED_SYNC_RETRY,
});

export async function recertificationSchedulerWorkflow(
  input?: RecertificationSchedulerInput,
): Promise<RecertificationSchedulerResult> {
  const tenantId = input?.tenantId ?? '';
  const nowIso = workflowNow().toISOString();
  log.info('[Recertification] Starting', { tenantId: tenantId || 'all' });

  const result = await runRecertificationScheduler(tenantId, nowIso);

  log.info('[Recertification] Complete', {
    campaignsCreated: result.campaignsCreated,
    errors: result.errors,
  });

  return result;
}
