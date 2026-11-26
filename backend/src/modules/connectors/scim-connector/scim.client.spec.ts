import { SCIMClient } from './scim.client';
import { SCIMConnectorConfig } from './scim.interface';
import { SCIM_SCHEMAS, SCIM_CONTENT_TYPE } from '@shared/scim';
import axios from 'axios';

// Mock axios at module level
jest.mock('axios');

// Mock SSRF guard to avoid DNS resolution in tests
jest.mock('@infrastructure/url-validation/ssrf-guard', () => ({
  ...jest.requireActual('@infrastructure/url-validation/ssrf-guard'),
  validateUrlForFetch: jest.fn().mockResolvedValue(undefined),
}));
const mockedAxios = axios as jest.MockedFunction<typeof axios>;
const mockedAxiosPost = axios.post as jest.MockedFunction<typeof axios.post>;

const cacheStore = new Map<string, unknown>();
const mockCache = {
  get: jest.fn((key: string) => Promise.resolve(cacheStore.get(key))),
  set: jest.fn((key: string, value: unknown) => {
    cacheStore.set(key, value);
    return Promise.resolve();
  }),
  del: jest.fn((key: string) => {
    cacheStore.delete(key);
    return Promise.resolve();
  }),
};

const mockCircuitBreaker = {
  execute: jest.fn((_connector: string, fn: () => Promise<unknown>) => fn()),
};

