/**
 * Locks with an owner. A lock is taken for an owner token and only that owner can release it, so
 * a late or repeated release (a retried activity, a rollback after the commit already released
 * the lock) never deletes a lock that another owner holds by then.
 *
 * With Redis (REDIS_URL) each call is one Lua script, so the check and the write are atomic
 * across instances. Without Redis an in-process map gives the same semantics, for a single
 * instance only.
 */

/** Injection token for the OwnedLockStore (provided by RedisModule). */
export const OWNED_LOCK_STORE = Symbol('OWNED_LOCK_STORE');

export interface OwnedLockStore {
  /**
   * Take `key` for `owner` for `ttlMs`, or renew it when `owner` already holds it. Returns the
   * owner that holds the lock afterwards: `owner` when it was taken or renewed, the other
   * owner's token when it was not.
   */
  acquire(key: string, owner: string, ttlMs: number): Promise<string>;
  /** Delete `key` only when `owner` holds it. True when this call released the lock. */
  release(key: string, owner: string): Promise<boolean>;
}

/** The part of an ioredis client the Redis store uses. */
export interface LockRedisClient {
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
  quit(): Promise<unknown>;
}

/** KEYS[1] = lock key, ARGV[1] = owner, ARGV[2] = TTL in ms. Returns the holder afterwards. */
const ACQUIRE_SCRIPT = `
local holder = redis.call('GET', KEYS[1])
if not holder then
  redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
  return ARGV[1]
end
if holder == ARGV[1] then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return holder
`;

/** KEYS[1] = lock key, ARGV[1] = owner. Returns 1 when deleted, 0 when another owner holds it. */
const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

export class RedisOwnedLockStore implements OwnedLockStore {
  constructor(private readonly client: LockRedisClient) {}

  async acquire(key: string, owner: string, ttlMs: number): Promise<string> {
    return String(await this.client.eval(ACQUIRE_SCRIPT, 1, key, owner, ttlMs));
  }

  async release(key: string, owner: string): Promise<boolean> {
    return Number(await this.client.eval(RELEASE_SCRIPT, 1, key, owner)) === 1;
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit();
  }
}

export class MemoryOwnedLockStore implements OwnedLockStore {
  private readonly locks = new Map<string, { owner: string; expiresAt: number }>();

  async acquire(key: string, owner: string, ttlMs: number): Promise<string> {
    const now = Date.now();
    const lock = this.locks.get(key);
    if (lock && lock.expiresAt > now && lock.owner !== owner) return lock.owner;
    this.locks.set(key, { owner, expiresAt: now + ttlMs });
    return owner;
  }

  async release(key: string, owner: string): Promise<boolean> {
    const lock = this.locks.get(key);
    if (!lock || lock.owner !== owner) return false;
    this.locks.delete(key);
    // An expired lock is gone in Redis too: nothing was released.
    return lock.expiresAt > Date.now();
  }
}
