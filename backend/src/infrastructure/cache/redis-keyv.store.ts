import { EventEmitter } from 'events';

/** The part of an ioredis client the store uses. */
export interface KeyvRedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'PX', ttlMs: number): Promise<unknown>;
  del(key: string): Promise<number>;
  quit(): Promise<unknown>;
}

/**
 * A Keyv storage adapter on ioredis, the store behind the Nest cache (CACHE_MANAGER) when
 * REDIS_URL is set. cache-manager v7 takes Keyv stores only; Keyv serialises each entry to a
 * string, with its expiry, before it gets here, and the Redis TTL removes it.
 */
export class RedisKeyvStore extends EventEmitter {
  /** Keyv reads `opts` and sets `namespace` on its store. */
  readonly opts: Record<string, unknown> = {};
  namespace?: string;

  constructor(
    private readonly client: KeyvRedisClient,
    private readonly defaultTtlMs: number,
  ) {
    super();
  }

  async get(key: string): Promise<string | undefined> {
    return (await this.client.get(key)) ?? undefined;
  }

  async set(key: string, value: string, ttl?: number): Promise<boolean> {
    await this.client.set(key, value, 'PX', ttl && ttl > 0 ? ttl : this.defaultTtlMs);
    return true;
  }

  async delete(key: string): Promise<boolean> {
    return (await this.client.del(key)) > 0;
  }

  /** Clearing would mean FLUSHDB on a Redis the owned locks (and maybe other apps) share. */
  async clear(): Promise<void> {
    throw new Error('Clearing the Redis cache is not supported: delete keys one by one');
  }

  async disconnect(): Promise<void> {
    await this.client.quit();
  }
}
