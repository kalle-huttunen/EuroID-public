import axios from 'axios';
import { API_BASE } from './constants';
import {
  getAccessToken,
  getRefreshToken,
  getOn401,
  getTenantId,
  setAccessToken,
  setRefreshToken,
} from '../auth/token-store';

/** Shared axios instance. baseURL is empty because callers build full paths
 * (e.g. /api/v1/identity) via API_BASE — setting baseURL here would cause
 * doubled /api/v1/api/v1/... URLs.
 * FA-1: withCredentials sends httpOnly auth cookies automatically. */
export const axiosInstance = axios.create({
  baseURL: '',
  withCredentials: true,
});

axiosInstance.interceptors.request.use((config) => {
  // FA-1: Prefer Bearer header when token in memory (API clients); browser uses cookies via withCredentials
  const token = getAccessToken();
  if (token && config.headers) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  const tenantId = getTenantId();
  if (tenantId && config.headers) {
    config.headers['X-Tenant-Id'] = tenantId;
  }
  return config;
});

/**
 * Sign-in calls made without a session: their 401 is a refused credential (a wrong password or
 * code, a used SAML code), so there is no session to refresh and nobody to sign out.
 */
const SIGN_IN_PATHS = ['/auth/login', '/auth/mfa/challenge', '/auth/saml/exchange'].map(
  (path) => `${API_BASE}${path}`,
);

let isRefreshing = false;
let refreshQueue: Array<{
  resolve: (token: string | null) => void;
  reject: (err: unknown) => void;
}> = [];

function processQueue(error: unknown, token: string | null) {
  for (const { resolve, reject } of refreshQueue) {
    if (error) reject(error);
    else resolve(token);
  }
  refreshQueue = [];
}

axiosInstance.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;
    if (
      error.response?.status !== 401 ||
      originalRequest?._retry ||
      SIGN_IN_PATHS.includes(originalRequest?.url)
    ) {
      return Promise.reject(error);
    }

    // Try refresh: cookie (FA-1) or in-memory refresh token (API clients)
    const currentRefresh = getRefreshToken();
    if (isRefreshing) {
      return new Promise((resolve, reject) => {
        refreshQueue.push({
          resolve: (token: string | null) => {
            if (token && originalRequest.headers) {
              originalRequest.headers.Authorization = `Bearer ${token}`;
            }
            originalRequest._retry = true;
            resolve(axiosInstance.request(originalRequest));
          },
          reject,
        });
      });
    }

    isRefreshing = true;
    originalRequest._retry = true;

    try {
      const { data } = await axios.post(
        `${API_BASE}/auth/refresh`,
        currentRefresh ? { refresh_token: currentRefresh } : {},
        { timeout: 5000, withCredentials: true },
      );
      if (data.access_token) {
        setAccessToken(data.access_token);
        setRefreshToken(data.refresh_token ?? null);
      }
      processQueue(null, data.access_token ?? null);
      if (data.access_token && originalRequest.headers) {
        originalRequest.headers.Authorization = `Bearer ${data.access_token}`;
      }
      return axiosInstance.request(originalRequest);
    } catch (refreshError) {
      processQueue(refreshError, null);
      setAccessToken(null);
      setRefreshToken(null);
      // Fall through to on401 handler
    } finally {
      isRefreshing = false;
    }

    // Fallback to OIDC silent renewal or redirect
    const on401 = getOn401();
    if (on401) {
      try {
        await on401();
        const newToken = getAccessToken();
        if (newToken && originalRequest) {
          originalRequest._retry = true;
          return axiosInstance.request(originalRequest);
        }
      } catch {
        // Silent renewal failed, callback may have redirected to login
      }
    }
    return Promise.reject(error);
  },
);
