/**
 * Startup check of the cache and owned-lock backends (RedisModule).
 *
 * Without REDIS_URL both are in-process, which is only safe for one API and one worker process:
 * a warning says so. With REDIS_URL a probe goes through the cache and through the lock store and
 * is read back from Redis with a client of its own. When either probe is missing there (a store
 * that silently fell back to memory) or Redis does not answer, startup fails instead of running
 * with caches and locks that other instances cannot see.
 */
import { randomUUID } from 'crypto';
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { OWNED_LOCK_STORE, type OwnedLockStore } from './owned-lock.store';
import { createRedisClient, redisHostOf } from './redis-client';

/** The probes expire on their own: nothing is left behind even when the check fails. */
const PROBE_TTL_MS = 60 * 1000;

/** Reads a key (REDIS_KEY_PREFIX applied) from Redis directly, not through the cache. */
export interface RedisProbe {
  get(key: string): Promise<string | null>;
}

/**
 * Write a probe through `cache` and `locks` and read both back with `probe`. Throws, naming the
 * backend, when a probe is not in Redis.
 */
export async function verifyRedisBackends(
  cache: Cache,
  locks: OwnedLockStore,
  probe: RedisProbe,
): Promise<void> {
  const token = randomUUID();
  const cacheKey = `startup-probe:cache:${token}`;
  const lockKey = `startup-probe:lock:${token}`;
  await cache.set(cacheKey, token, PROBE_TTL_MS);
  await locks.acquire(lockKey, token, PROBE_TTL_MS);

  const notInRedis: string[] = [];
  if (!(await probe.get(cacheKey))?.includes(token)) notInRedis.push('the cache');
  if ((await probe.get(lockKey)) !== token) notInRedis.push('the owned locks');
  if (notInRedis.length > 0) {
    throw new Error(`REDIS_URL is set, but ${notInRedis.join(' and ')} did not write to Redis`);
  }
}

@Injectable()
export class CacheBackendCheck implements OnApplicationBootstrap {
  private readonly logger = new Logger('RedisModule');

  constructor(
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
    @Inject(OWNED_LOCK_STORE) private readonly locks: OwnedLockStore,
    private readonly config: ConfigService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const redisUrl = this.config.get<string>('REDIS_URL');
    if (!redisUrl) {
      this.logger.warn(
        'Cache and owned locks: IN-MEMORY (REDIS_URL is not set). Each process has its own ' +
          'cache and locks: run a single API and a single worker only.',
      );
      return;
    }

    const probe = createRedisClient(this.config, redisUrl);
    try {
      await verifyRedisBackends(this.cache, this.locks, probe);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Redis startup check failed (${redisHostOf(redisUrl)}): ${message}`);
    } finally {
      probe.disconnect();
    }
    this.logger.log(`Cache and owned locks: Redis at ${redisHostOf(redisUrl)}`);
  }
}
