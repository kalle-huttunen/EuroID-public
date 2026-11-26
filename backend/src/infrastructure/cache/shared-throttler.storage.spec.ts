import { Logger, type ExecutionContext } from '@nestjs/common';
import { createUnavailableSecurityStateStore } from '@testing/test-helpers';
import { MemorySecurityStateStore, SecurityStateUnavailableError } from './security-state.store';
import {
  SHARED_THROTTLE_KEY_PREFIX,
  SharedThrottlerStorage,
  sharedThrottleKey,
} from './shared-throttler.storage';

const loginRoute = {
  getClass: () => ({ name: 'AuthLocalController' }),
  getHandler: () => ({ name: 'login' }),
} as unknown as ExecutionContext;

describe('SharedThrottlerStorage', () => {
  afterEach(() => jest.restoreAllMocks());

  it('keys a shared counter by route, throttler and client, without the client address', () => {
    const key = sharedThrottleKey(loginRoute, '203.0.113.7', 'short');

    expect(key.startsWith(SHARED_THROTTLE_KEY_PREFIX)).toBe(true);
    expect(key).not.toContain('203.0.113.7');
    expect(sharedThrottleKey(loginRoute, '203.0.113.7', 'medium')).not.toBe(key);
    expect(sharedThrottleKey(loginRoute, '203.0.113.8', 'short')).not.toBe(key);
  });

  it('counts a shared key in the security state store and blocks over the limit', async () => {
    const store = new MemorySecurityStateStore();
    const increment = jest.spyOn(store, 'increment');
    const storage = new SharedThrottlerStorage(store);
    const key = sharedThrottleKey(loginRoute, '203.0.113.7', 'short');

    const first = await storage.increment(key, 1000, 2, 1000, 'short');
    await storage.increment(key, 1000, 2, 1000, 'short');
    const third = await storage.increment(key, 1000, 2, 1000, 'short');

    expect(increment).toHaveBeenCalledWith(key, 1000);
    expect(first).toEqual({
      totalHits: 1,
      timeToExpire: 1,
      isBlocked: false,
      timeToBlockExpire: 0,
    });
    expect(third).toEqual({ totalHits: 3, timeToExpire: 1, isBlocked: true, timeToBlockExpire: 1 });
    storage.onApplicationShutdown();
  });

  it('refuses a shared key while the store fails, instead of letting the request through', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const storage = new SharedThrottlerStorage(createUnavailableSecurityStateStore());
    const key = sharedThrottleKey(loginRoute, '203.0.113.7', 'short');

    await expect(storage.increment(key, 1000, 5, 1000, 'short')).rejects.toBeInstanceOf(
      SecurityStateUnavailableError,
    );
  });

  it('counts other keys in process, untouched by a store failure', async () => {
    const storage = new SharedThrottlerStorage(createUnavailableSecurityStateStore());

    const record = await storage.increment('plain-route-key', 1000, 5, 1000, 'short');

    expect(record).toMatchObject({ totalHits: 1, isBlocked: false });
    storage.onApplicationShutdown();
  });
});
