import { Logger } from '@nestjs/common';
import { createUnavailableSecurityStateStore } from '@testing/test-helpers';
import {
  MemorySecurityStateStore,
  RedisSecurityStateStore,
  SecurityStateUnavailableError,
  type SecurityStateRedisClient,
} from './security-state.store';

describe('RedisSecurityStateStore', () => {
  let client: jest.Mocked<SecurityStateRedisClient>;
  let store: RedisSecurityStateStore;
  let logError: jest.SpyInstance;

  beforeEach(() => {
    client = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
      eval: jest.fn().mockResolvedValue(null),
      quit: jest.fn().mockResolvedValue('OK'),
    };
    store = new RedisSecurityStateStore(client);
    logError = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => logError.mockRestore());

  it('stores JSON with its TTL and reads it back', async () => {
    await store.set('mfa:failed:user-1', { count: 2, resetAt: 1 }, 900_000);
    expect(client.set).toHaveBeenCalledWith(
      'mfa:failed:user-1',
      '{"count":2,"resetAt":1}',
      'PX',
      900_000,
    );

    client.get.mockResolvedValue('{"count":2,"resetAt":1}');
    await expect(store.get('mfa:failed:user-1')).resolves.toEqual({ count: 2, resetAt: 1 });
    client.get.mockResolvedValue(null);
    await expect(store.get('mfa:failed:user-1')).resolves.toBeUndefined();
  });

  it('never sends Redis a TTL it rejects (0 or a fraction)', async () => {
    await store.set('emergency:failed:10.0.0.1', { count: 1 }, 0);
    await store.set('emergency:failed:10.0.0.1', { count: 1 }, 2.5);

    expect(client.set.mock.calls.map((call) => call[3])).toEqual([1, 3]);
  });

  it('takes a value with one script that reads and deletes it, so no other take gets it', async () => {
    client.eval.mockResolvedValueOnce('{"access_token":"t"}');

    await expect(store.take('saml:auth:code')).resolves.toEqual({ access_token: 't' });
    const [script, numKeys, key] = client.eval.mock.calls[0];
    expect(script).toContain("redis.call('GET', KEYS[1])");
    expect(script).toContain("redis.call('DEL', KEYS[1])");
    expect([numKeys, key]).toEqual([1, 'saml:auth:code']);
    expect(client.get).not.toHaveBeenCalled();
    expect(client.del).not.toHaveBeenCalled();

    client.eval.mockResolvedValueOnce(null);
    await expect(store.take('saml:auth:code')).resolves.toBeUndefined();
  });

  it('counts with one script that increments and starts the window on the first count', async () => {
    client.eval.mockResolvedValueOnce([3, 41_500]);

    await expect(store.increment('throttle:abc', 60_000)).resolves.toEqual({
      count: 3,
      ttlMs: 41_500,
    });
    const [script, numKeys, key, windowMs] = client.eval.mock.calls[0];
    expect(script).toContain("redis.call('INCR', KEYS[1])");
    expect(script).toContain("redis.call('PEXPIRE', KEYS[1], ARGV[1])");
    expect([numKeys, key, windowMs]).toEqual([1, 'throttle:abc', 60_000]);
  });

  it.each([
    ['increment', (s: RedisSecurityStateStore) => s.increment('throttle:abc', 1000)],
    ['get', (s: RedisSecurityStateStore) => s.get('mfa:failed:user-1')],
    ['set', (s: RedisSecurityStateStore) => s.set('mfa:failed:user-1', { count: 1 }, 1000)],
    ['del', (s: RedisSecurityStateStore) => s.del('mfa:failed:user-1')],
    ['take', (s: RedisSecurityStateStore) => s.take('mfa:failed:user-1')],
  ])('rejects a failed %s instead of reporting a miss or a success', async (_op, call) => {
    const down = createUnavailableSecurityStateStore();

    await expect(call(down)).rejects.toBeInstanceOf(SecurityStateUnavailableError);
    await expect(call(down)).rejects.toMatchObject({ status: 503 });
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('ECONNREFUSED'));
    // The key can name a user or an IP: it stays out of the log.
    expect(logError).not.toHaveBeenCalledWith(expect.stringContaining('user-1'));
  });

  it('rejects a value it cannot parse rather than reading it as a miss', async () => {
    client.get.mockResolvedValue('not json');

    await expect(store.get('saml:auth:code')).rejects.toBeInstanceOf(SecurityStateUnavailableError);
  });

  it('reports failing in health until an operation succeeds again', async () => {
    expect(store.health()).toEqual({
      status: 'ok',
      backend: 'redis',
      failures: 0,
      lastFailureAt: null,
    });

    client.get.mockRejectedValueOnce(new Error('Connection is closed.'));
    await expect(store.get('k')).rejects.toThrow(SecurityStateUnavailableError);
    expect(store.health()).toMatchObject({
      status: 'failing',
      failures: 1,
      lastFailureAt: expect.any(String),
    });

    await store.get('k');
    expect(store.health()).toMatchObject({ status: 'ok', failures: 1 });
  });

  describe('after a failed delete', () => {
    beforeEach(() => {
      client.get.mockResolvedValue('{"isActive":true,"tokenVersion":0}');
      client.del.mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:6379'));
    });

    afterEach(() => jest.useRealTimers());

    it('deletes the key before reading it again, so the old value is never returned', async () => {
      await expect(store.del('admincache:user-1')).rejects.toThrow(SecurityStateUnavailableError);

      await expect(store.get('admincache:user-1')).resolves.toBeUndefined();
      expect(client.del).toHaveBeenCalledTimes(2);
      expect(client.get).not.toHaveBeenCalled();
      // Done: later reads go to Redis again.
      await expect(store.get('admincache:user-1')).resolves.toEqual({
        isActive: true,
        tokenVersion: 0,
      });
    });

    it('fails a read of the key while the delete still fails', async () => {
      await expect(store.del('admincache:user-1')).rejects.toThrow(SecurityStateUnavailableError);
      client.del.mockRejectedValueOnce(new Error('Command timed out'));

      await expect(store.get('admincache:user-1')).rejects.toThrow(SecurityStateUnavailableError);
      await expect(store.take('admincache:user-1')).resolves.toBeUndefined();
      expect(client.get).not.toHaveBeenCalled();
      expect(client.eval).not.toHaveBeenCalled();
    });

    it('lets a newer value replace the pending delete', async () => {
      await expect(store.del('admincache:user-1')).rejects.toThrow(SecurityStateUnavailableError);
      await store.set('admincache:user-1', { isActive: true, tokenVersion: 1 }, 30_000);

      await store.get('admincache:user-1');
      expect(client.get).toHaveBeenCalledWith('admincache:user-1');
      expect(client.del).toHaveBeenCalledTimes(1);
    });

    it('resends the delete on a timer until Redis takes it', async () => {
      jest.useFakeTimers();
      client.del.mockRejectedValueOnce(new Error('Command timed out'));
      await expect(store.del('admincache:user-1')).rejects.toThrow(SecurityStateUnavailableError);

      await jest.advanceTimersByTimeAsync(1000); // still down
      await jest.advanceTimersByTimeAsync(1000); // taken
      await jest.advanceTimersByTimeAsync(5000); // nothing left to resend

      expect(client.del).toHaveBeenCalledTimes(3);
      await store.get('admincache:user-1');
      expect(client.get).toHaveBeenCalledTimes(1);
    });

    it('stops resending on shutdown', async () => {
      jest.useFakeTimers();
      await expect(store.del('admincache:user-1')).rejects.toThrow(SecurityStateUnavailableError);

      await store.onModuleDestroy();
      await jest.advanceTimersByTimeAsync(5000);

      expect(client.del).toHaveBeenCalledTimes(1);
    });
  });

  it('closes its client on shutdown', async () => {
    await store.onModuleDestroy();
    expect(client.quit).toHaveBeenCalled();
  });
});

