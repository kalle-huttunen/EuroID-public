/**
 * Redis / Cache Module
 *
 * Distributed cache and owner-checked locks for horizontal scaling. With REDIS_URL set both use
 * Redis, and startup fails when either does not (CacheBackendCheck, cache-backend.check.ts).
 * Without REDIS_URL both are in-process (dev, one instance), and startup warns about it.
 *
 * Security state (SECURITY_STATE_STORE: lockout counters, SAML one-time codes, the login
 * throttle) has a store of its own that rejects on Redis errors, so those checks fail
 * closed; the Nest cache fails open (security-state.store.ts). Its client has short connect and
 * command timeouts (SECURITY_STORE_CONNECT_TIMEOUT_MS, SECURITY_STORE_COMMAND_TIMEOUT_MS), so a
 * check denies within them while Redis is unreachable.
 *
 * Key patterns (REDIS_KEY_PREFIX, default euroid:): euroid:ratelimit:{system},
 * euroid:oauth:*, euroid:connector-health:* (CACHE_MANAGER);
 * euroid:mfa:failed:{userId}, euroid:emergency:failed:{ip},
 * euroid:saml:auth:{code}, euroid:throttle:{sha256} (SECURITY_STATE_STORE); and
 * euroid:disttx:lock:{tenantId}:{system}:{sha256 of the email} (OWNED_LOCK_STORE).
 */

import { Global, Logger, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { CacheModule, type CacheModuleOptions } from '@nestjs/cache-manager';
import {
  MemoryOwnedLockStore,
  OWNED_LOCK_STORE,
  RedisOwnedLockStore,
  type OwnedLockStore,
} from './owned-lock.store';
import {
  MemorySecurityStateStore,
  RedisSecurityStateStore,
  SECURITY_STATE_STORE,
  type SecurityStateStore,
} from './security-state.store';
import { CacheBackendCheck } from './cache-backend.check';
import type { RedisOptions } from 'ioredis';
import { createRedisClient } from './redis-client';
import { RedisKeyvStore } from './redis-keyv.store';

/** TTL of a Redis cache entry written without one; consumers pass their own per set(). */
const DEFAULT_REDIS_TTL_MS = 60 * 1000;

/**
 * Cache options. @nestjs/cache-manager v3 (cache-manager v7) reads Keyv stores from `stores` and
 * ignores a `store` option: a `store` here leaves the cache in memory.
 */
export function createCacheOptions(config: ConfigService): CacheModuleOptions {
  const redisUrl = config.get<string>('REDIS_URL');
  if (!redisUrl) return { ttl: 0 }; // in-memory: CacheBackendCheck warns at startup

  const logger = new Logger('RedisCache');
  const client = createRedisClient(config, redisUrl);
  client.on('error', (error: Error) => logger.warn(`Redis cache client: ${error.message}`));
  return { stores: [new RedisKeyvStore(client, DEFAULT_REDIS_TTL_MS)], ttl: 0 };
}

/** Owner-checked locks (owned-lock.store.ts): Redis when REDIS_URL is set, else in-process. */
export function createOwnedLockStore(config: ConfigService): OwnedLockStore {
  const redisUrl = config.get<string>('REDIS_URL');
  if (!redisUrl) return new MemoryOwnedLockStore(); // CacheBackendCheck warns at startup

  const logger = new Logger('OwnedLockStore');
  const client = createRedisClient(config, redisUrl);
  client.on('error', (error: Error) => logger.warn(`Redis lock client: ${error.message}`));
  return new RedisOwnedLockStore(client);
}

/** Defaults of SECURITY_STORE_CONNECT_TIMEOUT_MS and SECURITY_STORE_COMMAND_TIMEOUT_MS. */
const SECURITY_STORE_CONNECT_TIMEOUT_MS = 1000;
const SECURITY_STORE_COMMAND_TIMEOUT_MS = 500;

/** A positive whole number of milliseconds from `key`, or `fallback` when unset. Throws otherwise. */
function millisecondsFrom(config: ConfigService, key: string, fallback: number): number {
  const raw = config.get<string | number>(key);
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${key} must be a positive whole number of milliseconds, got "${raw}"`);
  }
  return value;
}

/**
 * Timeouts of the security state client. Without them a call waits while ioredis reconnects
 * (about 10 s with its defaults) before it fails; with them every call answers or fails within
 * the command timeout, and its check denies at once (fail closed, security-state.store.ts).
 */
export function securityStateClientOptions(
  config: ConfigService,
): Pick<RedisOptions, 'connectTimeout' | 'commandTimeout'> {
  return {
    connectTimeout: millisecondsFrom(
      config,
      'SECURITY_STORE_CONNECT_TIMEOUT_MS',
      SECURITY_STORE_CONNECT_TIMEOUT_MS,
    ),
    commandTimeout: millisecondsFrom(
      config,
      'SECURITY_STORE_COMMAND_TIMEOUT_MS',
      SECURITY_STORE_COMMAND_TIMEOUT_MS,
    ),
  };
}

/** Security state (security-state.store.ts): Redis when REDIS_URL is set, else in-process. */
export function createSecurityStateStore(config: ConfigService): SecurityStateStore {
  const redisUrl = config.get<string>('REDIS_URL');
  if (!redisUrl) return new MemorySecurityStateStore(); // CacheBackendCheck warns at startup

  const logger = new Logger('SecurityStateStore');
  const client = createRedisClient(config, redisUrl, securityStateClientOptions(config));
  client.on('error', (error: Error) =>
    logger.warn(`Redis security state client: ${error.message}`),
  );
  return new RedisSecurityStateStore(client);
}

@Global()
@Module({
  imports: [
    CacheModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => createCacheOptions(config),
      inject: [ConfigService],
    }),
  ],
  providers: [
    { provide: OWNED_LOCK_STORE, useFactory: createOwnedLockStore, inject: [ConfigService] },
    {
      provide: SECURITY_STATE_STORE,
      useFactory: createSecurityStateStore,
      inject: [ConfigService],
    },
    CacheBackendCheck,
  ],
  exports: [CacheModule, OWNED_LOCK_STORE, SECURITY_STATE_STORE],
})
export class RedisModule {}
