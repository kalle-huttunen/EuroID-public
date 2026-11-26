/**
 * The removal at a time-bound access request's end date, tried again until it succeeds (patch
 * access-request-approval:revoke-until-done), as accessRequestApprovalWorkflow runs it since the
 * patch access-request-approval:revoke-closable-continue-as-new:
 * - each wait also ends when an admin closes the request as removed by hand (the
 *   REMOVED_MANUALLY signal, sent by POST /access-requests/:id/removed-manually once it closed
 *   the request EXPIRED with the admin and their note): the loop stops, with no further attempt
 *   and no status write;
 * - after REVOKE_ATTEMPTS_PER_RUN attempts in one run the run continues as new with the number
 *   of attempts so far (`revokeAttempts`), so the history stays small however long Entra ID
 *   refuses; the new run goes straight to the next wait.
 * Workflow code: bundled into the workflow, so it must stay deterministic.
 */
import { proxyActivities, condition, continueAsNew, log } from '@temporalio/workflow';
import type { AccessRequestActivities } from '../activities/access-request.activities';
import type {
  AccessRequestApprovalInput,
  accessRequestApprovalWorkflow,
} from './access-request-approval.workflow';

/** Attempts of one run before it continues as new: at the 6-hour cap about 5 days. */
export const REVOKE_ATTEMPTS_PER_RUN = 20;

/** Wait before trying a failed revoke again: 5 minutes, doubling up to 6 hours. */
const REVOKE_RETRY_FIRST_MS = 5 * 60_000;
const REVOKE_RETRY_MAX_MS = 6 * 3_600_000;
export const revokeRetryDelayMs = (attempt: number) =>
  Math.min(REVOKE_RETRY_MAX_MS, REVOKE_RETRY_FIRST_MS * 2 ** Math.min(attempt, 12));

const activities = proxyActivities<Pick<AccessRequestActivities, 'revokeAccessRequest'>>({
  startToCloseTimeout: '2 minutes',
});

/**
 * Waits and tries the revoke again until it succeeds (`revoked`) or the request is closed as
 * removed by hand (`removed-manually`). `firstAttempt`: the failed attempts before this call
 * (it sets the first wait). Continues the run as new after REVOKE_ATTEMPTS_PER_RUN attempts.
 */
export async function retryRevokeUntilDone(
  input: AccessRequestApprovalInput,
  firstAttempt: number,
  removedManually: () => boolean,
): Promise<'revoked' | 'removed-manually'> {
  const { requestId, tenantId } = input;
  for (let attempt = firstAttempt, inRun = 0; ; attempt++, inRun++) {
    if (inRun === REVOKE_ATTEMPTS_PER_RUN) {
      log.info(`[AccessRequest] ${requestId}: ${attempt} revoke attempts, continuing as new`);
      await continueAsNew<typeof accessRequestApprovalWorkflow>({
        ...input,
        revokeAttempts: attempt,
      });
    }
    if (await condition(removedManually, revokeRetryDelayMs(attempt))) return 'removed-manually';
    const revoked = await activities.revokeAccessRequest(requestId, tenantId);
    if (revoked.success) return 'revoked';
    log.warn(
      `[AccessRequest] ${requestId}: revoke failed for ${revoked.failedSystems.join(', ')}; ` +
        'trying again',
    );
  }
}