describe('MemorySecurityStateStore', () => {
  afterEach(() => jest.useRealTimers());

  it('keeps an entry until its TTL passes', async () => {
    jest.useFakeTimers();
    const store = new MemorySecurityStateStore();
    await store.set('mfa:failed:user-1', { count: 1 }, 1000);

    await expect(store.get('mfa:failed:user-1')).resolves.toEqual({ count: 1 });
    jest.advanceTimersByTime(1000);
    await expect(store.get('mfa:failed:user-1')).resolves.toBeUndefined();
  });

  it('gives a value to one take only, also when takes run at the same time', async () => {
    const store = new MemorySecurityStateStore();
    await store.set('saml:auth:code', { access_token: 't' }, 60_000);

    const taken = await Promise.all([store.take('saml:auth:code'), store.take('saml:auth:code')]);

    expect(taken.filter((value) => value !== undefined)).toEqual([{ access_token: 't' }]);
    await expect(store.get('saml:auth:code')).resolves.toBeUndefined();
  });

  it('takes nothing once the TTL passed', async () => {
    jest.useFakeTimers();
    const store = new MemorySecurityStateStore();
    await store.set('saml:auth:code', { access_token: 't' }, 1000);
    jest.advanceTimersByTime(1000);

    await expect(store.take('saml:auth:code')).resolves.toBeUndefined();
  });

  it('counts in a fixed window: every increment counts, and the count restarts after it', async () => {
    jest.useFakeTimers();
    const store = new MemorySecurityStateStore();

    const counts = await Promise.all([1, 2, 3].map(() => store.increment('throttle:abc', 1000)));
    expect(counts.map((c) => c.count).sort()).toEqual([1, 2, 3]);
    jest.advanceTimersByTime(400);
    await expect(store.increment('throttle:abc', 1000)).resolves.toEqual({ count: 4, ttlMs: 600 });

    jest.advanceTimersByTime(600);
    await expect(store.increment('throttle:abc', 1000)).resolves.toEqual({
      count: 1,
      ttlMs: 1000,
    });
  });

  it('deletes an entry and is always healthy', async () => {
    const store = new MemorySecurityStateStore();
    await store.set('saml:auth:code', { access_token: 't' }, 60_000);
    await store.del('saml:auth:code');

    await expect(store.get('saml:auth:code')).resolves.toBeUndefined();
    expect(store.health()).toMatchObject({ status: 'ok', backend: 'memory' });
  });
});

/** The in-process store (no REDIS_URL) drops expired entries, so counters of past windows do not pile up. */
describe('MemorySecurityStateStore expiry', () => {
  it('purges expired entries as new ones are written', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      const store = new MemorySecurityStateStore();
      for (let i = 0; i < 500; i++) await store.increment(`old:${i}`, 1000);
      now.mockReturnValue(1_002_000); // all of them expired
      for (let i = 0; i < 1000; i++) await store.set(`new:${i}`, 1, 60_000);

      expect(store.size()).toBe(1000);
    } finally {
      now.mockRestore();
    }
  });
});
