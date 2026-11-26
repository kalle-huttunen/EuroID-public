/**
 * ApplicationFailure type that RateLimitActivityInterceptor gives a 429, so a workflow can tell
 * an activity that ran out of attempts on 429s from other activity failures.
 */
export const RATE_LIMITED_FAILURE_TYPE = 'RateLimited';

/**
 * Thrown when a connector receives HTTP 429 (Too Many Requests) from a target API.
 * Carries retry-after delay so Temporal can schedule the next retry accordingly.
 */
export class RateLimitedException extends Error {
  constructor(
    public readonly retryAfterMs: number,
    public readonly system: string,
  ) {
    super(`Rate limited by ${system}; retry after ${retryAfterMs}ms`);
    this.name = 'RateLimitedException';
    Object.setPrototypeOf(this, RateLimitedException.prototype);
  }
}

// --- TASK_103 recap: Exception for HTTP 429. Carries retryAfterMs so Temporal can set nextRetryDelay.
