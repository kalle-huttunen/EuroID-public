/**
 * Throttler storage (the ThrottlerModule `storage`, app.module.ts) for routes that must be rate
 * limited across instances. A route opts in with `generateKey: sharedThrottleKey` in its
 * @Throttle() options: its counters then live in the security state store, which every instance
 * shares when REDIS_URL is set, and a store failure refuses the request with 503
 * (SecurityStateUnavailableError) instead of letting it through. Every other route keeps the
 * in-process counters of @nestjs/throttler, which fail open.
 *
 * A shared counter is a fixed window: the first request starts a window of the throttler's ttl,
 * and requests over the limit are refused until that window ends (the block lasts as long as the
 * window, the throttler's default blockDuration).
 */
import type { OnApplicationShutdown } from '@nestjs/common';
import {
  ThrottlerStorageService,
  type ThrottlerGenerateKeyFunction,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import { createHash } from 'crypto';
import type { SecurityStateStore } from './security-state.store';

/** Store keys of shared counters: euroid:throttle:{sha256 of route, throttler and client}. */
export const SHARED_THROTTLE_KEY_PREFIX = 'throttle:';

/**
 * @Throttle() `generateKey` that keeps the route's counter in the security state store. The
 * client (tracker, the IP) is hashed, so no address appears in a Redis key.
 */
export const sharedThrottleKey: ThrottlerGenerateKeyFunction = (context, tracker, throttlerName) =>
  SHARED_THROTTLE_KEY_PREFIX +
  createHash('sha256')
    .update(`${context.getClass().name}-${context.getHandler().name}-${throttlerName}-${tracker}`)
    .digest('hex');

export class SharedThrottlerStorage implements ThrottlerStorage, OnApplicationShutdown {
  private readonly local = new ThrottlerStorageService();

  constructor(private readonly securityState: SecurityStateStore) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): ReturnType<ThrottlerStorage['increment']> {
    if (!key.startsWith(SHARED_THROTTLE_KEY_PREFIX)) {
      return this.local.increment(key, ttl, limit, blockDuration, throttlerName);
    }
    const { count, ttlMs } = await this.securityState.increment(key, ttl);
    const timeToExpire = Math.ceil(ttlMs / 1000);
    const isBlocked = count > limit;
    return {
      totalHits: count,
      timeToExpire,
      isBlocked,
      timeToBlockExpire: isBlocked ? timeToExpire : 0,
    };
  }

  onApplicationShutdown(): void {
    this.local.onApplicationShutdown();
  }
}
