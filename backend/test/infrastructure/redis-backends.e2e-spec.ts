/**
 * RedisModule against a real Redis: with REDIS_URL set, the Nest cache (CACHE_MANAGER), the
 * owned locks (OWNED_LOCK_STORE) and the security state (SECURITY_STATE_STORE) write to Redis, so
 * other instances share them. Checked with a second Redis client of the test's own, not through
 * the module. The security state store rejects when Redis cannot be reached (fails closed).
 *
 * Opt-in: REDIS_TEST_URL=redis://127.0.0.1:6390 (a throwaway Redis; the test only touches keys
 * under its own random prefix).
 */
import { Test, type TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { createCache, type Cache } from 'cache-manager';
import Redis from 'ioredis';
import { RedisModule } from '../../src/infrastructure/cache/redis.module';
import { verifyRedisBackends } from '../../src/infrastructure/cache/cache-backend.check';
import {
  OWNED_LOCK_STORE,
  RedisOwnedLockStore,
  type OwnedLockStore,
} from '../../src/infrastructure/cache/owned-lock.store';
import {
  RedisSecurityStateStore,
  SECURITY_STATE_STORE,
  SecurityStateUnavailableError,
  type SecurityStateStore,
} from '../../src/infrastructure/cache/security-state.store';

/**
 * Close the Redis clients RedisModule opened. Needed after a failed init(): Nest's close() then
 * rethrows the init error without running the destroy hooks, and the clients would keep
 * reconnecting, so Jest would never exit.
 */
async function closeRedisClients(moduleRef: TestingModule): Promise<void> {
  await moduleRef.get<Cache>(CACHE_MANAGER).disconnect();
  await moduleRef.get<RedisOwnedLockStore>(OWNED_LOCK_STORE).onModuleDestroy();
  await moduleRef.get<RedisSecurityStateStore>(SECURITY_STATE_STORE).onModuleDestroy();
}

const REDIS_TEST_URL = process.env.REDIS_TEST_URL;
const describeRedis = REDIS_TEST_URL ? describe : describe.skip;

describeRedis('RedisModule with REDIS_URL (real Redis)', () => {
  const prefix = `euroid-e2e-${Math.random().toString(36).slice(2, 10)}:`;
  /** Set once init() succeeded: only then does close() run the destroy hooks. */
  let moduleRef: TestingModule | undefined;
  let second: Redis;

  /** The module, for tests (beforeAll failed when it is missing). */
  const app = (): TestingModule => {
    if (!moduleRef) throw new Error('RedisModule did not start');
    return moduleRef;
  };

  beforeAll(async () => {
    const compiled = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => ({ REDIS_URL: REDIS_TEST_URL, REDIS_KEY_PREFIX: prefix })],
        }),
        RedisModule,
      ],
    }).compile();
    // init() runs the startup check (CacheBackendCheck): it throws if either store is not Redis.
    try {
      await compiled.init();
    } catch (error: unknown) {
      await closeRedisClients(compiled);
      throw error;
    }
    moduleRef = compiled;
    second = new Redis(REDIS_TEST_URL as string);
  }, 30_000);

  afterAll(async () => {
    const keys = await second?.keys(`${prefix}*`);
    if (keys?.length) await second.del(...keys);
    await second?.quit();
    await moduleRef?.close();
  });

  it('writes cache entries to Redis, with their TTL', async () => {
    const cache = app().get<Cache>(CACHE_MANAGER);

    await cache.set('e2e:admincache:user-1', { roles: ['operator'] }, 30_000);

    const raw = await second.get(`${prefix}e2e:admincache:user-1`);
    expect(raw).toContain('operator');
    const ttl = await second.pttl(`${prefix}e2e:admincache:user-1`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(30_000);
    await expect(cache.get('e2e:admincache:user-1')).resolves.toEqual({ roles: ['operator'] });

    await cache.del('e2e:admincache:user-1');
    await expect(second.exists(`${prefix}e2e:admincache:user-1`)).resolves.toBe(0);
  });

  it('takes owned locks in Redis, where another instance sees them', async () => {
    const locks = app().get<OwnedLockStore>(OWNED_LOCK_STORE);
    expect(locks).toBeInstanceOf(RedisOwnedLockStore);

    await expect(locks.acquire('e2e:disttx:lock:user-1', 'tx-a', 30_000)).resolves.toBe('tx-a');

    await expect(second.get(`${prefix}e2e:disttx:lock:user-1`)).resolves.toBe('tx-a');
    const otherInstance = new RedisOwnedLockStore(
      new Redis(REDIS_TEST_URL as string, { keyPrefix: prefix }),
    );
    try {
      await expect(otherInstance.acquire('e2e:disttx:lock:user-1', 'tx-b', 30_000)).resolves.toBe(
        'tx-a',
      );
      await expect(otherInstance.release('e2e:disttx:lock:user-1', 'tx-b')).resolves.toBe(false);
    } finally {
      await otherInstance.onModuleDestroy();
    }
    await expect(locks.release('e2e:disttx:lock:user-1', 'tx-a')).resolves.toBe(true);
  });

  it('keeps security state in Redis, where another instance reads it', async () => {
    const state = app().get<SecurityStateStore>(SECURITY_STATE_STORE);
    expect(state).toBeInstanceOf(RedisSecurityStateStore);

    await state.set('e2e:mfa:failed:user-1', { count: 3, resetAt: 1 }, 30_000);

    await expect(second.get(`${prefix}e2e:mfa:failed:user-1`)).resolves.toBe(
      '{"count":3,"resetAt":1}',
    );
    const ttl = await second.pttl(`${prefix}e2e:mfa:failed:user-1`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(30_000);
    await expect(state.get('e2e:mfa:failed:user-1')).resolves.toEqual({ count: 3, resetAt: 1 });
    await state.del('e2e:mfa:failed:user-1');
    await expect(second.exists(`${prefix}e2e:mfa:failed:user-1`)).resolves.toBe(0);
    expect(state.health()).toMatchObject({ status: 'ok', backend: 'redis' });
  });

  it('gives a one-time value to exactly one of many simultaneous takes', async () => {
    const state = app().get<SecurityStateStore>(SECURITY_STATE_STORE);
    await state.set('e2e:saml:auth:code-1', { access_token: 't' }, 30_000);

    const taken = await Promise.all(
      Array.from({ length: 10 }, () => state.take('e2e:saml:auth:code-1')),
    );

    expect(taken.filter((value) => value !== undefined)).toEqual([{ access_token: 't' }]);
    await expect(second.exists(`${prefix}e2e:saml:auth:code-1`)).resolves.toBe(0);
  });

  it('counts concurrent increments in one window that Redis expires', async () => {
    const state = app().get<SecurityStateStore>(SECURITY_STATE_STORE);

    const counts = await Promise.all(
      Array.from({ length: 10 }, () => state.increment('e2e:throttle:client-1', 30_000)),
    );

    expect(counts.map((c) => c.count).sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
    const ttl = await second.pttl(`${prefix}e2e:throttle:client-1`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(30_000);
    expect(counts.every((c) => c.ttlMs > 0 && c.ttlMs <= 30_000)).toBe(true);
  });

  it('rejects security state reads and writes while Redis cannot be reached', async () => {
    // Port 1: nothing listens. No retries, so the failure comes at once.
    const client = new Redis('redis://127.0.0.1:1', {
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
    const unreachable = new RedisSecurityStateStore(client);
    try {
      await expect(unreachable.get('e2e:mfa:failed:user-1')).rejects.toBeInstanceOf(
        SecurityStateUnavailableError,
      );
      await expect(unreachable.set('e2e:mfa:failed:user-1', { count: 1 }, 1000)).rejects.toThrow(
        SecurityStateUnavailableError,
      );
      expect(unreachable.health()).toMatchObject({ status: 'failing', failures: 2 });
    } finally {
      client.disconnect();
    }
  });

  it('the startup check rejects a cache that is not in Redis', async () => {
    const inMemory = createCache();
    const locks = app().get<OwnedLockStore>(OWNED_LOCK_STORE);
    const probe = new Redis(REDIS_TEST_URL as string, { keyPrefix: prefix });
    try {
      await expect(verifyRedisBackends(inMemory, locks, probe)).rejects.toThrow(
        'REDIS_URL is set, but the cache did not write to Redis',
      );
    } finally {
      await probe.quit();
    }
  });
});
