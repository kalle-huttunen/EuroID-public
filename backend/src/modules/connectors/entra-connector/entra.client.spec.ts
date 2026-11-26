/**
 * Unit tests for EntraClient: 429 rate limit handling, the status other Graph failures get
 * (5xx and network errors retryable, 4xx not), the same for the token request (an outage of the
 * token endpoint retryable, refused credentials not), a config with an empty credential rejected
 * instead of completed from ENTRA_*, and tokens cached per config (tenant, client id and secret),
 * so one config's token never authenticates another config's call.
 */
import { Test } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { EntraClient } from './entra.client';
import { ConnectorCircuitBreakerService } from '@infrastructure/resilience/connector-circuit-breaker';
import { RateLimitedException } from '@shared/errors/rate-limited.exception';
import { ConnectorException } from '@shared/exceptions/domain-exceptions';
import { ApplicationFailure } from '@temporalio/common';
import { asDeprovisionFailure, httpStatusOf } from '../../../activities/deprovision-failure';
import type { Cache } from 'cache-manager';
import type { EntraConfig } from './entra.interface';
import axios from 'axios';

jest.mock('axios', () => {
  const actual = jest.requireActual<typeof import('axios')>('axios');
  const mockGet = jest.fn();
  const mockPost = jest.fn();
  const mock = Object.assign(jest.fn(), {
    get: mockGet,
    post: mockPost,
    isAxiosError: actual.isAxiosError,
  });
  (mock as any)._mockGet = mockGet;
  (mock as any)._mockPost = mockPost;
  return { __esModule: true, default: mock };
});
const mockedAxios = axios as jest.Mocked<typeof axios> & {
  _mockGet: jest.Mock;
  _mockPost: jest.Mock;
};

