/**
 * Reconciliation Workflow
 *
 * Detects and corrects drift between Identity Hub and target systems.
 * Runs daily (or on-demand) to ensure consistency.
 *
 * continueAsNew: Not used here. This is a one-shot scatter-gather that completes
 * in minutes. Child workflows process independent batches. Add continueAsNew
 * only if this becomes a recurring scheduled workflow with long-running loops.
 *
 * PROCESS (Scatter-Gather):
 * 1. Fetch total user count and batch config
 * 2. Split users into parallel batches
 * 3. Spawn child workflows per batch (scatter)
 * 4. Aggregate results from all children (gather)
 * 5. Generate report for manual review
 *
 * SAFETY:
 * - Only auto-corrects low-risk drifts
 * - High-risk drifts require manual approval
 * - Full audit trail of all corrections
 *
 * --- TASK_105 recap: continueAsNew not used — one-shot scatter-gather completes in minutes.
 */

import {
  proxyActivities,
  defineQuery,
  setHandler,
  log,
  ActivityFailure,
  ApplicationFailure,
  executeChild,
  startChild,
  ParentClosePolicy,
  workflowInfo,
  type ChildWorkflowOptions,
} from '@temporalio/workflow';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/common';
import type { ReconciliationActivities } from '../activities/reconciliation.activities';
import {
  ReconciliationReport,
  ReconciliationConfig,
  DriftDetectionResult,
  CorrectionAction,
  type ReconciliationAlert,
  type OrphanDetectionFailure,
} from './workflow-types';
import { driftThresholdAlerts } from './reconciliation-alerts';
import { reconcileBatchWorkflow } from './reconcile-batch.workflow';
import { orphanCleanupWorkflow, type OrphanCleanupInput } from './orphan-cleanup.workflow';
import { RECONCILIATION_RETRY } from '../infrastructure/config/retry-policies';
import { inheritTenantAttributes } from './child-workflow-tenant';
import { isPatched } from './workflow-versioning';
import { orphanCleanupWorkflowId } from './orphan-cleanup-id';
import type { ReconciliationScope } from '../shared/utils/reconciliation-scope';

/**
 * Batch and orphan-cleanup children carry this workflow's TenantId search attribute and memo,
 * so tenant-checked reads find them. Histories from before this patch started them without.
 */
const CHILD_TENANT_PATCH = 'reconciliation:child-tenant-attributes';

/**
 * An orphan cleanup is started and left running: it waits out grace periods of weeks, and its
 * workflow id goes on the drift at once, so ADOPT/DELETE can signal it. The id is the drift's own
 * (orphanCleanupWorkflowId), so a start for a drift whose cleanup already runs finds that one.
 * Histories from before this patch waited for each cleanup to end before recording its id and
 * starting the next one, under the id `<parent>-orphan-<driftId>-<index>`.
 */
const START_ORPHAN_CLEANUP_PATCH = 'reconciliation:start-orphan-cleanup';

/**
 * After the gather the run counts its drifts against maxDriftsBeforeAlert and
 * criticalDriftAlertThreshold (0 = off): each threshold reached goes into the report's `alerts`,
 * and with notifyOnDrift notifyDriftThresholdExceeded is called once (the event
 * reconciliation.drift_threshold_exceeded, and a mail to notifyEmail). Histories from before
 * this patch read neither threshold.
 */
const DRIFT_THRESHOLD_ALERTS_PATCH = 'reconciliation:drift-threshold-alerts';

/**
 * The run scans only the identities its config's includedDepartments and excludedUsers leave in
 * (shared/utils/reconciliation-scope.ts): the count, every batch (its page fetch) and orphan
 * detection get the same scope, so batches neither skip nor repeat an identity and no excluded
 * user's account is touched. Only a run whose config has a scope records the patch; histories
 * from before it scanned every identity, a scope in the config or not.
 */
const SCAN_SCOPE_PATCH = 'reconciliation:scan-scope';

/**
 * runOrphanDetection runs under its own proxy (orphanDetectionActivities: 2 hours per attempt, a
 * heartbeat timeout of 2 minutes; the activity heartbeats after each page of accounts) instead
 * of the 5-minute one, and a system whose detection (or cleanup start) fails is named with the
 * error in the report's orphanDetectionFailures. Histories from before this patch ran it under
 * the 5-minute proxy and only logged the failure.
 */
const ORPHAN_DETECTION_PATCH = 'reconciliation:orphan-detection-heartbeat';

/** The config's scan scope; undefined when it names none (every identity of the tenant). */
function scanScopeOf(config: ReconciliationConfig): ReconciliationScope | undefined {
  const scope: ReconciliationScope = {};
  if (config.includedDepartments?.length) scope.includedDepartments = config.includedDepartments;
  if (config.excludedUsers?.length) scope.excludedUsers = config.excludedUsers;
  return scope.includedDepartments || scope.excludedUsers ? scope : undefined;
}

