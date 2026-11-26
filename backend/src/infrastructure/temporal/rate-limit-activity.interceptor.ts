/**
 * Activity interceptor that converts RateLimitedException to Temporal ApplicationFailure
 * with nextRetryDelay so Temporal respects API-reported backoff.
 */
import type {
  ActivityInboundCallsInterceptor,
  ActivityExecuteInput,
  Next,
} from '@temporalio/worker';
import { ApplicationFailure } from '@temporalio/common';
import {
  RATE_LIMITED_FAILURE_TYPE,
  RateLimitedException,
} from '@shared/errors/rate-limited.exception';

export class RateLimitActivityInterceptor implements ActivityInboundCallsInterceptor {
  async execute(
    input: ActivityExecuteInput,
    next: Next<ActivityInboundCallsInterceptor, 'execute'>,
  ): Promise<unknown> {
    try {
      return await next(input);
    } catch (e: unknown) {
      if (e instanceof RateLimitedException) {
        throw ApplicationFailure.create({
          message: e.message,
          type: RATE_LIMITED_FAILURE_TYPE,
          nonRetryable: false,
          nextRetryDelay: e.retryAfterMs,
        });
      }
      throw e;
    }
  }
}

// --- TASK_103 recap: Converts RateLimitedException → ApplicationFailure with nextRetryDelay.
