import {
  MemoryOwnedLockStore,
  RedisOwnedLockStore,
  type LockRedisClient,
} from './owned-lock.store';

describe('MemoryOwnedLockStore', () => {
  let locks: MemoryOwnedLockStore;

  beforeEach(() => {
    locks = new MemoryOwnedLockStore();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('gives the lock to one owner and reports that owner to the others', async () => {
    await expect(locks.acquire('user-1', 'tx-a', 1000)).resolves.toBe('tx-a');
    await expect(locks.acquire('user-1', 'tx-b', 1000)).resolves.toBe('tx-a');
  });

  it('lets the owner take its own lock again (a retried activity)', async () => {
    await locks.acquire('user-1', 'tx-a', 1000);
    await expect(locks.acquire('user-1', 'tx-a', 1000)).resolves.toBe('tx-a');
  });

  it('a second release by the owner releases nothing', async () => {
    await locks.acquire('user-1', 'tx-a', 1000);

    await expect(locks.release('user-1', 'tx-a')).resolves.toBe(true);
    await expect(locks.release('user-1', 'tx-a')).resolves.toBe(false);
  });

  it("a late release by the previous owner keeps the new owner's lock", async () => {
    await locks.acquire('user-1', 'tx-a', 1000);
    await locks.release('user-1', 'tx-a');
    await locks.acquire('user-1', 'tx-b', 1000);

    await expect(locks.release('user-1', 'tx-a')).resolves.toBe(false);
    await expect(locks.acquire('user-1', 'tx-c', 1000)).resolves.toBe('tx-b');
  });

  it("never releases another owner's lock", async () => {
    await locks.acquire('user-1', 'tx-a', 1000);

    await expect(locks.release('user-1', 'tx-b')).resolves.toBe(false);
    await expect(locks.acquire('user-1', 'tx-b', 1000)).resolves.toBe('tx-a');
  });

  it('lets another owner take an expired lock, which the old owner can no longer release', async () => {
    jest.useFakeTimers();
    await locks.acquire('user-1', 'tx-a', 1000);
    jest.advanceTimersByTime(1001);

    await expect(locks.acquire('user-1', 'tx-b', 1000)).resolves.toBe('tx-b');
    await expect(locks.release('user-1', 'tx-a')).resolves.toBe(false);
    await expect(locks.release('user-1', 'tx-b')).resolves.toBe(true);
  });
});

describe('RedisOwnedLockStore', () => {
  const client = { eval: jest.fn(), quit: jest.fn() };
  const store = new RedisOwnedLockStore(client as LockRedisClient);

  beforeEach(() => {
    client.eval.mockReset();
    client.quit.mockReset().mockResolvedValue('OK');
  });

  it('takes the lock in one script that sets it only when free or already ours', async () => {
    client.eval.mockResolvedValue('tx-b');

    await expect(store.acquire('disttx:lock:entra-id:u', 'tx-a', 300000)).resolves.toBe('tx-b');

    const [script, numKeys, key, owner, ttl] = client.eval.mock.calls[0];
    expect([numKeys, key, owner, ttl]).toEqual([1, 'disttx:lock:entra-id:u', 'tx-a', 300000]);
    expect(script).toContain("redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])");
    expect(script).toContain('if holder == ARGV[1] then');
  });

  it('deletes the lock in one script only when the owner matches', async () => {
    client.eval.mockResolvedValueOnce(1).mockResolvedValueOnce(0);

    await expect(store.release('disttx:lock:entra-id:u', 'tx-a')).resolves.toBe(true);
    await expect(store.release('disttx:lock:entra-id:u', 'tx-a')).resolves.toBe(false);

    const [script, numKeys, key, owner] = client.eval.mock.calls[0];
    expect([numKeys, key, owner]).toEqual([1, 'disttx:lock:entra-id:u', 'tx-a']);
    expect(script).toContain("if redis.call('GET', KEYS[1]) == ARGV[1] then");
    expect(script).toContain("return redis.call('DEL', KEYS[1])");
  });

  it('closes the client on shutdown', async () => {
    await store.onModuleDestroy();
    expect(client.quit).toHaveBeenCalled();
  });
});
