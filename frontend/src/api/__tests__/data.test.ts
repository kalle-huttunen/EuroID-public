import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import axios, { type InternalAxiosRequestConfig } from 'axios';
import * as tokenStore from '../../auth/token-store';
import { axiosInstance } from '../data';

vi.mock('axios', async () => {
  const actual = await vi.importActual<typeof axios>('axios');
  const mockPost = vi.fn();
  const mockAdapter = (config: { _retry?: boolean; headers?: Record<string, string> }) => {
    if (!config._retry) {
      return Promise.reject({
        response: { status: 401 },
        config: { ...config, headers: config.headers || {} },
      });
    }
    return Promise.resolve({ data: { ok: true }, status: 200, config });
  };
  return {
    default: {
      ...actual,
      create: (config?: Record<string, unknown>) => {
        const instance = actual.default.create(config);
        instance.defaults.adapter = mockAdapter as never;
        return instance;
      },
      post: mockPost,
    },
  };
});

const mockAxiosPost = vi.mocked(axios.post);

describe('API data.ts - Axios interceptor token refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(tokenStore, 'getRefreshToken').mockReturnValue('refresh-token-123');
    vi.spyOn(tokenStore, 'setAccessToken');
    vi.spyOn(tokenStore, 'setRefreshToken');
    vi.spyOn(tokenStore, 'getOn401').mockReturnValue(null);
    vi.spyOn(tokenStore, 'getAccessToken').mockReturnValue(null);
    vi.spyOn(tokenStore, 'getTenantId').mockReturnValue(null);
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('401 triggers token refresh and retries request', async () => {
    mockAxiosPost.mockResolvedValue({
      data: { access_token: 'new-access', refresh_token: 'new-refresh' },
      status: 200,
    } as never);

    const result = await axiosInstance.get('/api/v1/identity');

    expect(mockAxiosPost).toHaveBeenCalledWith(
      expect.stringContaining('/auth/refresh'),
      { refresh_token: 'refresh-token-123' },
      expect.objectContaining({ timeout: 5000 }),
    );
    expect(tokenStore.setAccessToken).toHaveBeenCalledWith('new-access');
    expect(tokenStore.setRefreshToken).toHaveBeenCalledWith('new-refresh');
    expect(result.data).toEqual({ ok: true });
  });

  it('concurrent 401s queue and resolve after single refresh', async () => {
    mockAxiosPost.mockResolvedValue({
      data: { access_token: 'new-access', refresh_token: 'new-refresh' },
      status: 200,
    } as never);

    const [res1, res2] = await Promise.all([
      axiosInstance.get('/api/v1/identity'),
      axiosInstance.get('/api/v1/identity'),
    ]);

    expect(mockAxiosPost).toHaveBeenCalledTimes(1);
    expect(res1.data).toEqual({ ok: true });
    expect(res2.data).toEqual({ ok: true });
  });

  // r2-09 N5: a refused sign-in is a wrong password, not an expired session.
  it.each(['/api/v1/auth/login', '/api/v1/auth/mfa/challenge', '/api/v1/auth/saml/exchange'])(
    'passes a 401 of %s to the caller without a refresh or the sign-out handler',
    async (path) => {
      const on401 = vi.fn();
      vi.mocked(tokenStore.getOn401).mockReturnValue(on401);

      await expect(axiosInstance.post(path, {})).rejects.toMatchObject({
        response: { status: 401 },
      });

      expect(mockAxiosPost).not.toHaveBeenCalled();
      expect(on401).not.toHaveBeenCalled();
    },
  );

  it('failed refresh clears tokens', async () => {
    mockAxiosPost.mockRejectedValue(new Error('Refresh failed'));

    await expect(axiosInstance.get('/api/v1/identity')).rejects.toMatchObject({
      response: { status: 401 },
    });

    expect(tokenStore.setAccessToken).toHaveBeenCalledWith(null);
    expect(tokenStore.setRefreshToken).toHaveBeenCalledWith(null);
    expect(localStorage.getItem('euroid_token')).toBeNull();
    expect(localStorage.getItem('euroid_refresh_token')).toBeNull();
  });
});

describe('API data.ts - request headers', () => {
  beforeEach(() => tokenStore.clearTokens());
  afterEach(() => tokenStore.clearTokens());

  /** Headers of one GET as the request interceptor leaves them; answered without the network. */
  async function headersSent() {
    let sent: InternalAxiosRequestConfig | undefined;
    await axiosInstance.get('/api/v1/identity', {
      adapter: async (config) => {
        sent = config;
        return { data: {}, status: 200, statusText: 'OK', headers: {}, config };
      },
    });
    return sent!.headers;
  }

  it('sends the access token as a Bearer header and the tenant as X-Tenant-Id', async () => {
    tokenStore.setAccessToken('access-123');
    tokenStore.setTenantId('tenant-a');

    const headers = await headersSent();

    expect(headers.Authorization).toBe('Bearer access-123');
    expect(headers['X-Tenant-Id']).toBe('tenant-a');
  });

  it('sends neither header while no token or tenant is set', async () => {
    const headers = await headersSent();

    expect(headers.Authorization).toBeUndefined();
    expect(headers['X-Tenant-Id']).toBeUndefined();
  });
});
