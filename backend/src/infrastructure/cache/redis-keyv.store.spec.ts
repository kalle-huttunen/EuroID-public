import { RedisKeyvStore, type KeyvRedisClient } from './redis-keyv.store';

describe('RedisKeyvStore', () => {
  let client: jest.Mocked<KeyvRedisClient>;
  let store: RedisKeyvStore;

  beforeEach(() => {
    client = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
      quit: jest.fn().mockResolvedValue('OK'),
    };
    store = new RedisKeyvStore(client, 60_000);
  });

  it('writes each entry with its TTL, or the default TTL when it has none', async () => {
    await store.set('mfa:failed:user-1', '{"value":1}', 900_000);
    await store.set('admincache:user-1', '{"value":2}');

    expect(client.set).toHaveBeenCalledWith('mfa:failed:user-1', '{"value":1}', 'PX', 900_000);
    expect(client.set).toHaveBeenCalledWith('admincache:user-1', '{"value":2}', 'PX', 60_000);
  });

  it('reads a missing key as undefined', async () => {
    await expect(store.get('nothing')).resolves.toBeUndefined();
    client.get.mockResolvedValue('{"value":3}');
    await expect(store.get('something')).resolves.toBe('{"value":3}');
  });

  it('reports whether a delete removed a key', async () => {
    await expect(store.delete('a')).resolves.toBe(true);
    client.del.mockResolvedValue(0);
    await expect(store.delete('a')).resolves.toBe(false);
  });

  it('never flushes the shared Redis on clear', async () => {
    await expect(store.clear()).rejects.toThrow('not supported');
  });
});
