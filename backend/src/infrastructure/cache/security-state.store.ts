/**
 * Security state: the MFA and break-glass (emergency token) failure counters, the SAML one-time
 * login codes and the login rate limit (shared-throttler.storage.ts). Token revocation is not
 * kept here: JwtAuthGuard reads it from the database on every request.
 *
 * It is kept out of the Nest cache (CACHE_MANAGER) because that cache fails open: Keyv turns a
 * failed Redis read into a miss and a failed write into `false`, and cache-manager turns a failed
 * read into a miss, so while Redis is down a lockout counter reads as zero and every attempt is
 * allowed. This store rejects instead, with SecurityStateUnavailableError (503), so its callers
 * deny. Each failure is logged as an error and counted for GET /health/ready (health()).
 *
 * With Redis (REDIS_URL) the state is shared by every instance; without it an in-process map
 * keeps it, for a single instance only (RedisModule picks one).
 *
 * A delete that fails still takes effect for this instance: it never reads the old value again
 * (see RedisSecurityStateStore.del), so a Redis that comes back with the old entry does not hand
 * it back.
 */
import { Logger, ServiceUnavailableException } from '@nestjs/common';
import type { KeyvRedisClient } from './redis-keyv.store';

/** The part of an ioredis client the Redis store uses. */
export interface SecurityStateRedisClient extends KeyvRedisClient {
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
}

/** Injection token for the SecurityStateStore (provided by RedisModule). */
export const SECURITY_STATE_STORE = Symbol('SECURITY_STATE_STORE');

/** The store could not read or write security state: the request is denied. */
export class SecurityStateUnavailableError extends ServiceUnavailableException {
  constructor() {
    super('Security checks are temporarily unavailable. Try again later.');
  }
}

export interface SecurityStateHealth {
  /** failing while the last operation failed (callers deny); ok once one succeeds again. */
  status: 'ok' | 'failing';
  backend: 'redis' | 'memory';
  /** Failed operations since startup. */
  failures: number;
  /** When an operation last failed (ISO), null if none has. */
  lastFailureAt: string | null;
}

export interface SecurityStateStore {
  /** The value at `key`, undefined when there is none. Rejects when the store fails. */
  get<T>(key: string): Promise<T | undefined>;
  /** Store `value` (JSON) at `key` for `ttlMs`. Rejects when the store fails. */
  set(key: string, value: unknown, ttlMs: number): Promise<void>;
  /**
   * Delete `key`. Rejects when the store fails; the delete then stays pending, and this store
   * never returns the old value.
   */
  del(key: string): Promise<void>;
  /**
   * Read and delete `key` in one step (one-time values): of concurrent takes of one key only one
   * gets the value, the others get undefined. Rejects when the store fails.
   */
  take<T>(key: string): Promise<T | undefined>;
  /**
   * Add 1 to the counter at `key` and return it with the time left in its window. The first
   * increment starts a window of `windowMs` and the counter ends with it (a fixed window).
   * Atomic: concurrent increments each count. Rejects when the store fails.
   */
  increment(key: string, windowMs: number): Promise<{ count: number; ttlMs: number }>;
  health(): SecurityStateHealth;
}

/** KEYS[1] = key. Returns the value and deletes it, or nil when there is none. */
const TAKE_SCRIPT = `
local value = redis.call('GET', KEYS[1])
if value then
  redis.call('DEL', KEYS[1])
end
return value
`;

