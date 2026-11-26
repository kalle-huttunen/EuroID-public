/**
 * Unit tests for RateLimiterActivities, including updateFromExternalSignal.
 */
import { Test } from '@nestjs/testing';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { RateLimiterActivities } from './rate-limiter.activities';
import { RateLimitedException } from '@shared/errors/rate-limited.exception';

const mockCache = {
  get: jest.fn().mockResolvedValue(undefined),
  set: jest.fn().mockResolvedValue(undefined),
  del: jest.fn().mockResolvedValue(undefined),
};

describe('RateLimiterActivities', () => {
  let activities: RateLimiterActivities;

  beforeEach(async () => {
    jest.clearAllMocks();
    // REDIS_URL unset = use fallback in-memory (no cache ops needed for core logic)
    delete process.env.REDIS_URL;

    const module = await Test.createTestingModule({
      providers: [RateLimiterActivities, { provide: CACHE_MANAGER, useValue: mockCache }],
    }).compile();

    activities = module.get(RateLimiterActivities);
  });

  describe('checkAndWait', () => {
    beforeEach(() => {
      jest.useFakeTimers({ now: new Date('2026-11-22T10:00:00Z') });
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('returns at once when the system is not throttled', async () => {
      await activities.initializeRateLimit('entra-id');

      await expect(activities.checkAndWait('entra-id')).resolves.toBe(0);
    });

    it('sleeps through the throttle delay before the caller may call the system', async () => {
      await activities.initializeRateLimit('entra-id');
      await activities.recordApiCalls('entra-id', 9_000); // 90% of 10,000: 2000 ms tier
      let waited: number | undefined;

      const check = activities.checkAndWait('entra-id').then((ms) => (waited = ms));
      await jest.advanceTimersByTimeAsync(1_999);
      expect(waited).toBeUndefined();
      await jest.advanceTimersByTimeAsync(1);
      await check;

      expect(waited).toBe(2_000);
    });

    it('hands a wait longer than an activity should sleep to Temporal as a rate-limit retry', async () => {
      await activities.initializeRateLimit('entra-id');
      await activities.recordApiCalls('entra-id', 10_000); // window exhausted for the hour

      const check = activities.checkAndWait('entra-id');

      await expect(check).rejects.toBeInstanceOf(RateLimitedException);
      await expect(check).rejects.toMatchObject({ system: 'entra-id', retryAfterMs: 3_600_000 });
      expect(jest.getTimerCount()).toBe(0);
    });
  });

  describe('updateFromExternalSignal', () => {
    it('should update rate limit state from external signal', async () => {
      await activities.initializeRateLimit('entra-id');
      const resetTimeMs = Date.now() + 120_000;

      await activities.updateFromExternalSignal('entra-id', 500, resetTimeMs);

      const state = await activities.getRateLimitState('entra-id');
      expect(state).not.toBeNull();
      expect(state!.remaining).toBe(500);
      expect(state!.resetTime.getTime()).toBe(resetTimeMs);
    });

    it('should initialize system if not exists', async () => {
      const resetTimeMs = Date.now() + 60_000;

      await activities.updateFromExternalSignal('scim', 100, resetTimeMs);

      const state = await activities.getRateLimitState('scim');
      expect(state).not.toBeNull();
      expect(state!.remaining).toBe(100);
      expect(state!.resetTime.getTime()).toBe(resetTimeMs);
    });
  });
});
