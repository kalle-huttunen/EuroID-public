import { Test } from '@nestjs/testing';
import { CACHE_MANAGER, CacheModule } from '@nestjs/cache-manager';
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Cache } from 'cache-manager';
import type Redis from 'ioredis';
import {
  createCacheOptions,
  createOwnedLockStore,
  createSecurityStateStore,
  securityStateClientOptions,
} from './redis.module';
import * as redisClient from './redis-client';
import { RedisKeyvStore } from './redis-keyv.store';
import { MemoryOwnedLockStore, RedisOwnedLockStore } from './owned-lock.store';
import { SecurityStateUnavailableError } from './security-state.store';

const configWith = (values: Record<string, string>) =>
  ({ get: (key: string) => values[key] }) as unknown as ConfigService;

// A port nothing listens on: the clients connect lazily, and these tests never reach Redis.
const REDIS_URL = 'redis://127.0.0.1:1';

describe('RedisModule factories', () => {
  afterEach(() => jest.restoreAllMocks());

  it('routes cache writes to the Redis store when REDIS_URL is set', async () => {
    // @nestjs/cache-manager v3 reads `stores`; a `store` option left the cache in memory.
    const set = jest.spyOn(RedisKeyvStore.prototype, 'set').mockResolvedValue(true);
    jest.spyOn(RedisKeyvStore.prototype, 'disconnect').mockResolvedValue(undefined);
    const moduleRef = await Test.createTestingModule({
      imports: [CacheModule.register(createCacheOptions(configWith({ REDIS_URL })))],
    }).compile();
    const cache = moduleRef.get<Cache>(CACHE_MANAGER);

    await cache.set('admincache:user-1', { roles: ['operator'] }, 30_000);

    expect(set).toHaveBeenCalledWith(
      'admincache:user-1',
      expect.stringContaining('operator'),
      30_000,
    );
    await moduleRef.close();
  });

  it('keeps the cache in memory without REDIS_URL', () => {
    expect(createCacheOptions(configWith({}))).toEqual({ ttl: 0 });
  });

  it('gives Redis locks with REDIS_URL and in-process locks without it', () => {
    expect(createOwnedLockStore(configWith({ REDIS_URL }))).toBeInstanceOf(RedisOwnedLockStore);
    expect(createOwnedLockStore(configWith({}))).toBeInstanceOf(MemoryOwnedLockStore);
  });
});

describe('security state client timeouts', () => {
  afterEach(() => jest.restoreAllMocks());

  it('are short by default and configurable', () => {
    expect(securityStateClientOptions(configWith({}))).toEqual({
      connectTimeout: 1000,
      commandTimeout: 500,
    });
    expect(
      securityStateClientOptions(
        configWith({
          SECURITY_STORE_CONNECT_TIMEOUT_MS: '2500',
          SECURITY_STORE_COMMAND_TIMEOUT_MS: '250',
        }),
      ),
    ).toEqual({ connectTimeout: 2500, commandTimeout: 250 });
  });

  it.each(['0', '-5', '1.5', 'soon'])('refuse %s as a timeout at startup', (value) => {
    expect(() =>
      securityStateClientOptions(configWith({ SECURITY_STORE_COMMAND_TIMEOUT_MS: value })),
    ).toThrow('SECURITY_STORE_COMMAND_TIMEOUT_MS must be a positive whole number of milliseconds');
  });

  it('make a call fail within the command timeout while Redis cannot be reached', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const created = jest.spyOn(redisClient, 'createRedisClient');
    const store = createSecurityStateStore(
      configWith({ REDIS_URL, SECURITY_STORE_COMMAND_TIMEOUT_MS: '200' }),
    );
    const client = created.mock.results[0].value as Redis;
    try {
      expect(client.options).toMatchObject({ connectTimeout: 1000, commandTimeout: 200 });

      const started = Date.now();
      await expect(store.get('mfa:failed:user-1')).rejects.toBeInstanceOf(
        SecurityStateUnavailableError,
      );
      // ioredis alone keeps the call waiting through its reconnect retries, about 10 s.
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      client.disconnect();
    }
  });
});