const reconActivities = proxyActivities<ReconciliationActivities>({
  startToCloseTimeout: '5 minutes',
  retry: RECONCILIATION_RETRY,
});

/** Orphan detection lists every account of a system: long, and alive while it heartbeats. */
const orphanDetectionActivities = proxyActivities<
  Pick<ReconciliationActivities, 'runOrphanDetection'>
>({
  startToCloseTimeout: '2 hours',
  heartbeatTimeout: '2 minutes',
  retry: RECONCILIATION_RETRY,
});

/** What failed, for the report: an activity's own error rather than "Activity task failed". */
function failureMessage(err: unknown): string {
  if (err instanceof ActivityFailure && err.cause) return err.cause.message;
  return err instanceof Error ? err.message : String(err);
}

export const getReconciliationProgressQuery = defineQuery<ReconciliationProgress>('getProgress');

interface ReconciliationProgress {
  phase: string;
  usersScanned: number;
  totalUsers: number;
  driftsDetected: number;
  driftsCorrected: number;
  percentComplete: number;
  batchesCompleted?: number;
  totalBatches?: number;
}

interface BatchRange {
  skip: number;
  limit: number;
  index: number;
}

/**
 * Daily reconciliation workflow (scatter-gather).
 * Spawns parallel child workflows per batch for fast processing at scale.
 */
