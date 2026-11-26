/**
 * Access Request Approval Workflow
 *
 * Multi-step approval workflow for self-service access requests.
 * Waits for approval signals at each step, provisions on final approval,
 * and auto-revokes when time-bound access expires.
 *
 * DETERMINISM: Uses Temporal-patched Date for deterministic time. No Math.random() or direct DB calls. All I/O in activities.
 *
 * SoD: createRequest refuses a request a BLOCK SoD policy matches before it is stored, so a run
 * starts with a request that passed. When the last approval comes in, the request is checked
 * again against the access the person holds at that moment (SOD_RECHECK_PATCH).
 *
 * End date: a time-bound request whose end date has passed when the last approval comes in is
 * not fulfilled; it ends EXPIRED with the reason (END_DATE_PASSED_PATCH). At the end date of a
 * fulfilled request the access is revoked, tried again until that succeeds, and only then is the
 * request EXPIRED (REVOKE_UNTIL_DONE_PATCH). An admin can end those attempts by closing the
 * request as removed by hand, and the run continues as new after a bounded number of them
 * (REVOKE_CLOSABLE_PATCH, access-request-revoke-retry.ts).
 */

import {
  proxyActivities,
  defineSignal,
  setHandler,
  sleep,
  condition,
  log,
} from '@temporalio/workflow';
import type { AccessRequestActivities } from '../activities/access-request.activities';
import { workflowNow } from './workflow-time';
import { isPatched } from './workflow-versioning';
import { retryRevokeUntilDone, revokeRetryDelayMs } from './access-request-revoke-retry';

/**
 * Before fulfilment the request is checked again for SoD, against the access the person holds
 * when the last approval comes in (recheckSodBeforeProvisioning, which also marks it
 * PROVISIONING); a BLOCK match rejects it and nothing is fulfilled. This closes the gap of two
 * pending requests for the two sides of a policy, each passing at request time. Histories from
 * before this patch mark the request PROVISIONING here and fulfil it.
 */
const SOD_RECHECK_PATCH = 'access-request:sod-recheck-before-provision';

/**
 * Decisions are kept per step until their step takes them: one that arrives before its step
 * starts waiting (while the approver is being notified, or for a later step while an earlier one
 * still waits) counts for that step, and never for another. Histories from before this patch
 * kept only the last decision and cleared it when a step started, so such a decision was dropped
 * and the step timed out (REJECTED).
 */
const STEP_DECISIONS_PATCH = 'access-request-approval:buffer-step-decisions';

/**
 * Time-bound access is revoked at its expiresAt: the run waits in timers of at most
 * MAX_SLEEP_MS until then (a request may run 730 days). Histories from before this patch slept
 * once, capped at MAX_SLEEP_MS, then revoked: a request already sleeping its cap keeps that.
 */
const EXPIRE_ON_DATE_PATCH = 'access-request-approval:expire-on-date';

/**
 * After a delegation the new approver is asked once, by the notify at the top of the step loop.
 * Histories from before this patch read the request again and asked the new approver in the
 * delegate branch, then again at the top of the loop: two mails to the delegate.
 */
const NOTIFY_DELEGATE_ONCE_PATCH = 'access-request-approval:notify-delegate-once';

/**
 * A time-bound request whose end date (timeConstraint.expiresAt, fixed at creation) has passed
 * when its last approval comes in is not fulfilled: expireBeforeFulfilment ends it EXPIRED with
 * the reason, for the requester and the audit log. Histories from before this patch fulfilled
 * it, and since the date had passed it was never revoked.
 */
const END_DATE_PASSED_PATCH = 'access-request-approval:end-date-passed-before-approval';

/**
 * A revoke at the end date that failed for a system (revokeAccessRequest answers success false
 * with failedSystems) is tried again until it succeeds; the request stays ACTIVE meanwhile and is
 * marked EXPIRED only after the revoke that succeeded. Histories from before this patch marked it
 * EXPIRED whatever the answer, and nothing tried again: the person kept the access.
 */
const REVOKE_UNTIL_DONE_PATCH = 'access-request-approval:revoke-until-done';

/**
 * A step the request itself approved when it was created (its approver is the requester: a
 * manager requesting for their report is the MANAGER step's approver; approval-chain.ts) is
 * skipped: its approver is not asked and the run goes on to the next step. Histories from before
 * this patch waited for a decision on it, which the self-approval guard refused to everyone, and
 * the step timed out REJECTED. Asked only for a request that has such a step.
 */
