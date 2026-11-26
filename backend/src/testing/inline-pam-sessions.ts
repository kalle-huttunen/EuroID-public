/**
 * A PamSessionService for tests of the PAM services without Temporal: each run completes at once
 * and records its outcome as privilegedSessionWorkflow would when every account was enabled or
 * disabled (the connectors are not under test there), through the real PamSessionStateService.
 * The workflow itself is covered by test/workflows/privileged-session.workflow.e2e-spec.ts.
 */
import type { PamSessionService } from '../modules/privileged-access/pam-session.service';
import type { PamSessionStateService } from '../modules/privileged-access/pam-session-state.service';

export type InlinePamSessions = {
  [K in 'startSession' | 'endSession' | 'startDisable' | 'endIfRunning']: jest.Mock;
};

export function inlinePamSessions(state: PamSessionStateService): InlinePamSessions {
  const ended = (adminId: string, tenantId: string, reason: string) =>
    state.recordEnded(adminId, { reason, failures: [] }, tenantId);
  return {
    startSession: jest.fn(
      async (adminId: string, tenantId: string, sessionId: string, durationMs: number) => {
        await state.markActivating(adminId, sessionId, tenantId);
        await state.recordActive(adminId, sessionId, durationMs, tenantId);
        return `t-${tenantId}-pam-session-${adminId}`;
      },
    ),
    endSession: jest.fn(async (adminId: string, tenantId: string, reason: string) => {
      await ended(adminId, tenantId, reason);
      return `t-${tenantId}-pam-session-${adminId}`;
    }),
    startDisable: jest.fn(async (adminId: string, tenantId: string, reason: string) => {
      await ended(adminId, tenantId, reason);
      return true;
    }),
    endIfRunning: jest.fn().mockResolvedValue(false),
  };
}

/** The fake as the PamSessionService the PAM services take. */
export const asPamSessionService = (fake: InlinePamSessions) =>
  fake as unknown as PamSessionService;