/** KEYS[1] = counter, ARGV[1] = window in ms. Returns { count, ms left in the window }. */
const INCREMENT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return { count, redis.call('PTTL', KEYS[1]) }
`;

/** Redis rejects a PX of 0 or a fraction: the shortest TTL is 1 ms. */
const pxOf = (ttlMs: number) => Math.max(1, Math.ceil(ttlMs));

/** How often deletes that failed are sent again, until Redis takes them. */
const PENDING_DELETE_RETRY_MS = 1000;

export class RedisSecurityStateStore implements SecurityStateStore {
  private readonly logger = new Logger('SecurityStateStore');
  private failing = false;
  private failures = 0;
  private lastFailureAt: Date | null = null;
  /** Keys whose delete failed: deleted before any other use of them, and retried on a timer. */
  private readonly pendingDeletes = new Set<string>();
  private retryTimer: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(private readonly client: SecurityStateRedisClient) {}

  get<T>(key: string): Promise<T | undefined> {
    return this.run('read', async () => {
      if (await this.finishPendingDelete(key)) return undefined;
      const raw = await this.client.get(key);
      return raw === null ? undefined : (JSON.parse(raw) as T);
    });
  }

  set(key: string, value: unknown, ttlMs: number): Promise<void> {
    return this.run('write', async () => {
      await this.client.set(key, JSON.stringify(value), 'PX', pxOf(ttlMs));
      // The new value replaces whatever the failed delete was to remove.
      this.pendingDeletes.delete(key);
    });
  }

  /**
   * A failed delete stays pending: until it reaches Redis, every read or take of the key on this
   * instance deletes it first (and fails while it cannot), so the old value is never returned
   * here. A timer resends pending deletes every PENDING_DELETE_RETRY_MS, so other instances stop
   * reading the old value soon after Redis is reachable again.
   */
  async del(key: string): Promise<void> {
    try {
      await this.run('delete', async () => {
        await this.client.del(key);
        this.pendingDeletes.delete(key);
      });
    } catch (error: unknown) {
      this.pendingDeletes.add(key);
      this.scheduleDeleteRetry();
      throw error;
    }
  }

  take<T>(key: string): Promise<T | undefined> {
    return this.run('take', async () => {
      if (await this.finishPendingDelete(key)) return undefined;
      const raw = await this.client.eval(TAKE_SCRIPT, 1, key);
      return raw === null || raw === undefined ? undefined : (JSON.parse(String(raw)) as T);
    });
  }

  increment(key: string, windowMs: number): Promise<{ count: number; ttlMs: number }> {
    return this.run('increment', async () => {
      await this.finishPendingDelete(key);
      const [count, ttlMs] = (await this.client.eval(INCREMENT_SCRIPT, 1, key, pxOf(windowMs))) as [
        number,
        number,
      ];
      return { count: Number(count), ttlMs: Number(ttlMs) };
    });
  }

  health(): SecurityStateHealth {
    return {
      status: this.failing ? 'failing' : 'ok',
      backend: 'redis',
      failures: this.failures,
      lastFailureAt: this.lastFailureAt?.toISOString() ?? null,
    };
  }

  async onModuleDestroy(): Promise<void> {
    this.closed = true;
    clearTimeout(this.retryTimer);
    await this.client.quit();
  }

  /** Delete `key` now when an earlier delete of it failed. True when it did so. */
  private async finishPendingDelete(key: string): Promise<boolean> {
    if (!this.pendingDeletes.has(key)) return false;
    await this.client.del(key);
    this.pendingDeletes.delete(key);
    return true;
  }

  private scheduleDeleteRetry(): void {
    if (this.retryTimer || this.closed) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.retryPendingDeletes();
    }, PENDING_DELETE_RETRY_MS);
    this.retryTimer.unref();
  }

  /** Resend pending deletes; stop at the first failure (Redis still down) and try again later. */
  private async retryPendingDeletes(): Promise<void> {
    for (const key of [...this.pendingDeletes]) {
      if (!this.pendingDeletes.has(key)) continue; // a set or read settled it meanwhile
      try {
        await this.client.del(key);
        this.pendingDeletes.delete(key);
      } catch {
        break;
      }
    }
    if (this.pendingDeletes.size > 0) this.scheduleDeleteRetry();
  }

  /** Run `operation`; on any error log it, count it and reject with SecurityStateUnavailableError. */
  private async run<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    try {
      const result = await fn();
      this.failing = false;
      return result;
    } catch (error: unknown) {
      this.failing = true;
      this.failures++;
      this.lastFailureAt = new Date();
      // The key is not logged: it can carry a user id or a client IP.
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Security state ${operation} failed, the check denies: ${message}`);
      throw new SecurityStateUnavailableError();
    }
  }
}

/** Writes between two sweeps of expired entries of the in-process store. */
const MEMORY_SWEEP_EVERY_WRITES = 500;

export class MemorySecurityStateStore implements SecurityStateStore {
  private readonly entries = new Map<string, { json: string; expiresAt: number }>();
  private writesSinceSweep = 0;

  async get<T>(key: string): Promise<T | undefined> {
    return this.read<T>(key);
  }

  async set(key: string, value: unknown, ttlMs: number): Promise<void> {
    this.sweepNow();
    this.entries.set(key, { json: JSON.stringify(value), expiresAt: Date.now() + pxOf(ttlMs) });
  }

  async del(key: string): Promise<void> {
    this.entries.delete(key);
  }

  /** The read and the delete run without an await in between, so no other call interleaves. */
  async take<T>(key: string): Promise<T | undefined> {
    const value = this.read<T>(key);
    this.entries.delete(key);
    return value;
  }

  async increment(key: string, windowMs: number): Promise<{ count: number; ttlMs: number }> {
    this.sweepNow();
    const now = Date.now();
    const entry = this.entries.get(key);
    if (!entry || entry.expiresAt <= now) {
      this.entries.set(key, { json: '1', expiresAt: now + pxOf(windowMs) });
      return { count: 1, ttlMs: pxOf(windowMs) };
    }
    const count = Number(JSON.parse(entry.json)) + 1;
    entry.json = String(count);
    return { count, ttlMs: entry.expiresAt - now };
  }

  health(): SecurityStateHealth {
    return { status: 'ok', backend: 'memory', failures: 0, lastFailureAt: null };
  }

  /** The number of entries held, expired ones not yet swept included. */
  size(): number {
    return this.entries.size;
  }

  /**
   * Every MEMORY_SWEEP_EVERY_WRITES writes, drop the expired entries: an expired key is removed
   * when it is read again, but counters of past windows (one per client IP, per address) are
   * never read again and would pile up in a long-running process.
   */
  private sweepNow(): void {
    if (++this.writesSinceSweep < MEMORY_SWEEP_EVERY_WRITES) return;
    this.writesSinceSweep = 0;
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }

  private read<T>(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return JSON.parse(entry.json) as T;
  }
}
