/**
 * Rate Limiter Activities
 *
 * Manages API rate limits for target systems to prevent throttling and ensure
 * smooth bulk operation execution.
 *
 * ARCHITECTURE:
 * - Tracks rate limit state per system in Redis (shared across workers)
 * - Falls back to in-memory when REDIS_URL not set (dev mode)
 * - Implements exponential backoff
 */

import { Injectable, Logger, Inject } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { RateLimitState } from '@shared/dtos/bulk-operation.dto';
import {
  SYSTEM_RATE_LIMITS,
  DEFAULT_SYSTEM_LIMIT,
  THROTTLE_TIERS,
  MODERATE_THROTTLE_THRESHOLD,
  MODERATE_THROTTLE_DELAY_MS,
  HIGH_THROTTLE_THRESHOLD,
  ESTIMATION_DEFAULTS,
  BATCH_CAPACITY_THRESHOLDS,
  MS_PER_DAY,
  MAX_IN_ACTIVITY_WAIT_MS,
} from '@infrastructure/config/rate-limiter.config';
import { RateLimitedException } from '@shared/errors/rate-limited.exception';

const KEY_PREFIX = 'ratelimit:';
const INDEX_KEY = 'ratelimit:index';

interface StoredRateLimitState {
  system: string;
  remaining: number;
  total: number;
  resetTimeMs: number;
  utilizationPercent: number;
  estimatedWaitMs: number;
}

@Injectable()
export class RateLimiterActivities {
  private readonly logger = new Logger(RateLimiterActivities.name);

  // Fallback in-memory when Redis not available (single-instance dev)
  private fallbackMap = new Map<string, RateLimitState>();

  private readonly systemLimits = SYSTEM_RATE_LIMITS;

  constructor(@Inject(CACHE_MANAGER) private readonly cache: Cache) {}

  private key(system: string): string {
    return `${KEY_PREFIX}${system}`;
  }

  private async getStored(system: string): Promise<StoredRateLimitState | null> {
    const raw = await this.cache.get<unknown>(this.key(system));
    if (raw == null) return null;
    try {
      if (typeof raw === 'object' && raw !== null && 'system' in raw) {
        return raw as StoredRateLimitState;
      }
      return JSON.parse(String(raw)) as StoredRateLimitState;
    } catch {
      return null;
    }
  }

  private async setStored(
    system: string,
    state: StoredRateLimitState,
    ttlMs: number,
  ): Promise<void> {
    const key = this.key(system);
    await this.cache.set(key, JSON.stringify(state), ttlMs);
    await this.addToIndex(system);
  }

  private async addToIndex(system: string): Promise<void> {
    const index = (await this.cache.get<string[]>(INDEX_KEY)) ?? [];
    if (!index.includes(system)) {
      index.push(system);
      await this.cache.set(INDEX_KEY, index, MS_PER_DAY);
    }
  }

  private toRateLimitState(stored: StoredRateLimitState): RateLimitState {
    return {
      system: stored.system,
      remaining: stored.remaining,
      total: stored.total,
      resetTime: new Date(stored.resetTimeMs),
      utilizationPercent: stored.utilizationPercent,
      estimatedWaitMs: stored.estimatedWaitMs,
    };
  }

  private useFallback(): boolean {
    return !process.env.REDIS_URL;
  }

  async initializeRateLimit(system: string): Promise<RateLimitState> {
    const config = this.systemLimits[system] || DEFAULT_SYSTEM_LIMIT;

    const state: RateLimitState = {
      system,
      remaining: config.total,
      total: config.total,
      resetTime: new Date(Date.now() + config.windowMs),
      utilizationPercent: 0,
      estimatedWaitMs: 0,
    };

    if (this.useFallback()) {
      this.fallbackMap.set(system, state);
    } else {
      const stored: StoredRateLimitState = {
        system,
        remaining: config.total,
        total: config.total,
        resetTimeMs: state.resetTime.getTime(),
        utilizationPercent: 0,
        estimatedWaitMs: 0,
      };
      await this.setStored(system, stored, config.windowMs);
    }

    this.logger.log(
      `[RateLimiter] Initialized rate limit for ${system}: ${config.total} calls/hour`,
    );
    return state;
  }