export async function dailyReconciliationWorkflow(
  config: ReconciliationConfig,
): Promise<ReconciliationReport> {
  const tenantId = config.tenantId ?? '';

  const startTime = await reconActivities.getWorkflowStartTime();

  let progress: ReconciliationProgress = {
    phase: 'INITIALIZING',
    usersScanned: 0,
    totalUsers: 0,
    driftsDetected: 0,
    driftsCorrected: 0,
    percentComplete: 0,
  };

  const allDrifts: DriftDetectionResult[] = [];
  const allCorrections: CorrectionAction[] = [];
  let alerts: ReconciliationAlert[] | undefined;
  const orphanDetectionFailures: OrphanDetectionFailure[] = [];

  setHandler(getReconciliationProgressQuery, () => progress);

  try {
    progress.phase = 'FETCHING_COUNT';
    log.info('[Reconciliation] Starting scatter-gather reconciliation...');

    const configScope = scanScopeOf(config);
    const scope = configScope && isPatched(SCAN_SCOPE_PATCH) ? configScope : undefined;
    const totalUsers = scope
      ? await reconActivities.getReconciliationUserCount(tenantId, scope)
      : await reconActivities.getReconciliationUserCount(tenantId);
    progress.totalUsers = totalUsers;

    if (totalUsers === 0) {
      progress.phase = 'COMPLETED';
      progress.percentComplete = 100;
      return reconActivities.generateReport(config.tenantId, [], [], startTime);
    }

    const batches = await reconActivities.getReconciliationBatchPlan(tenantId, totalUsers);

    progress.phase = 'SCATTERING';
    progress.totalBatches = batches.length;
    progress.batchesCompleted = 0;
    log.info('[Reconciliation] Spawning child workflows', {
      totalUsers,
      batchCount: batches.length,
    });

    const parentWorkflowId = workflowInfo().workflowId;
    const childPromises = batches.map((batch) =>
      executeChild(reconcileBatchWorkflow, {
        args: [
          {
            config,
            skip: batch.skip,
            limit: batch.limit,
            batchIndex: batch.index,
            ...(scope ? { scope } : {}),
          },
        ],
        workflowId: `${parentWorkflowId}-batch-${batch.index}`,
        parentClosePolicy: ParentClosePolicy.PARENT_CLOSE_POLICY_TERMINATE,
        ...inheritTenantAttributes(CHILD_TENANT_PATCH),
      }),
    );

    const results = await Promise.allSettled(childPromises);

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      progress.batchesCompleted = (progress.batchesCompleted ?? 0) + 1;
      progress.percentComplete =
        progress.totalBatches && progress.totalBatches > 0
          ? ((progress.batchesCompleted / progress.totalBatches) * 100 + 0.5) | 0
          : 0;

      if (result.status === 'fulfilled') {
        const batchResult = result.value;
        allDrifts.push(...batchResult.drifts);
        allCorrections.push(...batchResult.corrections);
        progress.usersScanned += batchResult.usersScanned;
        progress.driftsDetected += batchResult.drifts.reduce((sum, d) => sum + d.drifts.length, 0);
        progress.driftsCorrected += batchResult.corrections.filter((c) => c.success).length;
      } else {
        log.error('[Reconciliation] Batch failed', {
          batchIndex: i,
          error: result.reason?.message ?? String(result.reason),
        });
      }
    }

    log.info('[Reconciliation] Gather complete', {
      usersScanned: progress.usersScanned,
      driftsDetected: progress.driftsDetected,
    });

    const thresholds = driftThresholdAlerts(config, allDrifts);
    if (thresholds.alerts.length > 0 && isPatched(DRIFT_THRESHOLD_ALERTS_PATCH)) {
      alerts = thresholds.alerts;
      if (config.notifyOnDrift) {
        try {
          await reconActivities.notifyDriftThresholdExceeded(tenantId, {
            workflowId: parentWorkflowId,
            runId: workflowInfo().runId,
            totalDrifts: thresholds.totalDrifts,
            criticalDrifts: thresholds.criticalDrifts,
            alerts,
            ...(config.notifyEmail ? { notifyEmail: config.notifyEmail } : {}),
          });
        } catch (err: unknown) {
          // The report still names the alerts; the rest of the run goes on
          const msg = err instanceof Error ? err.message : String(err);
          log.error('[Reconciliation] Drift threshold notification failed', { error: msg });
        }
      }
    }

    progress.phase = 'ORPHAN_DETECTION';
    const heartbeatDetection = isPatched(ORPHAN_DETECTION_PATCH);
    const detection = heartbeatDetection ? orphanDetectionActivities : reconActivities;
    for (const system of config.targetSystems) {
      try {
        const orphans = scope
          ? await detection.runOrphanDetection(system, tenantId, scope)
          : await detection.runOrphanDetection(system, tenantId);
        for (let i = 0; i < orphans.length; i++) {
          const o = orphans[i];
          const startOnly = isPatched(START_ORPHAN_CLEANUP_PATCH);
          const orphanWorkflowId = startOnly
            ? orphanCleanupWorkflowId(o.tenantId, o.driftId)
            : `${parentWorkflowId}-orphan-${o.driftId}-${i}`;
          const input: OrphanCleanupInput = {
            driftId: o.driftId,
            targetSystem: o.targetSystem,
            externalId: o.externalId,
            accountIdentifier: o.accountIdentifier,
            tenantId: o.tenantId,
            // The cleanup deletes nothing on its own when this run asks for approval
            requireApprovalForDeletes: config.requireApprovalForDeletes,
          };
          // ABANDON: the cleanup outlives this run
          const options: ChildWorkflowOptions = {
            workflowId: orphanWorkflowId,
            parentClosePolicy: ParentClosePolicy.PARENT_CLOSE_POLICY_ABANDON,
            ...inheritTenantAttributes(CHILD_TENANT_PATCH),
          };
          if (startOnly) {
            try {
              // Waits for the start only, never for the cleanup's result
              await startChild(orphanCleanupWorkflow, { args: [input], ...options });
            } catch (err: unknown) {
              // The drift's cleanup already runs (started before, its id not recorded): that one
              if (!(err instanceof WorkflowExecutionAlreadyStartedError)) throw err;
            }
          } else {
            await executeChild(orphanCleanupWorkflow, { args: [input], ...options });
          }
          await reconActivities.updateDriftWorkflowId(o.driftId, orphanWorkflowId, tenantId);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error('[Reconciliation] Orphan detection failed', { system, error: msg });
        if (heartbeatDetection) {
          orphanDetectionFailures.push({ system, error: failureMessage(err) });
        }
      }
    }

    progress.phase = 'GENERATING_REPORT';

    const report = await reconActivities.generateReport(
      config.tenantId,
      allDrifts,
      allCorrections,
      startTime,
    );

    report.totalUsers = totalUsers;
    report.scannedUsers = progress.usersScanned;
    if (alerts) report.alerts = alerts;
    if (orphanDetectionFailures.length > 0)
      report.orphanDetectionFailures = orphanDetectionFailures;

    progress.phase = 'COMPLETED';
    progress.percentComplete = 100;

    log.info('[Reconciliation] Complete', {
      usersWithDrift: report.usersWithDrift,
      autoCorrected: report.autoCorrected,
    });

    return report;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('[Reconciliation] Workflow failed', { error: message });

    const report = await reconActivities.generateReport(
      config.tenantId,
      allDrifts,
      allCorrections,
      startTime,
    );
    report.totalUsers = progress.totalUsers;
    report.scannedUsers = progress.usersScanned;
    if (alerts) report.alerts = alerts;
    if (orphanDetectionFailures.length > 0)
      report.orphanDetectionFailures = orphanDetectionFailures;
    return report;
  }
}

/**
 * On-demand reconciliation for a single user
 */
export async function userReconciliationWorkflow(
  userId: string,
  targetSystems: string[],
  tenantId?: string,
): Promise<import('../shared/dtos/distributed-transaction.dto').DriftDetectionResult> {
  const tid = tenantId ?? '';
  log.info('[Reconciliation] Running on-demand reconciliation', { userId, tenantId: tid });

  const user = await reconActivities.fetchHubUserForReconciliation(tid, userId);

  if (!user) {
    throw ApplicationFailure.nonRetryable(`User not found in Hub: ${userId}`, 'UserNotFound');
  }

  const driftResult = await reconActivities.detectUserDrift(user, targetSystems, tid);

  log.info('[Reconciliation] User drift detection complete', {
    userId,
    driftsDetected: driftResult.drifts.length,
  });

  return driftResult;
}
