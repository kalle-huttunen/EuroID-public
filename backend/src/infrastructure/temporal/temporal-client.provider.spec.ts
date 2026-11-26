/**
 * An API started while Temporal was down got no client until a restart: PAM deactivation and
 * sweeps, offboarding starts and orphan signals all failed. The provider now reconnects on use,
 * at most once per backoff delay (TEMPORAL_RECONNECT_MIN_MS doubling up to
 * TEMPORAL_RECONNECT_MAX_MS), and keeps its synchronous getClient()/isConnected() contract.
 */
import { Connection, Client } from '@temporalio/client';
import { TemporalClientProvider } from './temporal-client.provider';
import type { EncryptionService } from '../secrets/encryption.service';

jest.mock('@temporalio/client', () => ({
  Connection: { connect: jest.fn() },
  Client: jest.fn().mockImplementation(() => ({ kind: 'client' })),
}));

jest.mock('./temporal-payload-codec', () => ({ temporalDataConverter: () => ({}) }));

const connect = Connection.connect as unknown as jest.Mock;
const encryption = {} as EncryptionService;

/** Let the background connect attempt settle. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('TemporalClientProvider reconnect', () => {
  let now: jest.SpyInstance;
  const saved = { ...process.env };

  beforeEach(() => {
    connect.mockReset();
    (Client as unknown as jest.Mock).mockClear();
    now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    process.env.TEMPORAL_RECONNECT_MIN_MS = '1000';
    process.env.TEMPORAL_RECONNECT_MAX_MS = '4000';
  });

  afterEach(() => {
    now.mockRestore();
    process.env = { ...saved };
  });

  it('connects on use once Temporal is up, after a start while it was down', async () => {
    connect.mockRejectedValueOnce(new Error('ECONNREFUSED')).mockResolvedValue({});
    const provider = new TemporalClientProvider(encryption);
    await provider.onModuleInit();
    expect(provider.isConnected()).toBe(false);
    expect(() => provider.getClient()).toThrow(/not connected/);

    now.mockReturnValue(1_001_000);
    // The use that finds the backoff over starts one attempt in the background.
    expect(provider.isConnected()).toBe(false);
    await settle();

    expect(provider.isConnected()).toBe(true);
    expect(provider.getClient()).toEqual({ kind: 'client' });
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('tries again no sooner than the backoff, doubling it up to the maximum', async () => {
    connect.mockRejectedValue(new Error('ECONNREFUSED'));
    const provider = new TemporalClientProvider(encryption);
    await provider.onModuleInit(); // attempt 1 fails: next in 1 s
    expect(connect).toHaveBeenCalledTimes(1);

    now.mockReturnValue(1_000_999);
    provider.isConnected();
    expect(connect).toHaveBeenCalledTimes(1);

    now.mockReturnValue(1_001_000);
    expect(() => provider.getClient()).toThrow(/not connected/);
    await settle(); // attempt 2 fails: next in 2 s
    expect(connect).toHaveBeenCalledTimes(2);

    now.mockReturnValue(1_002_999);
    provider.isConnected();
    expect(connect).toHaveBeenCalledTimes(2);
    now.mockReturnValue(1_003_000);
    provider.isConnected();
    await settle(); // attempt 3 fails: next in 4 s
    expect(connect).toHaveBeenCalledTimes(3);

    now.mockReturnValue(1_006_999);
    provider.isConnected();
    expect(connect).toHaveBeenCalledTimes(3);
    now.mockReturnValue(1_007_000);
    provider.isConnected();
    await settle(); // attempt 4 fails: capped at 4 s
    now.mockReturnValue(1_011_000);
    provider.isConnected();
    await settle();
    expect(connect).toHaveBeenCalledTimes(5);
  });

  it('runs one attempt at a time however many callers find no client', async () => {
    let resolveConnect: (value: unknown) => void = () => undefined;
    connect
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockImplementationOnce(() => new Promise((resolve) => (resolveConnect = resolve)));
    const provider = new TemporalClientProvider(encryption);
    await provider.onModuleInit();

    now.mockReturnValue(1_005_000);
    provider.isConnected();
    provider.isConnected();
    expect(() => provider.getClient()).toThrow(/not connected/);
    expect(connect).toHaveBeenCalledTimes(2);

    resolveConnect({});
    await settle();
    expect(provider.isConnected()).toBe(true);
  });
});
