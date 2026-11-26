/**
 * Access review: remove what the campaign revoked, batch by batch, and record per entitlement
 * what happened (removed, already gone, manual action needed, failed with the reason). Each
 * removal runs on its connector's queue with CONNECTOR_RETRY, an account item (runs that pass
 * `accounts`, patch access-review:account-revocation) on the default queue; what still fails is
 * a `failed` result, never a throw, so the other revocations are still attempted.
 *
 * Patch `access-review-revocation:rethrow-cancellation` (checked when a removal is cancelled): a
 * cancel of the campaign's workflow stops the batch. The removals the batch already made are
 * recorded out of the cancelled scope, the rest is not attempted, and the cancel ends the run.
 * Histories from before it turned the cancel into a `failed` result, failed the rest of the batch
 * at once and had the record cancelled too, so removals made before the cancel went unrecorded.
 *
 * Only ids pass through history: tasks name the review item and the entitlement's position,
 * and the activities read the account and group from the item.
 *
 * Workflow code: bundled into accessReviewWorkflow, so it must stay deterministic.
 */
import {
  proxyActivities,
  ActivityFailure,
  CancellationScope,
  isCancellation,
} from '@temporalio/workflow';
import type { AccessReviewRevocationActivities } from '../activities/access-review-revocation.activities';
import type {
  RevocationConnector,
  RevocationTask,
  RevocationTaskResult,
} from '../shared/types/access-review-revocation';
import { QUEUE_NAMES } from '../infrastructure/temporal/task-queue.config';
import { ACCESS_REVIEW_RETRY, CONNECTOR_RETRY } from '../infrastructure/config/retry-policies';
import { isPatched } from './workflow-versioning';

/**
 * Batches per workflow run. A campaign with more revocations continues as new, which keeps the
 * history well below Temporal's event limit (each batch is one list, one record and one
 * activity per revocation).
 */
export const MAX_REVOCATION_BATCHES_PER_RUN = 20;

/** A cancel stops the batch instead of becoming a `failed` result (see the header). */
const RETHROW_CANCELLATION_PATCH = 'access-review-revocation:rethrow-cancellation';

const review = proxyActivities<
  Pick<AccessReviewRevocationActivities, 'listRevocationTasks' | 'recordRevocationResults'>
>({
  startToCloseTimeout: '2 minutes',
  retry: ACCESS_REVIEW_RETRY,
});

type Revoker = Pick<AccessReviewRevocationActivities, 'revokeReviewAccess'>;
const connectorOptions = { startToCloseTimeout: '1m', retry: CONNECTOR_RETRY } as const;
const revokers: Record<RevocationConnector, Revoker> = {
  entra: proxyActivities<Revoker>({ taskQueue: QUEUE_NAMES['entra'], ...connectorOptions }),
  ad: proxyActivities<Revoker>({ taskQueue: QUEUE_NAMES['ad'], ...connectorOptions }),
  okta: proxyActivities<Revoker>({ taskQueue: QUEUE_NAMES['okta'], ...connectorOptions }),
  scim: proxyActivities<Revoker>({ taskQueue: QUEUE_NAMES['scim'], ...connectorOptions }),
};
/** Account items: the workflow's own (default) queue, as entitlement expiry's deprovision. */
const accountRevoker =
  proxyActivities<Pick<AccessReviewRevocationActivities, 'revokeReviewAccount'>>(connectorOptions);

/** The activity's own message (ActivityFailure only says which activity failed). */
function reasonOf(err: unknown): string {
  if (err instanceof ActivityFailure && err.cause) return err.cause.message;
  return err instanceof Error ? err.message : String(err);
}

const keyOf = (t: { itemId: string; entitlementIndex: number }) =>
  `${t.itemId}#${t.entitlementIndex}`;

async function revokeOne(
  task: RevocationTask,
  tenantId: string,
  workflowId: string,
): Promise<RevocationTaskResult> {
  const { itemId, entitlementIndex, connector } = task;
  try {
    const result =
      connector === 'account'
        ? await accountRevoker.revokeReviewAccount(task, tenantId, workflowId)
        : await revokers[connector].revokeReviewAccess(task, tenantId, workflowId);
    return { itemId, entitlementIndex, ...result };
  } catch (err: unknown) {
    if (isCancellation(err) && isPatched(RETHROW_CANCELLATION_PATCH)) throw err;
    return { itemId, entitlementIndex, outcome: 'failed', reason: reasonOf(err) };
  }
}

/**
 * Run revocation batches until none is left (`finished`) or this run's batch budget is spent
 * (the caller continues as new). A task coming back after its result was recorded means the
 * record did not stick: the run stops revoking instead of looping. `accounts`: the batches
 * include account items (a trailing activity argument, so no command changes).
 */
export async function runRevocations(
  campaignId: string,
  tenantId: string,
  workflowId: string,
  accounts = false,
): Promise<{ finished: boolean }> {
  const done = new Set<string>();
  for (let batch = 0; batch < MAX_REVOCATION_BATCHES_PER_RUN; batch++) {
    const { tasks, more } = await review.listRevocationTasks(
      campaignId,
      tenantId,
      workflowId,
      accounts,
    );
    if (tasks.some((t) => done.has(keyOf(t)))) return { finished: true };
    const results: RevocationTaskResult[] = [];
    for (const task of tasks) {
      done.add(keyOf(task));
      try {
        results.push(await revokeOne(task, tenantId, workflowId));
      } catch (cancelled: unknown) {
        // Only a cancel gets here: record what this batch removed, then let the cancel end the run
        if (results.length) {
          await CancellationScope.nonCancellable(() =>
            review.recordRevocationResults(campaignId, results, tenantId, workflowId),
          );
        }
        throw cancelled;
      }
    }
    if (results.length) {
      await review.recordRevocationResults(campaignId, results, tenantId, workflowId);
    }
    if (!more) return { finished: true };
  }
  return { finished: false };
}
