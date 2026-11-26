/**
 * Dead-letter queue (backend `modules/dead-letter`): events, workflow steps and connector calls
 * that failed for good. Matches GET /dead-letter, GET /dead-letter/:id and GET /dead-letter/stats.
 * The API masks secrets, emails and phone fields in `originalPayload`, and emails in the error
 * texts; the stored entry keeps the clear event for retry and replay.
 */
import type { operations } from '../generated/api.types';

type ListQuery = NonNullable<operations['DeadLetterController_list']['parameters']['query']>;

export type DeadLetterType = NonNullable<ListQuery['type']>;
export type DeadLetterStatus = NonNullable<ListQuery['status']>;

export interface IDeadLetterEntry {
  _id: string;
  type: DeadLetterType;
  /** Where it failed: an event type (`identity.created`), `webhook:<subscription>:<event>`, ... */
  source: string;
  /** What failed, masked by the API. A failed event handler carries the whole domain event. */
  originalPayload: Record<string, unknown>;
  /**
   * The event handler that failed (`Class.method`), when it was captured per handler: retry and
   * replay then run only this handler. Without it they re-run every handler of the event.
   */
  handler?: string;
  /** `stack` only outside production. */
  error: { message: string; code?: string; stack?: string };
  correlationId?: string;
  retryCount: number;
  maxRetries: number;
  status: DeadLetterStatus;
  nextRetryAt?: string;
  lastRetryError?: string;
  /** Who retried, replayed or dismissed it (email), or `auto-retry-poller`. */
  resolvedBy?: string;
  resolvedAt?: string;
  createdAt: string;
  updatedAt?: string;
}

/** GET /dead-letter/stats: entry count per status; a status without entries is absent. */
export type IDeadLetterStats = Partial<Record<DeadLetterStatus, number>>;

export interface IDeadLetterFilter {
  status?: DeadLetterStatus;
  type?: DeadLetterType;
  /** Case-insensitive prefix of `source`. */
  source?: string;
}