const SKIP_APPROVED_AT_CREATION_PATCH = 'access-request-approval:skip-steps-approved-at-creation';

/**
 * The revoke retried at the end date (REVOKE_UNTIL_DONE_PATCH) runs in retryRevokeUntilDone: each
 * wait also ends on the REMOVED_MANUALLY signal (an admin closed the request as removed by hand:
 * no further attempt, no status write), and after REVOKE_ATTEMPTS_PER_RUN attempts the run
 * continues as new. Asked at every retry, so a run that was already retrying under the old code
 * takes it at its next attempt; histories from before this patch slept between attempts and
 * retried forever in one run.
 */
const REVOKE_CLOSABLE_PATCH = 'access-request-approval:revoke-closable-continue-as-new';

/** Longest single timer: 90 days. */
const MAX_SLEEP_MS = 90 * 86_400_000;

const activities = proxyActivities<AccessRequestActivities>({
  startToCloseTimeout: '2 minutes',
});

/** An approver's decision on one approval step. */
export interface ApprovalDecision {
  stepIndex: number;
  decision: 'approve' | 'reject' | 'delegate';
  justification?: string;
  delegateTo?: string;
}

export const approvalDecisionSignal = defineSignal<[ApprovalDecision]>('APPROVAL_DECISION');

export const cancelRequestSignal = defineSignal('CANCEL_REQUEST');

/**
 * An admin closed the request as removed by hand (POST /access-requests/:id/removed-manually,
 * which stores the closure and EXPIRED before it signals): the retried revoke stops
 * (REVOKE_CLOSABLE_PATCH). No payload: the request holds who closed it and why.
 */
export const removedManuallySignal = defineSignal('REMOVED_MANUALLY');

export interface AccessRequestApprovalInput {
  requestId: string;
  tenantId?: string;
  /** Approval timeout in days. Passed from the service (sourced from env). */
  approvalTimeoutDays?: number;
  /**
   * Set only by the run's own continue-as-new (REVOKE_CLOSABLE_PATCH): the request is ACTIVE past
   * its end date and the revoke failed this many times; the run goes straight to the next retry.
   */
  revokeAttempts?: number;
}

