import type { ConfigService } from '@nestjs/config';
import Redis, { type RedisOptions } from 'ioredis';

/**
 * An ioredis client for REDIS_URL, with REDIS_PASSWORD and the REDIS_KEY_PREFIX key prefix
 * (default `euroid:`). The URL is passed as the connection string: ioredis ignores a `url` option
 * and would connect to localhost:6379 instead. Connects on its first command. `options` add to
 * these (e.g. timeouts).
 */
export function createRedisClient(
  config: ConfigService,
  redisUrl: string,
  options: RedisOptions = {},
): Redis {
  return new Redis(redisUrl, {
    password: config.get<string>('REDIS_PASSWORD') || undefined,
    keyPrefix: config.get<string>('REDIS_KEY_PREFIX') || 'euroid:',
    lazyConnect: true,
    ...options,
  });
}

/** Host and port of a Redis URL, for logs (never the credentials). */
export function redisHostOf(redisUrl: string): string {
  try {
    return new URL(redisUrl).host || 'Redis';
  } catch {
    return 'Redis';
  }
}
