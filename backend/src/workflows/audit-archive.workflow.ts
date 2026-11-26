/**
 * Audit Archive Workflow
 *
 * Daily CronWorkflow that exports unarchived Merkle checkpoints to S3
 * with Object Lock for WORM compliance. Runs at 3 AM by default.
 * A checkpoint that cannot be exported fails the run after the others (patch
 * audit-archive:fail-on-export-errors).
 * Pure workflow: no side effects.
 */

import { ApplicationFailure, proxyActivities, log } from '@temporalio/workflow';
import { ARCHIVAL_RETRY } from '../infrastructure/config/retry-policies';
import { isPatched } from './workflow-versioning';

/**
 * A checkpoint whose export still fails after the activity's retries no longer leaves a completed
 * run: the other checkpoints are exported, then the run fails (AUDIT_ARCHIVE_EXPORT_FAILED, not
 * retried; the next scheduled run exports what is still unarchived), so the schedule shows the
 * failure. Histories from before this patch completed with `errors` in the result only.
 */
const FAIL_ON_EXPORT_ERRORS_PATCH = 'audit-archive:fail-on-export-errors';

/** Failure type of a run in which a checkpoint was not exported. */
export const AUDIT_ARCHIVE_EXPORT_FAILED = 'AuditArchiveExportFailed';

export interface AuditArchiveInput {
  tenantId?: string;
}

export interface AuditArchiveResult {
  checkpointsExported: number;
  eventsExported: number;
  errors: number;
}

const { getUnarchivedCheckpoints, exportCheckpoint } = proxyActivities<{
  getUnarchivedCheckpoints: (
    tenantId: string,
  ) => Promise<Array<{ _id: string; checkpointId: string; tenantId: string }>>;
  exportCheckpoint: (
    tenantId: string,
    merkleRootId: string,
  ) => Promise<{ storagePath: string; eventCount: number }>;
}>({
  startToCloseTimeout: '30 minutes',
  retry: ARCHIVAL_RETRY,
});

export async function auditArchiveWorkflow(input?: AuditArchiveInput): Promise<AuditArchiveResult> {
  const tenantId = input?.tenantId ?? '';
  log.info('[AuditArchive] Starting archive workflow', { tenantId: tenantId || 'all' });

  const checkpoints = await getUnarchivedCheckpoints(tenantId);
  log.info('[AuditArchive] Found unarchived checkpoints', { count: checkpoints.length });

  let checkpointsExported = 0;
  let eventsExported = 0;
  let errors = 0;
  const failed: string[] = [];

  for (const cp of checkpoints) {
    try {
      const result = await exportCheckpoint(cp.tenantId, cp._id);
      checkpointsExported++;
      eventsExported += result.eventCount;
      log.info('[AuditArchive] Exported checkpoint', {
        checkpointId: cp.checkpointId,
        storagePath: result.storagePath,
      });
    } catch (err) {
      errors++;
      failed.push(cp.checkpointId);
      log.warn('[AuditArchive] Failed to export checkpoint', {
        checkpointId: cp.checkpointId,
        error: String(err),
      });
    }
  }

  log.info('[AuditArchive] Archive complete', {
    checkpointsExported,
    eventsExported,
    errors,
  });

  const result = { checkpointsExported, eventsExported, errors };
  if (errors > 0 && isPatched(FAIL_ON_EXPORT_ERRORS_PATCH)) {
    throw ApplicationFailure.nonRetryable(
      `${errors} of ${checkpoints.length} audit checkpoints were not exported to WORM storage ` +
        `(${failed.join(', ')}); the others were.`,
      AUDIT_ARCHIVE_EXPORT_FAILED,
      result,
    );
  }
  return result;
}