export async function accessRequestApprovalWorkflow(
  input: AccessRequestApprovalInput,
): Promise<void> {
  const { requestId, tenantId, approvalTimeoutDays = 7 } = input;

  let cancelled = false;
  setHandler(cancelRequestSignal, () => {
    cancelled = true;
  });
  let removedManually = false;
  setHandler(removedManuallySignal, () => {
    removedManually = true;
  });

  // A run continued as new while retrying the revoke at the end date
  if (input.revokeAttempts !== undefined) {
    const outcome = await retryRevokeUntilDone(input, input.revokeAttempts, () => removedManually);
    if (outcome === 'revoked') await expired(requestId, tenantId);
    else log.info(`[AccessRequest] ${requestId}: closed as removed by hand, no further revoke`);
    return;
  }

  const doc = await activities.getAccessRequest(requestId, tenantId);
  if (!doc) {
    log.error(`[AccessRequest] ${requestId} not found`);
    return;
  }

  const steps = doc.approvalSteps ?? [];
  if (steps.length === 0) {
    log.info(`[AccessRequest] ${requestId} has no approval steps, provisioning directly`);
  } else {
    // Old histories: the last decision only, cleared when a step starts. Patched: every decision
    // not yet taken, in arrival order; a step takes the first one for itself.
    let lastDecision: ApprovalDecision | null = null;
    const pending: ApprovalDecision[] = [];
    setHandler(approvalDecisionSignal, (payload) => {
      lastDecision = payload;
      pending.push(payload);
    });
    const perStep = isPatched(STEP_DECISIONS_PATCH);
    const hasDecision = (i: number) =>
      perStep ? pending.some((d) => d.stepIndex === i) : lastDecision?.stepIndex === i;
    const takeDecision = (i: number): ApprovalDecision | null => {
      if (!perStep) return lastDecision;
      const at = pending.findIndex((d) => d.stepIndex === i);
      return at === -1 ? null : pending.splice(at, 1)[0];
    };

    const skipApproved =
      steps.some((step) => step.status === 'APPROVED') &&
      isPatched(SKIP_APPROVED_AT_CREATION_PATCH);

    for (let i = 0; i < steps.length; i++) {
      if (cancelled) {
        await activities.updateRequestStatus(requestId, 'CANCELLED', undefined, tenantId);
        return;
      }
      if (skipApproved && steps[i].status === 'APPROVED') continue;

      if (!perStep) lastDecision = null;
      await activities.notifyApprover(requestId, i, tenantId);

      const timedOut = !(await condition(
        () => cancelled || hasDecision(i),
        `${approvalTimeoutDays} days`,
      ));

      if (cancelled) {
        await activities.updateRequestStatus(requestId, 'CANCELLED', undefined, tenantId);
        return;
      }

      const decision = timedOut ? null : takeDecision(i);
      if (!decision) {
        log.warn(`[AccessRequest] ${requestId} step ${i} timed out`);
        await activities.updateRequestStatus(requestId, 'REJECTED', undefined, tenantId);
        return;
      }

      if (decision.decision === 'reject') {
        await activities.updateRequestStatus(requestId, 'REJECTED', undefined, tenantId);
        return;
      }

      if (decision.decision === 'delegate') {
        // The top of the loop asks the new approver; old histories asked here as well
        if (!isPatched(NOTIFY_DELEGATE_ONCE_PATCH)) {
          const freshDoc = await activities.getAccessRequest(requestId, tenantId);
          if (freshDoc?.approvalSteps?.[i]) {
            await activities.notifyApprover(requestId, i, tenantId);
          }
        }
        i--;
        continue;
      }
    }
  }

  // The requested end date. Coerced: after Temporal JSON round-trip a Date arrives as a string;
  // an unreadable date is NaN, which never counts as passed.
  const expiresAt = doc.timeConstraint?.expiresAt;
  const expiryMs = expiresAt ? new Date(expiresAt as unknown as string | Date).getTime() : NaN;
  if (isPatched(END_DATE_PASSED_PATCH) && expiryMs <= workflowNow().getTime()) {
    await activities.expireBeforeFulfilment(requestId, tenantId);
    log.warn(`[AccessRequest] ${requestId} not fulfilled: its end date passed before approval`);
    return;
  }

  if (isPatched(SOD_RECHECK_PATCH)) {
    const sod = await activities.recheckSodBeforeProvisioning(requestId, tenantId);
    if (!sod.passed) {
      log.warn(`[AccessRequest] ${requestId} rejected before fulfilment: SoD conflict`);
      return;
    }
  } else {
    await activities.updateRequestStatus(requestId, 'PROVISIONING', undefined, tenantId);
  }
  const provisioned = await activities.provisionAccessRequest(requestId, tenantId);

  const now = workflowNow();

  await activities.updateRequestStatus(
    requestId,
    provisioned ? 'ACTIVE' : 'REJECTED',
    { provisionedAt: now, expiresAt },
    tenantId,
  );

  if (provisioned && expiresAt) {
    // NaN (an unreadable date) and a date already past (a run from before END_DATE_PASSED_PATCH)
    // wait for nothing and revoke nothing, as before.
    const msUntilExpiry = expiryMs - workflowNow().getTime();
    if (msUntilExpiry > 0) {
      if (isPatched(EXPIRE_ON_DATE_PATCH)) {
        for (let left = msUntilExpiry; left > 0; left = expiryMs - workflowNow().getTime()) {
          await sleep(Math.min(left, MAX_SLEEP_MS));
        }
      } else {
        await sleep(Math.min(msUntilExpiry, MAX_SLEEP_MS));
      }
      let revoked = await activities.revokeAccessRequest(requestId, tenantId);
      if (!revoked.success && isPatched(REVOKE_UNTIL_DONE_PATCH)) {
        for (let attempt = 0; !revoked.success; attempt++) {
          log.warn(
            `[AccessRequest] ${requestId}: revoke failed for ${revoked.failedSystems.join(', ')}; ` +
              'trying again',
          );
          if (isPatched(REVOKE_CLOSABLE_PATCH)) {
            const outcome = await retryRevokeUntilDone(input, attempt, () => removedManually);
            if (outcome === 'removed-manually') {
              log.info(
                `[AccessRequest] ${requestId}: closed as removed by hand, no further revoke`,
              );
              return;
            }
            break;
          }
          await sleep(revokeRetryDelayMs(attempt));
          revoked = await activities.revokeAccessRequest(requestId, tenantId);
        }
      }
      await expired(requestId, tenantId);
    }
  }
}

/** The revoke at the end date succeeded: the request is EXPIRED. */
async function expired(requestId: string, tenantId: string | undefined): Promise<void> {
  await activities.updateRequestStatus(requestId, 'EXPIRED', undefined, tenantId);
  log.info(`[AccessRequest] ${requestId} expired and revoked`);
}
