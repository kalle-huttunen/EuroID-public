/**
 * Privileged Session Workflow (PAM just-in-time access)
 *
 * A linked admin identity's accounts stand disabled in every target system (the connector
 * mappers create them so: shared/utils/linked-admin-profile.ts). A session enables them for the
 * tier's maximum session length and disables them again. One run per admin identity at a time,
 * under `t-<tenant>-pam-session-<adminId>` (privileged-session-id.ts); PamSessionService starts
 * it with the TenantId search attribute.
 *
 * mode 'session' (PUT /privileged-access/admin-accounts/:adminId/activate):
 * 1. The parent's entry turns ACTIVATING (markPrivilegedSessionActivating).
 * 2. The admin identity's provisioned accounts are read (getPrivilegedSessionTargets). An admin
 *    identity or parent that is deleted is never enabled.
 * 3. Each account is enabled in turn (privileged-session-accounts.ts: Entra ID, AD, SCIM, Okta;
 *    other targets are skipped). Retries come from the activities' retry policies.
 * 4. All enabled: the entry turns ACTIVE with `expiresAt`, the admin profile ACTIVE
 *    (recordPrivilegedSessionActive, which reads the deletion again first).
 *    Otherwise (an account failed or is missing, nothing to enable, the identity deleted, the
 *    session ended before it was active): every account is disabled again and the entry turns
 *    INACTIVE with the reason (recordPrivilegedSessionFailed). Nothing stays enabled.
 * 5. A durable timer waits until the session expires, or the endPrivilegedSession signal
 *    (deactivate, the expiry sweep, offboarding of the admin identity) ends it early.
 * 6. The accounts, read again, are disabled; the entry turns INACTIVE (recordPrivilegedSessionEnded).
 *    An account that cannot be disabled leaves the target state `enabled` and the reason on the
 *    entry: the hourly sweep starts a disable run for it.
 *
 * mode 'disable' (deactivate without a running session, the hourly sweep, after admin account
 * provisioning): step 6 only.
 *
 * DETERMINISM: no Date.now(), Math.random() or I/O; all reads and writes are activities.
 */
import {
  proxyActivities,
  defineSignal,
  defineQuery,
  setHandler,
  condition,
  log,
  workflowInfo,
} from '@temporalio/workflow';
import type { PrivilegedAccessActivities } from '../activities/privileged-access.activities';
import type { PamSessionTargets } from '../shared/types/pam-session';
import {
  hasEnableStep,
  setAccountEnabled,
  type SessionAccountStep,
} from './privileged-session-accounts';

/** Ends a session early; the argument says why (deactivated, expired, offboarded). */
export const endPrivilegedSessionSignal = defineSignal<[string?]>('endPrivilegedSession');

export interface PrivilegedSessionState {
  state: 'activating' | 'active' | 'ending' | 'disabling' | 'failed' | 'ended';
  expiresAt?: string;
  endReason?: string;
}
export const privilegedSessionStateQuery =
  defineQuery<PrivilegedSessionState>('privilegedSessionState');

export interface PrivilegedSessionInput {
  adminIdentityId: string;
  tenantId: string;
  mode: 'session' | 'disable';
  /** session: the activation's id, recorded on the entry; the API waits for its outcome by it. */
  sessionId?: string;
  /** session: how long it lasts (the tier's PAM_TIER*_MAX_HOURS). */
  durationMs?: number;
  /** disable: why the run disables (deactivated, expired, standing-state, provisioned). */
  reason?: string;
}

export interface PrivilegedSessionResult {
  outcome: 'ended' | 'activation-failed' | 'disabled' | 'disable-failed';
  /** ended: why; activation-failed: what failed. */
  reason?: string;
  /** The accounts that could not be disabled, as `<system>: <reason>`. */
  disableFailures: string[];
}

// Reads and writes of the session state: retried until they answer, like the identity reads
// of offboarding (a rolling deploy must not fail a session)
const {
  getPrivilegedSessionTargets,
  markPrivilegedSessionActivating,
  recordPrivilegedSessionActive,
  recordPrivilegedSessionFailed,
  recordPrivilegedSessionEnded,
} = proxyActivities<PrivilegedAccessActivities>({ startToCloseTimeout: '30s' });

const DELETED = 'the admin identity or its parent identity is deleted: it is never enabled';
const NOTHING_TO_ENABLE =
  'the admin account has no account to enable in Entra ID, AD, SCIM or Okta (not provisioned yet)';

