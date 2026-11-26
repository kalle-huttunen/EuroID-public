import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { OpaClientService } from './opa-client.service';

describe('OpaClientService', () => {
  let service: OpaClientService;
  let mockConfigService: Record<string, jest.Mock>;

  beforeEach(async () => {
    mockConfigService = {
      get: jest.fn().mockReturnValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [OpaClientService, { provide: ConfigService, useValue: mockConfigService }],
    }).compile();

    service = module.get(OpaClientService);
  });

  describe('disabled mode', () => {
    it('reports not available when OPA_ENABLED is false', () => {
      expect(service.isAvailable()).toBe(false);
    });

    it('returns null for query when disabled', async () => {
      const result = await service.query({
        user: { email: 'test@example.com' },
        policies: [],
        tenantId: 'test',
      });
      expect(result).toBeNull();
    });

    it('returns false for pushPolicy when disabled', async () => {
      const result = await service.pushPolicy('test', 'package test');
      expect(result).toBe(false);
    });

    it('returns false for pushData when disabled', async () => {
      const result = await service.pushData('test/path', { key: 'value' });
      expect(result).toBe(false);
    });
  });

  describe('shouldFallback', () => {
    it('defaults to true', () => {
      expect(service.shouldFallback()).toBe(true);
    });
  });

  describe('onModuleInit', () => {
    afterEach(() => jest.restoreAllMocks());

    it('skips health check when disabled', async () => {
      const fetchSpy = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('no OPA here'));

      await service.onModuleInit();

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(service.isAvailable()).toBe(false);
    });
  });

  describe('enabled mode', () => {
    const OPA_URL = 'http://opa.test:8181';
    const input = { user: { email: 'test@example.com' }, policies: [], tenantId: 'tenant-a' };
    const operation = {
      type: 'entitlement',
      action: 'grant',
      target: 'entra',
      targetId: 'group-1',
      sourcePolicy: 'policy-1',
    };
    let fetchSpy: jest.SpyInstance;

    /** An enabled client after its health check answered `health` (status, or a network error). */
    async function enabledClient(health: number | Error, settings: Record<string, unknown> = {}) {
      const config: Record<string, unknown> = {
        'opa.OPA_ENABLED': true,
        'opa.OPA_URL': OPA_URL,
        'opa.OPA_REQUEST_TIMEOUT_MS': 1000,
        ...settings,
      };
      const client = new OpaClientService({
        get: (key: string) => config[key],
      } as unknown as ConfigService);
      if (health instanceof Error) fetchSpy.mockRejectedValueOnce(health);
      else fetchSpy.mockResolvedValueOnce(new Response('{}', { status: health }));
      await client.onModuleInit();
      return client;
    }

    const answer = (status: number, body: unknown) =>
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }));

    beforeEach(() => {
      // Every call is answered by the test; none reaches the network.
      fetchSpy = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('unexpected fetch'));
    });

    afterEach(() => {
      jest.useRealTimers();
      jest.restoreAllMocks();
    });

    it('is available once the health check answers 200, and not after a 503 or a network error', async () => {
      expect((await enabledClient(200)).isAvailable()).toBe(true);
      expect(fetchSpy).toHaveBeenCalledWith(`${OPA_URL}/health`, expect.anything());
      expect((await enabledClient(503)).isAvailable()).toBe(false);
      expect((await enabledClient(new Error('ECONNREFUSED'))).isAvailable()).toBe(false);
    });

    it('posts the input to the policy path and returns the operations', async () => {
      const client = await enabledClient(200, { 'opa.OPA_POLICY_PATH': 'euroid/policy/evaluate' });
      answer(200, { result: { operations: [operation] } });

      await expect(client.query(input)).resolves.toEqual({ operations: [operation] });

      const [url, init] = fetchSpy.mock.calls[1];
      expect(url).toBe(`${OPA_URL}/v1/data/euroid/policy/evaluate`);
      expect(init).toMatchObject({ method: 'POST' });
      expect(JSON.parse(init.body)).toEqual({ input });
    });

    it.each<[string, number, unknown]>([
      ['an HTTP error', 500, { error: 'boom' }],
      ['a result without operations', 200, { result: { allow: true } }],
      ['no result (an undefined policy)', 200, {}],
    ])('returns null for %s, so the TypeScript engine decides', async (_case, status, body) => {
      const client = await enabledClient(200, { 'opa.OPA_FALLBACK_ON_ERROR': true });
      answer(status, body);

      await expect(client.query(input)).resolves.toBeNull();
    });

    it('gives up after OPA_REQUEST_TIMEOUT_MS and returns null', async () => {
      const client = await enabledClient(200);
      jest.useFakeTimers();
      fetchSpy.mockImplementationOnce(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) =>
            init.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
          ),
      );

      const result = client.query(input);
      await jest.advanceTimersByTimeAsync(1000);

      await expect(result).resolves.toBeNull();
      expect(client.shouldFallback()).toBe(true);
    });

    it.each<[string, number, unknown, string]>([
      ['an HTTP error', 500, { error: 'boom' }, 'OPA query failed with status 500'],
      [
        'a result without operations',
        200,
        { result: { allow: true } },
        'OPA returned unexpected result shape',
      ],
      ['no result (an undefined policy)', 200, {}, 'OPA returned unexpected result shape'],
    ])('throws for %s when OPA_FALLBACK_ON_ERROR is false', async (_case, status, body, reason) => {
      const client = await enabledClient(200, { 'opa.OPA_FALLBACK_ON_ERROR': false });
      answer(status, body);

      await expect(client.query(input)).rejects.toThrow(`OPA evaluation failed: ${reason}`);
    });

    it('throws on a failed query when OPA_FALLBACK_ON_ERROR is false', async () => {
      const client = await enabledClient(200, { 'opa.OPA_FALLBACK_ON_ERROR': false });
      fetchSpy.mockRejectedValueOnce(new Error('ECONNRESET'));

      expect(client.shouldFallback()).toBe(false);
      await expect(client.query(input)).rejects.toThrow('OPA evaluation failed: ECONNRESET');
    });

    it('returns null without calling OPA when the health check failed', async () => {
      const client = await enabledClient(503);

      await expect(client.query(input)).resolves.toBeNull();
      expect(fetchSpy).toHaveBeenCalledTimes(1); // the health check only
    });
  });
});
