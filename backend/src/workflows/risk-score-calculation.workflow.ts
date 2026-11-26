/**
 * Risk Score Calculation Workflow
 *
 * Runs nightly via Temporal Schedule. Computes composite risk scores for all
 * active identities. Pure workflow: uses Temporal-patched Date for deterministic time.
 *
 * Per tenant (PER_TENANT_PATCH): the tenants are listed once, and each is scored in its own
 * activity that heartbeats its offset and resumes from it when retried, so a long tenant keeps
 * its progress and a failing one does not stop the others. After TENANTS_PER_RUN tenants the run
 * continues as new with the rest, the same run time and the counts so far.
 */

import { proxyActivities, log, continueAsNew } from '@temporalio/workflow';
import {
  HEARTBEAT_BATCH_RETRY,
  QUERY_RETRY,
  SCHEDULED_SYNC_RETRY,
} from '../infrastructure/config/retry-policies';
import { workflowNow } from './workflow-time';
import { isPatched } from './workflow-versioning';

export interface RiskScoreCalculationInput {
  tenantId?: string;
  batchSize?: number;
  /** Continue-as-new (per tenant): the tenants still to score. */
  remainingTenants?: string[];
  /** Continue-as-new: the run time every tenant is scored at. */
  nowIso?: string;
  /** Continue-as-new: the counts of the runs before. */
  carried?: RiskScoreCalculationResult;
}

export interface RiskScoreCalculationResult {
  processed: number;
  errors: number;
}

const DEFAULT_BATCH_SIZE = 100;

/** Tenants one run scores before it continues as new (each adds a handful of history events). */
export const TENANTS_PER_RUN = 50;

/**
 * Each tenant in its own heartbeating activity (runRiskScoreTenant) instead of one 30-minute
 * activity for every tenant (runRiskScoreBatch), which kept nothing when it timed out. Histories
 * from before this patch ran runRiskScoreBatch.
 */
const PER_TENANT_PATCH = 'risk-score-calculation:per-tenant';

const { runRiskScoreBatch } = proxyActivities<{
  runRiskScoreBatch: (
    tenantId: string,
    nowIso: string,
    batchSize?: number,
  ) => Promise<{ processed: number; errors: number }>;
}>({
  startToCloseTimeout: '30 minutes',
  retry: SCHEDULED_SYNC_RETRY,
});

const { listRiskScoreTenants } = proxyActivities<{
  listRiskScoreTenants: (tenantId: string) => Promise<string[]>;
}>({
  startToCloseTimeout: '1 minute',
  retry: QUERY_RETRY,
});

/** An attempt may run for 2 hours while it heartbeats; a retry resumes from its last offset. */
const { runRiskScoreTenant } = proxyActivities<{
  runRiskScoreTenant: (
    tenantId: string,
    nowIso: string,
    batchSize: number,
  ) => Promise<RiskScoreCalculationResult>;
}>({
  startToCloseTimeout: '2 hours',
  heartbeatTimeout: '5 minutes',
  retry: HEARTBEAT_BATCH_RETRY,
});

export async function riskScoreCalculationWorkflow(
  input?: RiskScoreCalculationInput,
): Promise<RiskScoreCalculationResult> {
  const tenantId = input?.tenantId ?? '';
  const batchSize = input?.batchSize ?? DEFAULT_BATCH_SIZE;
  const nowIso = input?.nowIso ?? workflowNow().toISOString();
  log.info('[RiskScore] Starting', { tenantId: tenantId || 'all' });

  const result = isPatched(PER_TENANT_PATCH)
    ? await scoreEachTenant(input, tenantId, batchSize, nowIso)
    : await runRiskScoreBatch(tenantId, nowIso, batchSize);

  log.info('[RiskScore] Complete', {
    processed: result.processed,
    errors: result.errors,
  });

  return {
    processed: result.processed,
    errors: result.errors,
  };
}

/** PER_TENANT_PATCH: one activity per tenant; a tenant that fails for good counts as one error. */
async function scoreEachTenant(
  input: RiskScoreCalculationInput | undefined,
  tenantId: string,
  batchSize: number,
  nowIso: string,
): Promise<RiskScoreCalculationResult> {
  const tenants = input?.remainingTenants ?? (await listRiskScoreTenants(tenantId));
  let processed = input?.carried?.processed ?? 0;
  let errors = input?.carried?.errors ?? 0;

  for (let i = 0; i < tenants.length; i++) {
    if (i === TENANTS_PER_RUN) {
      await continueAsNew<typeof riskScoreCalculationWorkflow>({
        ...(tenantId ? { tenantId } : {}),
        batchSize,
        remainingTenants: tenants.slice(i),
        nowIso,
        carried: { processed, errors },
      });
    }
    try {
      const result = await runRiskScoreTenant(tenants[i], nowIso, batchSize);
      processed += result.processed;
      errors += result.errors;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('[RiskScore] Tenant failed', { tenantId: tenants[i], error: message });
      errors += 1;
    }
  }
  return { processed, errors };
}