/** `<system>: <reason>`; a reason the connector already prefixed (asDeprovisionFailure) as is. */
function describeFailure(step: SessionAccountStep): string {
  const reason = step.reason ?? step.outcome;
  return reason.toLowerCase().startsWith(step.system.toLowerCase())
    ? reason
    : `${step.system}: ${reason}`;
}

export async function privilegedSessionWorkflow(
  input: PrivilegedSessionInput,
): Promise<PrivilegedSessionResult> {
  const { adminIdentityId: adminId, tenantId } = input;
  const workflowId = workflowInfo().workflowId;
  let endReason: string | undefined;
  let state: PrivilegedSessionState['state'] =
    input.mode === 'disable' ? 'disabling' : 'activating';
  let expiresAt: string | undefined;
  setHandler(endPrivilegedSessionSignal, (reason?: string) => {
    endReason ??= reason || 'deactivated';
  });
  setHandler(privilegedSessionStateQuery, () => ({ state, expiresAt, endReason }));

  /** Disable every account the admin identity has (read again); the failures, as text. */
  const disableAll = async (known?: PamSessionTargets): Promise<string[]> => {
    const read = known ?? (await getPrivilegedSessionTargets(adminId, tenantId, workflowId));
    const failures: string[] = [];
    for (const target of read.targets.filter((t) => hasEnableStep(t.targetSystem))) {
      const step = await setAccountEnabled(target, false, {
        tenantId,
        workflowId,
        login: read.login,
      });
      // An account the target no longer has is not enabled either
      if (step.outcome === 'failed') failures.push(describeFailure(step));
    }
    return failures;
  };

  if (input.mode === 'disable') {
    const failures = await disableAll();
    const reason = input.reason ?? 'disabled';
    await recordPrivilegedSessionEnded(adminId, { reason, failures }, tenantId, workflowId);
    state = 'ended';
    return {
      outcome: failures.length > 0 ? 'disable-failed' : 'disabled',
      reason,
      disableFailures: failures,
    };
  }

  const sessionId = input.sessionId ?? workflowId;
  await markPrivilegedSessionActivating(adminId, sessionId, tenantId, workflowId);
  const read = await getPrivilegedSessionTargets(adminId, tenantId, workflowId);
  const enableable = read.targets.filter((t) => hasEnableStep(t.targetSystem));
  const durationMs = input.durationMs ?? 0;
  let failure = !read.live
    ? DELETED
    : enableable.length === 0
      ? NOTHING_TO_ENABLE
      : durationMs <= 0
        ? 'no session length was given'
        : undefined;
  for (const target of read.targets) {
    if (failure) break;
    if (endReason) {
      failure = `the session was ended before it was active (${endReason})`;
      break;
    }
    const step = await setAccountEnabled(target, true, { tenantId, workflowId, login: read.login });
    if (step.outcome === 'skipped') {
      log.info(`[PAM] ${step.system}: ${step.reason}; its account keeps its state`);
    } else if (step.outcome !== 'done') {
      failure = describeFailure(step);
    }
  }
  if (!failure && endReason) failure = `the session was ended before it was active (${endReason})`;
  if (!failure) {
    const active = await recordPrivilegedSessionActive(
      adminId,
      sessionId,
      durationMs,
      tenantId,
      workflowId,
    );
    if (active.live) expiresAt = active.expiresAt;
    else failure = DELETED;
  }
  if (failure) {
    log.warn(`[PAM] Activation of admin identity ${adminId} failed: ${failure}`);
    const failures = await disableAll(read);
    await recordPrivilegedSessionFailed(
      adminId,
      sessionId,
      failure,
      failures,
      tenantId,
      workflowId,
    );
    state = 'failed';
    return { outcome: 'activation-failed', reason: failure, disableFailures: failures };
  }

  state = 'active';
  const endedEarly = await condition(() => endReason !== undefined, durationMs);
  const reason = endedEarly ? (endReason ?? 'deactivated') : 'expired';
  state = 'ending';
  const failures = await disableAll();
  await recordPrivilegedSessionEnded(adminId, { reason, failures }, tenantId, workflowId);
  state = 'ended';
  log.info(`[PAM] Session of admin identity ${adminId} ended (${reason})`);
  return { outcome: 'ended', reason, disableFailures: failures };
}