  /**
   * Wait out the system's throttle before the caller's API calls and return the milliseconds
   * waited (0 when not throttled). Waits up to MAX_IN_ACTIVITY_WAIT_MS in place; a longer wait
   * (an exhausted window) throws RateLimitedException, which RateLimitActivityInterceptor turns
   * into a Temporal retry after that delay.
   */
  async checkAndWait(system: string, operationsCount: number = 1): Promise<number> {
    const waitMs = await this.requiredWaitMs(system, operationsCount);
    if (waitMs <= 0) return 0;
    if (waitMs > MAX_IN_ACTIVITY_WAIT_MS) throw new RateLimitedException(waitMs, system);
    await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
    return waitMs;
  }

  private async requiredWaitMs(system: string, operationsCount: number): Promise<number> {
    let state: RateLimitState | null;

    if (this.useFallback()) {
      state = this.fallbackMap.get(system) ?? null;
    } else {
      const stored = await this.getStored(system);
      state = stored ? this.toRateLimitState(stored) : null;
    }

    if (!state) {
      state = await this.initializeRateLimit(system);
    }

    if (new Date() > state.resetTime) {
      this.logger.log(`[RateLimiter] Rate limit window reset for ${system}`);
      state = await this.initializeRateLimit(system);
    }

    state.utilizationPercent = ((state.total - state.remaining) / state.total) * 100;

    if (state.remaining <= 0) {
      const waitMs = state.resetTime.getTime() - Date.now();
      this.logger.warn(
        `[RateLimiter] Rate limit EXHAUSTED for ${system}. Waiting ${Math.round(waitMs / 1000)}s until reset.`,
      );
      return Math.max(0, waitMs);
    }

    if (state.remaining < operationsCount) {
      const waitMs = state.resetTime.getTime() - Date.now();
      this.logger.warn(
        `[RateLimiter] Insufficient rate limit for ${system}. Need ${operationsCount}, have ${state.remaining}. Waiting ${Math.round(waitMs / 1000)}s.`,
      );
      return Math.max(0, waitMs);
    }

    if (state.utilizationPercent > HIGH_THROTTLE_THRESHOLD) {
      const throttleMs = this.calculateThrottleDelay(state.utilizationPercent);
      this.logger.warn(
        `[RateLimiter] High utilization for ${system}: ${state.utilizationPercent.toFixed(1)}%. Throttling for ${throttleMs}ms.`,
      );
      return throttleMs;
    }

    if (state.utilizationPercent > MODERATE_THROTTLE_THRESHOLD) {
      return MODERATE_THROTTLE_DELAY_MS;
    }

    return 0;
  }

  async recordApiCalls(system: string, count: number): Promise<void> {
    const config = this.systemLimits[system] || DEFAULT_SYSTEM_LIMIT;

    let remaining = config.total;
    if (this.useFallback()) {
      let state = this.fallbackMap.get(system);
      if (!state) {
        await this.initializeRateLimit(system);
        state = this.fallbackMap.get(system)!;
      }
      state.remaining = Math.max(0, state.remaining - count);
      state.utilizationPercent = ((state.total - state.remaining) / state.total) * 100;
      remaining = state.remaining;
    } else {
      let stored = await this.getStored(system);
      if (!stored) {
        await this.initializeRateLimit(system);
        stored = (await this.getStored(system))!;
      }
      stored.remaining = Math.max(0, stored.remaining - count);
      stored.utilizationPercent = ((stored.total - stored.remaining) / stored.total) * 100;
      await this.setStored(system, stored, config.windowMs);
      remaining = stored.remaining;
    }

    this.logger.debug(
      `[RateLimiter] ${system}: Used ${count} calls. Remaining: ${remaining}/${config.total}`,
    );
  }

  async getRateLimitState(system: string): Promise<RateLimitState | null> {
    let state: RateLimitState | null;

    if (this.useFallback()) {
      state = this.fallbackMap.get(system) ?? null;
    } else {
      const stored = await this.getStored(system);
      state = stored ? this.toRateLimitState(stored) : null;
    }

    if (!state) return null;

    state.utilizationPercent = ((state.total - state.remaining) / state.total) * 100;
    state.estimatedWaitMs = state.remaining <= 0 ? state.resetTime.getTime() - Date.now() : 0;

    return { ...state };
  }

