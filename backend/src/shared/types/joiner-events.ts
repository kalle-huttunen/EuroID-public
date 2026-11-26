/**
 * Payloads of the HR-driven joiner events (modules/joiners): pure types, re-exported by
 * infrastructure/events/event-payloads.ts, which keeps them out of its own line budget.
 */

/** identity.joiner_onboarding_started: no names or emails. Actor: system:hr-sync or the approver. */
export interface JoinerOnboardingStartedPayload {
  identityId: string;
  joinerEventId: string;
  /** The HR source whose sync minted the identity. */
  sourceName: string;
  workflowId: string;
  batchId?: string;
  rehire?: boolean; // a rehire: the sync revived the deleted identity
}

/** identity.joiner_onboarding_waiting (system:hr-sync): the HR start date is not a date. No PII. */
export type JoinerOnboardingWaitingPayload = Pick<
  JoinerOnboardingStartedPayload,
  'identityId' | 'joinerEventId' | 'sourceName'
> & { reason: 'start-date-unreadable' };

/** joiner.batch_paused | joiner.batch_approved | joiner.batch_rejected (HR-driven joiners). No PII. */
export interface JoinerBatchPayload {
  batchId: string;
  sourceName: string;
  identityCount: number;
  /** batch_paused: the limit the run exceeded and the active identity count it came from. */
  limit?: number;
  activeIdentityCount?: number;
  /**
   * batch_approved before 2026-11-24: how many onboarding runs the approval started. Since then
   * the approval answers before they start and leaves it out; each start is its own
   * identity.joiner_onboarding_started.
   */
  started?: number;
  comment?: string;
}