describe('SCIMClient', () => {
  let client: SCIMClient;
  const bearerConfig: SCIMConnectorConfig = {
    baseUrl: 'https://api.example.com/scim/v2',
    authType: 'bearer',
    bearerToken: 'test-token-abc123',
  };

  const basicConfig: SCIMConnectorConfig = {
    baseUrl: 'https://api.example.com/scim/v2',
    authType: 'basic',
    username: 'admin',
    password: 'secret',
  };

  const oauth2Config: SCIMConnectorConfig = {
    baseUrl: 'https://api.example.com/scim/v2',
    authType: 'oauth2',
    oauth2TokenUrl: 'https://auth.example.com/oauth/token',
    clientId: 'my-client-id',
    clientSecret: 'my-client-secret',
  };

  beforeEach(() => {
    cacheStore.clear();
    client = new SCIMClient(mockCache as any, mockCircuitBreaker as any);
    jest.clearAllMocks();
    mockCache.get.mockImplementation((key: string) => Promise.resolve(cacheStore.get(key)));
    mockCache.set.mockImplementation((key: string, value: unknown) => {
      cacheStore.set(key, value);
      return Promise.resolve();
    });
    mockCircuitBreaker.execute.mockImplementation((_c: string, fn: () => Promise<unknown>) => fn());
  });

  // ───────── Auth Headers ─────────

  describe('Bearer auth', () => {
    it('should send correct Authorization header', async () => {
      mockedAxios.mockResolvedValueOnce({
        status: 200,
        data: { schemas: [SCIM_SCHEMAS.USER], id: 'user-1', userName: 'john@test.com' },
      });

      await client.getUser(bearerConfig, 'user-1');

      expect(mockedAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer test-token-abc123',
          }),
        }),
      );
    });
  });

  // Hunt 2026-11-25 (r2-01 N4): one breaker for every tenant's SCIM target let one tenant's
  // unreachable server or refused client secret block every tenant
  describe('circuit breaker', () => {
    it('keeps the breaker per token URL and per base URL', async () => {
      mockedAxiosPost.mockResolvedValueOnce({ data: { access_token: 't', expires_in: 3600 } });
      mockedAxios.mockResolvedValueOnce({ status: 200, data: { id: 'user-1' } });

      await client.getUser(oauth2Config, 'user-1');

      expect(mockCircuitBreaker.execute.mock.calls.map((c) => [c[0], (c as unknown[])[2]])).toEqual(
        [
          ['scim', 'https://auth.example.com/oauth/token'],
          ['scim', 'https://api.example.com/scim/v2'],
        ],
      );
    });
  });

  describe('Basic auth', () => {
    it('should send correct Authorization header', async () => {
      const expectedBasic = `Basic ${Buffer.from('admin:secret').toString('base64')}`;

      mockedAxios.mockResolvedValueOnce({
        status: 200,
        data: { schemas: [SCIM_SCHEMAS.USER], id: 'user-1', userName: 'john@test.com' },
      });

      await client.getUser(basicConfig, 'user-1');

      expect(mockedAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: expectedBasic,
          }),
        }),
      );
    });
  });

  describe('OAuth2 auth', () => {
    it('should fetch token and send Bearer header', async () => {
      // First call: token endpoint
      mockedAxiosPost.mockResolvedValueOnce({
        data: { access_token: 'oauth-token-xyz', expires_in: 3600 },
      });

      // Second call: actual SCIM API
      mockedAxios.mockResolvedValueOnce({
        status: 200,
        data: { schemas: [SCIM_SCHEMAS.USER], id: 'user-1', userName: 'john@test.com' },
      });

      await client.getUser(oauth2Config, 'user-1');

      // Token endpoint called
      expect(mockedAxiosPost).toHaveBeenCalledWith(
        'https://auth.example.com/oauth/token',
        expect.any(URLSearchParams),
        expect.objectContaining({
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        }),
      );

      // SCIM API called with OAuth token
      expect(mockedAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer oauth-token-xyz',
          }),
        }),
      );
    });

    // Hunt 2026-11-25 (r2-01 N7): invalidateToken had no caller, so a revoked or rotated token
    // stayed cached and every call failed 401 until its TTL ended (up to an hour)
    it('drops a cached token the server refuses, and retries once with a new one', async () => {
      mockedAxiosPost
        .mockResolvedValueOnce({ data: { access_token: 'revoked-token', expires_in: 3600 } })
        .mockResolvedValueOnce({ data: { access_token: 'fresh-token', expires_in: 3600 } });
      mockedAxios
        .mockResolvedValueOnce({ status: 401, data: { detail: 'token revoked' } })
        .mockResolvedValueOnce({ status: 200, data: { id: 'u1' } });

      await expect(client.getUser(oauth2Config, 'u1')).resolves.toEqual({ id: 'u1' });

      const bearers = mockedAxios.mock.calls.map(
        ([req]) => (req as unknown as { headers: Record<string, string> }).headers.Authorization,
      );
      expect(bearers).toEqual(['Bearer revoked-token', 'Bearer fresh-token']);
    });

    it('retries a 401 once only, and never for a bearer token', async () => {
      mockedAxiosPost.mockResolvedValue({ data: { access_token: 't', expires_in: 3600 } });
      mockedAxios.mockResolvedValue({ status: 401, data: { detail: 'no' } });

      await expect(client.getUser(oauth2Config, 'u1')).rejects.toMatchObject({ scimStatus: '401' });
      expect(mockedAxios).toHaveBeenCalledTimes(2);

      mockedAxios.mockClear();
      await expect(client.getUser(bearerConfig, 'u1')).rejects.toMatchObject({ scimStatus: '401' });
      expect(mockedAxios).toHaveBeenCalledTimes(1);
    });

    it('should cache OAuth2 token and reuse it', async () => {
      // First call: token + API
      mockedAxiosPost.mockResolvedValueOnce({
        data: { access_token: 'cached-token', expires_in: 3600 },
      });
      mockedAxios.mockResolvedValueOnce({ status: 200, data: { id: 'u1' } });
      await client.getUser(oauth2Config, 'u1');

      // Second call: should reuse cached token (no second token fetch)
      mockedAxios.mockResolvedValueOnce({ status: 200, data: { id: 'u2' } });
      await client.getUser(oauth2Config, 'u2');

      // Token endpoint called only once
      expect(mockedAxiosPost).toHaveBeenCalledTimes(1);
    });

    it("never gives a config another config's token: base URL and client id are not secret", async () => {
      mockedAxiosPost
        .mockResolvedValueOnce({ data: { access_token: 'token-of-owner', expires_in: 3600 } })
        .mockResolvedValueOnce({ data: { access_token: 'token-of-other', expires_in: 3600 } });
      mockedAxios.mockResolvedValue({ status: 200, data: { id: 'u1' } });

      await client.getUser(oauth2Config, 'u1');
      await client.getUser({ ...oauth2Config, clientSecret: 'guessed-secret' }, 'u1');

      expect(mockedAxiosPost).toHaveBeenCalledTimes(2);
      const bearers = mockedAxios.mock.calls.map(
        ([req]) => (req as unknown as { headers: Record<string, string> }).headers.Authorization,
      );
      expect(bearers).toEqual(['Bearer token-of-owner', 'Bearer token-of-other']);
      expect([...cacheStore.keys()].join()).not.toContain('my-client-secret');
    });

    // A token another endpoint issued (a health check on form values may name any token URL)
    // must never be used for the saved config
    it('never gives a config the token another token URL issued', async () => {
      mockedAxiosPost
        .mockResolvedValueOnce({ data: { access_token: 'token-of-other-idp', expires_in: 3600 } })
        .mockResolvedValueOnce({ data: { access_token: 'token-of-idp', expires_in: 3600 } });
      mockedAxios.mockResolvedValue({ status: 200, data: { id: 'u1' } });

      await client.getUser(
        { ...oauth2Config, oauth2TokenUrl: 'https://other.example.com/token' },
        'u1',
      );
      await client.getUser(oauth2Config, 'u1');

      expect(mockedAxiosPost.mock.calls.map(([url]) => url)).toEqual([
        'https://other.example.com/token',
        'https://auth.example.com/oauth/token',
      ]);
      const bearers = mockedAxios.mock.calls.map(
        ([req]) => (req as unknown as { headers: Record<string, string> }).headers.Authorization,
      );
      expect(bearers).toEqual(['Bearer token-of-other-idp', 'Bearer token-of-idp']);
    });

    it('invalidateToken drops the token of that config', async () => {
      mockedAxiosPost.mockResolvedValue({ data: { access_token: 'tok', expires_in: 3600 } });
      mockedAxios.mockResolvedValue({ status: 200, data: { id: 'u1' } });
      await client.getUser(oauth2Config, 'u1');
      expect(cacheStore.size).toBe(1);

      await client.invalidateToken(oauth2Config);

      expect(cacheStore.size).toBe(0);
    });
  });

  // ───────── Content-Type ─────────

  describe('Content-Type', () => {
    it('should send application/scim+json content type', async () => {
      mockedAxios.mockResolvedValueOnce({ status: 200, data: {} });

      await client.getUser(bearerConfig, 'user-1');

      expect(mockedAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: expect.objectContaining({
            'Content-Type': SCIM_CONTENT_TYPE,
          }),
        }),
      );
    });

    it('should accept both scim+json and json', async () => {
      mockedAxios.mockResolvedValueOnce({ status: 200, data: {} });

      await client.getUser(bearerConfig, 'user-1');

      expect(mockedAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: expect.objectContaining({
            Accept: 'application/scim+json, application/json',
          }),
        }),
      );
    });
  });

  // ───────── CRUD Operations ─────────

  describe('createUser', () => {
    it('should POST to /Users', async () => {
      const scimUser = {
        schemas: [SCIM_SCHEMAS.USER],
        userName: 'new@test.com',
        name: { givenName: 'New', familyName: 'User' },
      };

      mockedAxios.mockResolvedValueOnce({
        status: 201,
        data: { ...scimUser, id: 'created-id-123' },
      });

      const result = await client.createUser(bearerConfig, scimUser);

      expect(mockedAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'POST',
          url: 'https://api.example.com/scim/v2/Users',
          data: scimUser,
        }),
      );
      expect(result.id).toBe('created-id-123');
    });
  });

  describe('listUsers', () => {
    it('should GET /Users with filter params', async () => {
      mockedAxios.mockResolvedValueOnce({
        status: 200,
        data: {
          schemas: [SCIM_SCHEMAS.LIST_RESPONSE],
          totalResults: 1,
          startIndex: 1,
          itemsPerPage: 1,
          Resources: [{ id: 'u1', userName: 'john@test.com' }],
        },
      });

      const result = await client.listUsers(bearerConfig, 'userName eq "john@test.com"', 1, 10);

      expect(mockedAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'GET',
          url: expect.stringContaining('filter=userName+eq+%22john%40test.com%22'),
        }),
      );
      expect(result.totalResults).toBe(1);
      expect(result.Resources).toHaveLength(1);
    });
  });

  describe('deleteUser', () => {
    it('should DELETE /Users/:id', async () => {
      mockedAxios.mockResolvedValueOnce({ status: 204, data: null });

      await client.deleteUser(bearerConfig, 'user-to-delete');

      expect(mockedAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'DELETE',
          url: 'https://api.example.com/scim/v2/Users/user-to-delete',
        }),
      );
    });
  });

  describe('patchUser', () => {
    it('should PATCH /Users/:id with operations', async () => {
      const patchOp = {
        schemas: [SCIM_SCHEMAS.PATCH_OP],
        Operations: [{ op: 'replace' as const, path: 'active', value: false }],
      };

      mockedAxios.mockResolvedValueOnce({
        status: 200,
        data: { id: 'user-1', active: false },
      });

      await client.patchUser(bearerConfig, 'user-1', patchOp);

      expect(mockedAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'PATCH',
          url: 'https://api.example.com/scim/v2/Users/user-1',
          data: patchOp,
        }),
      );
    });
  });

  // ───────── Error Handling ─────────

  describe('error handling', () => {
    it('should throw SCIMError on SCIM error response', async () => {
      mockedAxios.mockResolvedValueOnce({
        status: 409,
        data: {
          schemas: [SCIM_SCHEMAS.ERROR],
          scimType: 'uniqueness',
          detail: 'User already exists',
          status: '409',
        },
      });

      await expect(
        client.createUser(bearerConfig, {
          schemas: [SCIM_SCHEMAS.USER],
          userName: 'dup@test.com',
        }),
      ).rejects.toThrow('User already exists');
    });

    it('should handle non-SCIM error response', async () => {
      mockedAxios.mockResolvedValueOnce({
        status: 500,
        data: { message: 'Internal Server Error' },
      });

      await expect(client.getUser(bearerConfig, 'bad-id')).rejects.toThrow();
    });

    it('should throw when bearer token is missing', async () => {
      const badConfig = { ...bearerConfig, bearerToken: undefined };

      await expect(client.getUser(badConfig as SCIMConnectorConfig, 'user-1')).rejects.toThrow(
        'SCIM bearer token is required',
      );
    });

    it('should throw when basic auth credentials are missing', async () => {
      const badConfig = { ...basicConfig, username: undefined };

      await expect(client.getUser(badConfig as SCIMConnectorConfig, 'user-1')).rejects.toThrow(
        'SCIM basic auth credentials are required',
      );
    });

    it('should throw RateLimitedException on 429 with Retry-After header', async () => {
      const { RateLimitedException } = await import('@shared/errors/rate-limited.exception');

      mockedAxios.mockResolvedValueOnce({
        status: 429,
        headers: { 'retry-after': '30' },
        data: { detail: 'Too Many Requests' },
      });

      const err = (await client.getUser(bearerConfig, 'user-1').catch((e) => e)) as InstanceType<
        typeof RateLimitedException
      >;
      expect(err).toBeInstanceOf(RateLimitedException);
      expect(err.retryAfterMs).toBe(30_000);
      expect(err.system).toBe('scim');
    });

    it('should default to 60s when 429 has no Retry-After', async () => {
      const { RateLimitedException } = await import('@shared/errors/rate-limited.exception');

      mockedAxios.mockResolvedValueOnce({
        status: 429,
        headers: {},
        data: {},
      });

      const err = (await client.getUser(bearerConfig, 'user-1').catch((e) => e)) as InstanceType<
        typeof RateLimitedException
      >;
      expect(err).toBeInstanceOf(RateLimitedException);
      expect(err.retryAfterMs).toBe(60_000);
    });
  });

  // ───────── Health Check ─────────

  describe('healthCheck', () => {
    it('should return true when ServiceProviderConfig responds', async () => {
      mockedAxios.mockResolvedValueOnce({
        status: 200,
        data: { schemas: [SCIM_SCHEMAS.SERVICE_PROVIDER_CONFIG] },
      });

      const result = await client.healthCheck(bearerConfig);
      expect(result).toBe(true);
    });

    it('should return false when ServiceProviderConfig fails', async () => {
      mockedAxios.mockResolvedValueOnce({
        status: 500,
        data: { schemas: [SCIM_SCHEMAS.ERROR], detail: 'Server error', status: '500' },
      });

      const result = await client.healthCheck(bearerConfig);
      expect(result).toBe(false);
    });
  });
});
