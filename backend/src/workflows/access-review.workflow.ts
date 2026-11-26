/**
 * Access Review Workflow
 *
 * Temporal workflow for campaign deadline management. Monitors the campaign until deadline
 * or until all items are decided. Then: expires the items still pending, removes what the
 * campaign revoked through each target's connector (access-review-revocation.ts) and records
 * per entitlement what happened, completes the campaign.
 *
 * Patch `access-review:connector-revocation` (new executions):
 * - the loop ends when no item is pending or at the deadline; a decision signal no longer ends
 *   it (before, the first decision ended the campaign within a minute and expired every other
 *   pending item)
 * - every `revoked` item is revoked, and `expired` items too with autoRevokeOnExpiry, through
 *   Entra ID, AD, Okta and SCIM on their own queues, also when nothing was pending at the end;
 *   a campaign with many revocations continues as new with `resumeRevocations`
 * Histories from before the patch keep the old flow: expirePendingItems and executeRevocations
 * (Entra ID only) when items were still pending.
 *
 * Patch `access-review:account-revocation` (new executions, checked at revocation): account
 * items (the identity's account in a target whose memberships EuroID cannot read) are removed
 * by revokeReviewAccount on the default queue through offboarding's per-target deprovision.
 * Histories from before it list no account tasks: such items are recorded as manual action.
 *
 * Patch `access-review-revocation:rethrow-cancellation` (access-review-revocation.ts, checked when
 * a removal is cancelled): a cancel during revocation stops the batch after recording the
 * removals it already made.
 *
 * DETERMINISM: Workflow does NOT query MongoDB. All DB operations are in activities.
 */

import {
  proxyActivities,
  defineQuery,
  defineSignal,
  setHandler,
  sleep,
  continueAsNew,
  workflowInfo,
} from '@temporalio/workflow';
import type { AccessReviewActivities } from '../activities/access-review.activities';
import { ACCESS_REVIEW_RETRY } from '../infrastructure/config/retry-policies';
import { isPatched } from './workflow-versioning';
import { runRevocations } from './access-review-revocation';

/** Revocation through the connectors, and the loop ending only when nothing is pending. */
const CONNECTOR_REVOCATION_PATCH = 'access-review:connector-revocation';
/** Account items removed through offboarding's per-target deprovision. */
const ACCOUNT_REVOCATION_PATCH = 'access-review:account-revocation';

const activities = proxyActivities<AccessReviewActivities>({
  startToCloseTimeout: '2 minutes',
  retry: ACCESS_REVIEW_RETRY,
});

export const getCampaignProgressQuery = defineQuery<{
  total: number;
  pending: number;
  decided: number;
}>('getCampaignProgress');
export const signalItemDecidedSignal = defineSignal('signalItemDecided');

export interface AccessReviewWorkflowInput {
  campaignId: string;
  deadline: Date;
  tenantId?: string;
  /** Set when a run continues as new with revocations left: go straight to them. */
  resumeRevocations?: boolean;
}

export async function accessReviewWorkflow(input: AccessReviewWorkflowInput): Promise<void> {
  const { campaignId, deadline, tenantId } = input;
  const connectorRevocation = isPatched(CONNECTOR_REVOCATION_PATCH);

  let allDecided = false;
  let latestProgress = { total: 0, pending: 0, decided: 0 };

  setHandler(signalItemDecidedSignal, () => {
    allDecided = true;
  });

  setHandler(getCampaignProgressQuery, () => latestProgress);

  if (connectorRevocation && input.resumeRevocations) {
    await revokeAndComplete(input);
    return;
  }

  latestProgress = await activities.getCampaignProgress(campaignId, tenantId);
  const sleepMs = await activities.getRemainingMsUntilDeadline(deadline);
  const pollIntervalMs = 60_000; // 1 minute

  if (sleepMs > 0) {
    const segments = ((sleepMs + pollIntervalMs - 1) / pollIntervalMs) | 0;
    for (let iter = 0; iter < segments; iter++) {
      const remaining = sleepMs - iter * pollIntervalMs;
      if (remaining <= 0) break;
      const sleepDuration = remaining <= pollIntervalMs ? remaining : pollIntervalMs;
      await sleep(`${sleepDuration} ms`);
      await activities.checkAndEscalateOverdue(campaignId, tenantId);
      latestProgress = await activities.getCampaignProgress(campaignId, tenantId);
      // Before the patch any decision signal ended the loop, pending items or not
      if ((!connectorRevocation && allDecided) || latestProgress.pending === 0) break;
      allDecided = false;

      if (iter >= 99) {
        await continueAsNew<typeof accessReviewWorkflow>({ campaignId, deadline, tenantId });
        return;
      }
    }
  }

  latestProgress = await activities.getCampaignProgress(campaignId, tenantId);
  if (latestProgress.pending > 0) {
    await activities.expirePendingItems(campaignId, tenantId);
    if (!connectorRevocation) await activities.executeRevocations(campaignId, tenantId);
  }

  if (connectorRevocation) {
    await revokeAndComplete(input);
    return;
  }
  await activities.completeCampaign(campaignId, tenantId);
}

/** Revoke through the connectors, then complete; continue as new while batches remain. */
async function revokeAndComplete(input: AccessReviewWorkflowInput): Promise<void> {
  const { campaignId, deadline, tenantId } = input;
  const accounts = isPatched(ACCOUNT_REVOCATION_PATCH);
  const { finished } = await runRevocations(
    campaignId,
    tenantId ?? '',
    workflowInfo().workflowId,
    accounts,
  );
  if (!finished) {
    await continueAsNew<typeof accessReviewWorkflow>({
      campaignId,
      deadline,
      tenantId,
      resumeRevocations: true,
    });
    return;
  }
  await activities.completeCampaign(campaignId, tenantId);
}

// --- TASK_105 recap: continueAsNew after 100 iterations (~100 min) to prevent history bloat.