  async getRecommendedBatchSize(system: string): Promise<number> {
    const state = await this.getRateLimitState(system);
    const config = this.systemLimits[system];

    if (!state || !config) return 5;

    const capacityPercent = (state.remaining / state.total) * 100;

    if (capacityPercent > BATCH_CAPACITY_THRESHOLDS.moderate) return config.recommendedBatchSize;
    if (capacityPercent > BATCH_CAPACITY_THRESHOLDS.severe)
      return Math.max(
        BATCH_CAPACITY_THRESHOLDS.moderateMinimum,
        Math.floor(config.recommendedBatchSize * BATCH_CAPACITY_THRESHOLDS.moderateReductionFactor),
      );
    return Math.max(
      BATCH_CAPACITY_THRESHOLDS.absoluteMinimum,
      Math.floor(config.recommendedBatchSize * BATCH_CAPACITY_THRESHOLDS.severeReductionFactor),
    );
  }

  async getAllRateLimitStates(): Promise<Map<string, RateLimitState>> {
    const states = new Map<string, RateLimitState>();

    if (this.useFallback()) {
      for (const [system] of this.fallbackMap.entries()) {
        const state = await this.getRateLimitState(system);
        if (state) states.set(system, state);
      }
    } else {
      const index = (await this.cache.get<string[]>(INDEX_KEY)) ?? [];
      for (const system of index) {
        const state = await this.getRateLimitState(system);
        if (state) states.set(system, state);
      }
    }

    return states;
  }

  async updateFromExternalSignal(
    system: string,
    remaining: number,
    resetTimeMs: number,
  ): Promise<void> {
    const config = this.systemLimits[system] || DEFAULT_SYSTEM_LIMIT;

    if (this.useFallback()) {
      let state = this.fallbackMap.get(system);
      if (!state) state = await this.initializeRateLimit(system);
      if (!state) return;
      state.remaining = remaining;
      state.resetTime = new Date(resetTimeMs);
      state.utilizationPercent = ((state.total - state.remaining) / state.total) * 100;
      this.fallbackMap.set(system, state);
    } else {
      let stored = await this.getStored(system);
      if (!stored) {
        await this.initializeRateLimit(system);
        stored = (await this.getStored(system))!;
      }
      stored.remaining = remaining;
      stored.resetTimeMs = resetTimeMs;
      stored.utilizationPercent = ((stored.total - stored.remaining) / stored.total) * 100;
      await this.setStored(system, stored, config.windowMs);
    }

    this.logger.log(
      `[RateLimiter] External signal for ${system}: remaining=${remaining}, reset=${new Date(resetTimeMs).toISOString()}`,
    );
  }

  async resetRateLimits(system?: string): Promise<void> {
    if (this.useFallback()) {
      if (system) {
        await this.initializeRateLimit(system);
      } else {
        this.fallbackMap.clear();
      }
    } else {
      if (system) {
        await this.cache.del(this.key(system));
        await this.initializeRateLimit(system);
      } else {
        const index = (await this.cache.get<string[]>(INDEX_KEY)) ?? [];
        for (const s of index) await this.cache.del(this.key(s));
        await this.cache.del(INDEX_KEY);
      }
    }

    this.logger.log(
      system
        ? `[RateLimiter] Resetting rate limit for ${system}`
        : `[RateLimiter] Resetting ALL rate limits`,
    );
  }

  private calculateThrottleDelay(utilizationPercent: number): number {
    for (const tier of THROTTLE_TIERS) {
      if (utilizationPercent <= tier.maxUtilization) return tier.delayMs;
    }
    return THROTTLE_TIERS[THROTTLE_TIERS.length - 1].delayMs;
  }

  async estimateBatchDuration(
    system: string,
    operationCount: number,
    apiCallsPerOperation: number = ESTIMATION_DEFAULTS.apiCallsPerOperation,
  ): Promise<number> {
    const state = await this.getRateLimitState(system);
    const batchSize = await this.getRecommendedBatchSize(system);

    if (!state) return operationCount * ESTIMATION_DEFAULTS.fallbackMsPerOperation;

    const totalApiCalls = operationCount * apiCallsPerOperation;
    const batches = Math.ceil(operationCount / batchSize);
    const apiCallTime = totalApiCalls * ESTIMATION_DEFAULTS.avgApiCallMs;
    const throttleTime = batches * this.calculateThrottleDelay(state.utilizationPercent);
    const waitTime = totalApiCalls > state.remaining ? state.estimatedWaitMs : 0;

    return apiCallTime + throttleTime + waitTime;
  }
}