describe('EntraClient', () => {
  let client: EntraClient;

  beforeEach(async () => {
    mockedAxios._mockGet.mockReset();
    mockedAxios._mockPost.mockReset();
    const configService = {
      get: jest.fn().mockImplementation((key: string) => {
        const map: Record<string, string> = {
          ENTRA_TENANT_ID: 'tenant',
          ENTRA_CLIENT_ID: 'client',
          ENTRA_CLIENT_SECRET: 'secret',
        };
        return map[key];
      }),
    };

    const mockCircuitBreaker = {
      execute: jest.fn((_connector: string, fn: () => Promise<unknown>) => fn()),
    };

    const module = await Test.createTestingModule({
      providers: [
        EntraClient,
        { provide: ConfigService, useValue: configService },
        {
          provide: CACHE_MANAGER,
          useValue: {
            get: jest.fn().mockResolvedValue(undefined),
            set: jest.fn().mockResolvedValue(undefined),
            del: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: ConnectorCircuitBreakerService, useValue: mockCircuitBreaker },
      ],
    }).compile();

    client = module.get(EntraClient);
    jest.clearAllMocks();
  });

  describe('429 rate limit handling', () => {
    it('should throw RateLimitedException on 429 with Retry-After header', async () => {
      mockedAxios._mockPost.mockResolvedValueOnce({
        data: { access_token: 'token', expires_in: 3600 },
      });
      mockedAxios._mockGet.mockRejectedValueOnce({
        isAxiosError: true,
        response: {
          status: 429,
          headers: { 'retry-after': '30' },
          data: { error: { message: 'Too Many Requests' } },
        },
      });

      const err = (await client.get('/users', undefined).catch((e) => e)) as RateLimitedException;
      expect(err).toBeInstanceOf(RateLimitedException);
      expect(err.retryAfterMs).toBe(30_000);
      expect(err.system).toBe('entra-id');
    });

    it('should default to 60s when Retry-After is missing', async () => {
      mockedAxios._mockPost.mockResolvedValueOnce({
        data: { access_token: 'token', expires_in: 3600 },
      });
      mockedAxios._mockGet.mockRejectedValueOnce({
        isAxiosError: true,
        response: {
          status: 429,
          headers: {},
          data: {},
        },
      });

      const err = (await client.get('/users', undefined).catch((e) => e)) as RateLimitedException;
      expect(err).toBeInstanceOf(RateLimitedException);
      expect(err.retryAfterMs).toBe(60_000);
    });
  });

  describe('other Graph failures', () => {
    const failGet = async (error: object) => {
      mockedAxios._mockPost.mockResolvedValueOnce({
        data: { access_token: 'token', expires_in: 3600 },
      });
      mockedAxios._mockGet.mockRejectedValueOnce({ isAxiosError: true, ...error });
      return client.get('/users/u-1', undefined).catch((e: unknown) => e);
    };

    it.each([
      ['a 503 answer', { response: { status: 503, data: { error: { code: 'Unavailable' } } } }],
      ['a 500 answer', { response: { status: 500, data: {} } }],
      ['no answer (network error)', { message: 'socket hang up' }],
    ])('reports %s as 502, which offboarding retries', async (_case, error) => {
      const err = await failGet(error);

      expect(err).toBeInstanceOf(ConnectorException);
      expect(httpStatusOf(err)).toBe(502);
      // The offboarding classification: retried per CONNECTOR_RETRY, not failed at once
      expect(asDeprovisionFailure('entra-id', err)).not.toBeInstanceOf(ApplicationFailure);
    });

    it('reports a 4xx client error as 400, which offboarding fails at once', async () => {
      const err = await failGet({
        response: { status: 403, data: { error: { code: 'Authorization_RequestDenied' } } },
      });

      expect(err).toBeInstanceOf(ConnectorException);
      expect(httpStatusOf(err)).toBe(400);
      expect((err as Error).message).toContain('HTTP 403');
      const failure = asDeprovisionFailure('entra-id', err);
      expect(failure).toBeInstanceOf(ApplicationFailure);
      expect((failure as ApplicationFailure).nonRetryable).toBe(true);
    });
  });

  describe('token endpoint failures', () => {
    const failToken = async (error: object) => {
      mockedAxios._mockPost.mockRejectedValueOnce({ isAxiosError: true, ...error });
      return client.get('/users/u-1', undefined).catch((e: unknown) => e);
    };

    it.each([
      ['a 503 answer', { response: { status: 503, data: { error: 'temporarily_unavailable' } } }],
      ['a 500 answer', { response: { status: 500, data: {} } }],
      ['no answer (network error)', { message: 'connect ECONNREFUSED' }],
    ])('reports %s as 502, which offboarding retries', async (_case, error) => {
      const err = await failToken(error);

      expect(err).toBeInstanceOf(ConnectorException);
      expect(httpStatusOf(err)).toBe(502);
      expect(asDeprovisionFailure('entra-id', err)).not.toBeInstanceOf(ApplicationFailure);
      expect(mockedAxios._mockGet).not.toHaveBeenCalled();
    });

    it('waits the retry-after of a 429 from the token endpoint', async () => {
      const err = await failToken({
        response: { status: 429, headers: { 'retry-after': '5' }, data: {} },
      });

      expect(err).toBeInstanceOf(RateLimitedException);
      expect((err as RateLimitedException).retryAfterMs).toBe(5_000);
    });

    it.each([
      ['400 (unknown tenant or client)', 400, 'invalid_request'],
      ['401 (wrong secret)', 401, 'invalid_client'],
    ])(
      'reports refused credentials, %s, as 401, which offboarding fails at once',
      async (_c, status, code) => {
        const err = await failToken({ response: { status, data: { error: code } } });

        expect(err).toBeInstanceOf(UnauthorizedException);
        expect(httpStatusOf(err)).toBe(401);
        const failure = asDeprovisionFailure('entra-id', err);
        expect(failure).toBeInstanceOf(ApplicationFailure);
        expect((failure as ApplicationFailure).nonRetryable).toBe(true);
      },
    );

    it('passes a non-HTTP failure (the circuit breaker open) through unchanged', async () => {
      const open = new Error('Execution prevented because the circuit breaker is open');
      mockedAxios._mockPost.mockRejectedValueOnce(open);

      await expect(client.get('/users/u-1', undefined)).rejects.toBe(open);
    });
  });

  describe('incomplete config', () => {
    const complete: EntraConfig = {
      tenantId: 'tenant-x',
      clientId: 'app-x',
      clientSecret: 'secret-x',
    };

    const incomplete: Array<[string, Partial<EntraConfig>, string]> = [
      ['client secret', { clientSecret: '' }, 'clientSecret'],
      ['client id', { clientId: '' }, 'clientId'],
      ['tenant id', { tenantId: '   ' }, 'tenantId'],
      ['all three', { tenantId: '', clientId: '', clientSecret: '' }, 'tenantId, clientId'],
    ];

    it.each(incomplete)(
      'rejects a config with an empty %s as a configuration error, never filled in from ENTRA_*',
      async (_case, overrides, named) => {
        const err = await client
          .get('/users/u-1', { ...complete, ...overrides })
          .catch((e: unknown) => e);

        expect(err).toBeInstanceOf(ConnectorException);
        expect(httpStatusOf(err)).toBe(400);
        expect((err as Error).message).toContain(named);
        // Not retried, and no token was requested with any mix of the config and ENTRA_*
        const failure = asDeprovisionFailure('entra-id', err);
        expect((failure as ApplicationFailure).nonRetryable).toBe(true);
        expect(mockedAxios._mockPost).not.toHaveBeenCalled();
      },
    );

    it('keeps ENTRA_* for calls without a config', async () => {
      mockedAxios._mockPost.mockResolvedValueOnce({
        data: { access_token: 'token', expires_in: 3600 },
      });
      mockedAxios._mockGet.mockResolvedValueOnce({ data: { id: 'u-1' } });

      await expect(client.get('/users/u-1', undefined)).resolves.toEqual({ id: 'u-1' });
      expect(mockedAxios._mockPost.mock.calls[0][0]).toMatch(/\/tenant\/oauth2\/v2\.0\/token$/);
    });
  });

  describe('token cache per config', () => {
    const config = (overrides: Partial<EntraConfig>): EntraConfig => ({
      tenantId: 'tenant-x',
      clientId: 'app-x',
      clientSecret: 'secret-x',
      ...overrides,
    });

    /** A client on a working in-memory cache; the token endpoint names the credentials it got. */
    function clientWithCache() {
      const store = new Map<string, unknown>();
      const cache = {
        get: jest.fn(async (key: string) => store.get(key)),
        set: jest.fn(async (key: string, value: unknown) => void store.set(key, value)),
        del: jest.fn(async (key: string) => void store.delete(key)),
      };
      const env: Record<string, string> = {
        ENTRA_TENANT_ID: 'tenant-env',
        ENTRA_CLIENT_ID: 'app-env',
        ENTRA_CLIENT_SECRET: 'secret-env',
      };
      const c = new EntraClient(
        { get: (key: string) => env[key] } as unknown as ConfigService,
        cache as unknown as Cache,
        {
          execute: (_n: string, fn: () => Promise<unknown>) => fn(),
        } as unknown as ConnectorCircuitBreakerService,
      );
      mockedAxios._mockPost.mockImplementation(async (url: string, form: URLSearchParams) => ({
        data: {
          access_token: `${url.split('/').slice(-4)[0]}|${form.get('client_id')}|${form.get('client_secret')}`,
          expires_in: 3600,
        },
      }));
      mockedAxios._mockGet.mockResolvedValue({ data: {} });
      return { client: c, store };
    }

    const bearerOfCall = (n: number) =>
      (mockedAxios._mockGet.mock.calls[n][1] as { headers: Record<string, string> }).headers
        .Authorization;

    it('authenticates each call with the credentials of its own config', async () => {
      const { client: c } = clientWithCache();

      await c.get('/a', config({}));
      await c.get('/b', config({ clientId: 'app-y', clientSecret: 'secret-y' }));
      await c.get('/c', config({ tenantId: 'tenant-z' }));
      await c.get('/d', undefined);

      expect([0, 1, 2, 3].map(bearerOfCall)).toEqual([
        'Bearer tenant-x|app-x|secret-x',
        'Bearer tenant-x|app-y|secret-y',
        'Bearer tenant-z|app-x|secret-x',
        'Bearer tenant-env|app-env|secret-env',
      ]);
      expect(mockedAxios._mockPost).toHaveBeenCalledTimes(4);
    });

    it('reuses a cached token only for the same tenant, client id and secret', async () => {
      const { client: c } = clientWithCache();

      await c.get('/a', config({}));
      await c.get('/b', config({}));
      // Tenant and client ids are not secret: knowing them must not borrow the cached token
      await c.get('/c', config({ clientSecret: 'guessed' }));

      expect(mockedAxios._mockPost).toHaveBeenCalledTimes(2);
      expect([0, 1, 2].map(bearerOfCall)).toEqual([
        'Bearer tenant-x|app-x|secret-x',
        'Bearer tenant-x|app-x|secret-x',
        'Bearer tenant-x|app-x|guessed',
      ]);
    });

    it('keeps the client secret out of the cache keys', async () => {
      const { client: c, store } = clientWithCache();

      await c.get('/a', config({ clientSecret: 'super-secret-value' }));

      const keys = [...store.keys()];
      expect(keys).toHaveLength(1);
      expect(keys[0]).toMatch(/^oauth:entra:tenant-x:app-x:[0-9a-f]{64}$/);
      expect(keys[0]).not.toContain('super-secret-value');
      expect(c.credentialScope(config({ clientSecret: 'super-secret-value' }))).not.toContain(
        'super-secret-value',
      );
    });
  });

  // The next page's URL comes from Graph's answer (@odata.nextLink): the SSRF guard checks it
  // before the token or the page is requested
  describe('a next-page URL', () => {
    it.each([
      'https://169.254.169.254/v1.0/users?$skiptoken=x',
      'http://graph.microsoft.com/v1.0/users',
    ])('refuses %s before any request', async (url) => {
      await expect(client.getByUrl(url, undefined)).rejects.toThrow(/blocked|Only HTTPS/);
      expect(mockedAxios._mockPost).not.toHaveBeenCalled();
      expect(mockedAxios._mockGet).not.toHaveBeenCalled();
    });
  });

  // Hunt 2026-11-25 (01 F2): one breaker for every tenant's Entra ID let one directory's outage
  // (or a run of 404s) block every other; the breaker now counts per directory and app
  describe('the circuit breaker', () => {
    it("runs the token request and the call under the breaker of the config's directory and app", async () => {
      const execute = jest.fn((_n: string, fn: () => Promise<unknown>, _target?: string) => fn());
      const c = new EntraClient(
        { get: () => undefined } as unknown as ConfigService,
        {
          get: jest.fn().mockResolvedValue(undefined),
          set: jest.fn().mockResolvedValue(undefined),
        } as unknown as Cache,
        { execute } as unknown as ConnectorCircuitBreakerService,
      );
      mockedAxios._mockPost.mockResolvedValueOnce({
        data: { access_token: 't', expires_in: 3600 },
      });
      mockedAxios._mockGet.mockResolvedValueOnce({ data: {} });

      await c.get('/users', {
        tenantId: 'dir-1',
        clientId: 'app-1',
        clientSecret: 'never-a-key',
      } as EntraConfig);

      expect(execute.mock.calls.map((call) => [call[0], call[2]])).toEqual([
        ['entra-id', 'dir-1:app-1'],
        ['entra-id', 'dir-1:app-1'],
      ]);
    });
  });
});
