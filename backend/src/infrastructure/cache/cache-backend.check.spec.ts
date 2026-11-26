import type { ConfigService } from '@nestjs/config';
import { createCache, type Cache } from 'cache-manager';
import { Logger } from '@nestjs/common';
import { CacheBackendCheck, verifyRedisBackends, type RedisProbe } from './cache-backend.check';
import { MemoryOwnedLockStore, type OwnedLockStore } from './owned-lock.store';

/** A stand-in for Redis: the "Redis" stores write here, the probe reads from here. */
class FakeRedis implements RedisProbe {
  readonly keys = new Map<string, string>();
  async get(key: string) {
    return this.keys.get(key) ?? null;
  }
}

/** A cache whose writes land in `redis`, as the Redis-backed CACHE_MANAGER's do. */
const redisCache = (redis: FakeRedis) =>
  ({
    set: async (key: string, value: string) => {
      redis.keys.set(key, JSON.stringify({ value }));
      return value;
    },
  }) as unknown as Cache;

/** Locks that land in `redis`, as RedisOwnedLockStore's do. */
const redisLocks = (redis: FakeRedis): OwnedLockStore => ({
  acquire: async (key, owner) => {
    redis.keys.set(key, owner);
    return owner;
  },
  release: async () => true,
});

describe('verifyRedisBackends', () => {
  let redis: FakeRedis;

  beforeEach(() => {
    redis = new FakeRedis();
  });

  it('passes when the cache and the locks both write to Redis', async () => {
    await expect(
      verifyRedisBackends(redisCache(redis), redisLocks(redis), redis),
    ).resolves.toBeUndefined();
  });

  it('fails when the cache stayed in memory', async () => {
    await expect(verifyRedisBackends(createCache(), redisLocks(redis), redis)).rejects.toThrow(
      'REDIS_URL is set, but the cache did not write to Redis',
    );
  });

  it('fails when the locks stayed in memory', async () => {
    await expect(
      verifyRedisBackends(redisCache(redis), new MemoryOwnedLockStore(), redis),
    ).rejects.toThrow('REDIS_URL is set, but the owned locks did not write to Redis');
  });

  it('names both when neither writes to Redis', async () => {
    await expect(
      verifyRedisBackends(createCache(), new MemoryOwnedLockStore(), redis),
    ).rejects.toThrow('the cache and the owned locks did not write to Redis');
  });
});

describe('CacheBackendCheck without REDIS_URL', () => {
  it('starts in memory and warns that caches and locks are per process', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const config = { get: () => undefined } as unknown as ConfigService;
    const check = new CacheBackendCheck(createCache(), new MemoryOwnedLockStore(), config);

    await expect(check.onApplicationBootstrap()).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('IN-MEMORY (REDIS_URL is not set)'));
    warn.mockRestore();
  });
});
