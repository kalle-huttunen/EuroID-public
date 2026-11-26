/**
 * Reconciliation Batch Workflow (Child)
 *
 * Processes a single batch of users for scatter-gather reconciliation.
 * Each batch is independently retryable by Temporal.
 */

import { proxyActivities, sleep, log } from '@temporalio/workflow';
import type { ReconciliationActivities } from '../activities/reconciliation.activities';
import {
  DriftType,
  type ReconciliationConfig,
  type ReconciliationBatchResult,
  type SystemDrift,
} from './workflow-types';
import { RECONCILIATION_RETRY } from '../infrastructure/config/retry-policies';
import { isPatched } from './workflow-versioning';
import type { ReconciliationScope } from '../shared/utils/reconciliation-scope';
/** Default page size — override via ReconcileBatchInput.pageSize (set from env-backed defaults by the scheduler). */
const DEFAULT_PAGE_SIZE = 5000;

/**
 * config.requireApprovalForDeletes: a correction that cannot be undone or takes granted access
 * away is not auto-corrected; the drift stays open for the Correct action
 * (POST /reconciliation/drifts/:id/correct). Histories from before this patch auto-corrected
 * those too.
 */
const APPROVAL_FOR_DELETES_PATCH = 'reconcile-batch:approval-for-deletes';

/**
 * Whether the correction of `drift` (ReconciliationActivities.correctDrift) waits for a person
 * under requireApprovalForDeletes. GROUP_MISMATCH and LICENSE_MISMATCH have no correction yet,
 * and theirs would remove a membership or a license the hub does not hold: held. A disable is
 * the reversible containment step and never waits (a leaver's account still enabled in a target
 * is disabled at once, STATUS_CONTAINMENT_PATCH): ORPHANED_USER, and STATUS_MISMATCH. MISSING_USER
 * creates the account and FIELD_MISMATCH rewrites attributes. The orphan cleanup's delete after
 * the extended grace is held in orphanCleanupWorkflow.
 */
function waitsForApproval(drift: SystemDrift): boolean {
  return (
    drift.driftType === DriftType.GROUP_MISMATCH || drift.driftType === DriftType.LICENSE_MISMATCH
  );
}

/**
 * A STATUS_MISMATCH whose hub status expects the account disabled (a leaver's account still
 * enabled; ReconciliationActivities.detectUserDrift) is containment: CRITICAL for the report, and
 * corrected when the run's autoCorrectTypes include STATUS_MISMATCH, although the batch corrects
 * no other CRITICAL drift. Enabling grants access and is never corrected here. Histories from
 * before this patch corrected no CRITICAL drift.
 */
const STATUS_CONTAINMENT_PATCH = 'reconcile-batch:status-containment';

/** A STATUS_MISMATCH whose correction disables the account (the hub expects it disabled). */
function isContainment(drift: SystemDrift): boolean {
  return drift.driftType === DriftType.STATUS_MISMATCH && drift.expectedValue === 'DISABLED';
}

/**
 * input.scope (the parent's, patch reconciliation:scan-scope): every page is fetched within it,
 * the scope the parent counted with, so the batch's skip/limit range is over the same
 * identities. Histories from before this patch had no scope and fetched every identity.
 */
const SCAN_SCOPE_PATCH = 'reconcile-batch:scan-scope';

const reconActivities = proxyActivities<ReconciliationActivities>({
  startToCloseTimeout: '5 minutes',
  retry: RECONCILIATION_RETRY,
});

export interface ReconcileBatchInput {
  config: ReconciliationConfig;
  skip: number;
  limit: number;
  batchIndex: number;
  /** Page size for fetching hub users. Passed by scheduler from env-backed defaults. */
  pageSize?: number;
  /** The run's scan scope (includedDepartments, excludedUsers); absent: every identity. */
  scope?: ReconciliationScope;
}

/**
 * Process a single batch of users: fetch, detect drift, optionally auto-correct.
 */
export async function reconcileBatchWorkflow(
  input: ReconcileBatchInput,
): Promise<ReconciliationBatchResult> {
  const { config, skip, limit, batchIndex, pageSize = DEFAULT_PAGE_SIZE } = input;
  const tenantId = config.tenantId ?? '';

  const drifts: ReconciliationBatchResult['drifts'] = [];
  const corrections: ReconciliationBatchResult['corrections'] = [];
  const errors: string[] = [];
  let usersScanned = 0;
  let heldForApproval = 0;

  log.info('[ReconcileBatch] Starting batch', { batchIndex, skip, limit });

  let currentSkip = skip;
  let remaining = limit;
  const scope = input.scope && isPatched(SCAN_SCOPE_PATCH) ? input.scope : undefined;

  while (remaining > 0) {
    const fetchSize = pageSize <= remaining ? pageSize : remaining;
    const page = scope
      ? await reconActivities.fetchHubUsersPage(tenantId, String(currentSkip), fetchSize, scope)
      : await reconActivities.fetchHubUsersPage(tenantId, String(currentSkip), fetchSize);

    for (let i = 0; i < page.users.length; i++) {
      const user = page.users[i];
      // Log lines (worker output) and the result (history) name the identity, never its address
      const identityId = String(user._id);
      try {
        const driftResult = await reconActivities.detectUserDrift(
          user,
          config.targetSystems,
          tenantId,
        );

        if (driftResult.hasDrift) {
          drifts.push(driftResult);
        }

        usersScanned += 1;

        // A system it could not read (e.g. an incomplete connector config): once per batch
        for (const failure of driftResult.systemErrors ?? []) {
          const line = `${failure.system}: ${failure.error}`;
          if (!errors.includes(line)) errors.push(line);
        }

        if (config.autoCorrect && driftResult.hasDrift) {
          for (const drift of driftResult.drifts) {
            if (
              config.autoCorrectTypes.includes(drift.driftType) &&
              drift.autoCorrect &&
              (drift.severity !== 'CRITICAL' ||
                (isContainment(drift) && isPatched(STATUS_CONTAINMENT_PATCH)))
            ) {
              // A membership or license removal waits for a person: its drift stays open
              if (
                config.requireApprovalForDeletes &&
                waitsForApproval(drift) &&
                isPatched(APPROVAL_FOR_DELETES_PATCH)
              ) {
                heldForApproval += 1;
                continue;
              }
              try {
                const correction = await reconActivities.correctDrift(
                  drift,
                  driftResult.hubState,
                  tenantId,
                );
                corrections.push(correction);
                await sleep('1 second');
              } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                log.error('[ReconcileBatch] Auto-correction failed', {
                  identityId,
                  error: message,
                });
                errors.push(`identity ${identityId}: ${message}`);
              }
            }
          }
        }

        if (i % 5 === 0) {
          await sleep('500 ms');
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        log.error('[ReconcileBatch] Failed to detect drift', {
          identityId,
          error: message,
        });
        errors.push(`identity ${identityId}: ${message}`);
      }
    }

    currentSkip += page.users.length;
    remaining -= page.users.length;

    if (page.nextPageToken === null || remaining <= 0) {
      break;
    }
  }

  log.info('[ReconcileBatch] Batch complete', {
    batchIndex,
    usersScanned,
    driftsFound: drifts.length,
    correctionsApplied: corrections.filter((c) => c.success).length,
    heldForApproval,
  });

  return {
    drifts,
    corrections,
    usersScanned,
    errors: errors.length > 0 ? errors : undefined,
  };
}
