/**
 * Credential Rotation Workflow
 *
 * Nightly CronWorkflow over credential_inventory (Temporal Schedule, default 3 AM daily,
 * CREDENTIAL_ROTATION_CRON). The schedule names no tenant: the run covers every active tenant.
 *
 * Per tenant (patch credential-rotation:per-tenant): listCredentialRotationTenants lists the
 * active tenants, then runCredentialRotationBatch (credential-rotation.activities.ts) runs once per
 * tenant, each call with its own timeout and retries, so a slow or failing tenant does not stop
 * the others. A tenant whose call still fails is logged and the run goes on; at the end the run
 * fails, naming those tenants and why, so the schedule shows it. Before the patch one call ran
 * every tenant under one 30-minute timeout. Each call, for its tenant:
 * 1. Reads each SYNCED Entra ID and AD account's credential state and writes its inventory row,
 *    the status from the applicable credential policy (CredentialInventoryRefresh)
 * 2. Moves rows not read this run whose due date has passed to EXPIRED
 * 3. Emits CREDENTIAL_EXPIRING_SOON for due credentials (daysRemaining <= 0, with the reason they
 *    were not reset) and for those within their policy's warning window
 *
 * No password is reset: EuroID has no secret storage to hand a generated password to, and a
 * person's password is never reset automatically. The name stays for the schedule and histories.
 */

import { ActivityFailure, ApplicationFailure, proxyActivities, log } from '@temporalio/workflow';
import { SCHEDULED_SYNC_RETRY } from '../infrastructure/config/retry-policies';
import { workflowNow } from './workflow-time';
import { isPatched } from './workflow-versioning';

export interface CredentialRotationInput {
  tenantId?: string;
  batchSize?: number;
}

export interface CredentialRotationResult {
  /** Always 0: nothing is reset (kept for results recorded before). */
  rotated: number;
  /** Always 0: no reset is attempted (kept for results recorded before). */
  failed: number;
  /** Credentials expiring soon that were reported. */
  notified: number;
  statusesUpdated: number;
  /** Accounts read from Entra ID and AD (absent in results recorded before the inventory feed). */
  observed?: number;
  /** Of those, rows written UNKNOWN with the reason. */
  unknown?: number;
  /** Rows deleted because the identity no longer has the account. */
  removed?: number;
  /** Due credentials reported and not reset. */
  overdue?: number;
}

const DEFAULT_BATCH_SIZE = 50;
const PER_TENANT_PATCH = 'credential-rotation:per-tenant';
/** The run's failure when some tenants' calls failed (not retryable: the others already ran). */
export const ROTATION_TENANTS_FAILED = 'CredentialRotationTenantsFailed';

const { runCredentialRotationBatch } = proxyActivities<{
  runCredentialRotationBatch: (
    tenantId: string,
    nowIso: string,
    batchSize: number,
  ) => Promise<CredentialRotationResult>;
}>({
  startToCloseTimeout: '30 minutes',
  retry: SCHEDULED_SYNC_RETRY,
});

const { listCredentialRotationTenants } = proxyActivities<{
  listCredentialRotationTenants: () => Promise<string[]>;
}>({
  startToCloseTimeout: '2 minutes',
  retry: SCHEDULED_SYNC_RETRY,
});

export async function credentialRotationWorkflow(
  input?: CredentialRotationInput,
): Promise<CredentialRotationResult> {
  const tenantId = input?.tenantId ?? '';
  const batchSize = input?.batchSize ?? DEFAULT_BATCH_SIZE;
  const nowIso = workflowNow().toISOString();

  log.info('[CredentialRotation] Starting', { tenantId: tenantId || 'all', batchSize });

  const result = isPatched(PER_TENANT_PATCH)
    ? await runPerTenant(tenantId, nowIso, batchSize)
    : await runCredentialRotationBatch(tenantId, nowIso, batchSize);

  log.info('[CredentialRotation] Complete', {
    rotated: result.rotated,
    failed: result.failed,
    notified: result.notified,
    statusesUpdated: result.statusesUpdated,
  });

  return result;
}

/** One call per tenant (the named one, else every active one); the counts added up. */
async function runPerTenant(
  tenantId: string,
  nowIso: string,
  batchSize: number,
): Promise<CredentialRotationResult> {
  const tenantIds = tenantId ? [tenantId] : await listCredentialRotationTenants();
  const total: Required<CredentialRotationResult> = {
    rotated: 0,
    failed: 0,
    notified: 0,
    statusesUpdated: 0,
    observed: 0,
    unknown: 0,
    removed: 0,
    overdue: 0,
  };
  const failures: string[] = [];
  for (const tid of tenantIds) {
    try {
      const result = await runCredentialRotationBatch(tid, nowIso, batchSize);
      for (const field of Object.keys(total) as Array<keyof typeof total>) {
        total[field] += result[field] ?? 0;
      }
    } catch (err: unknown) {
      const reason = failureReason(err);
      log.warn('[CredentialRotation] Tenant failed, going on with the others', {
        tenantId: tid,
        reason,
      });
      failures.push(`${tid} (${reason})`);
    }
  }
  if (failures.length) {
    throw ApplicationFailure.nonRetryable(
      `The credential run failed for ${failures.length} of ${tenantIds.length} tenant(s): ` +
        failures.join('; '),
      ROTATION_TENANTS_FAILED,
    );
  }
  return total;
}

/** The activity's own error (or timeout) behind Temporal's "Activity task failed". */
function failureReason(err: unknown): string {
  const cause = err instanceof ActivityFailure && err.cause ? err.cause : err;
  return cause instanceof Error ? cause.message : String(cause);
}
