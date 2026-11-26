/**
 * Module-level token store for axios interceptors.
 * Auth providers (OIDC or Dev) call setAccessToken when auth state changes.
 * Axios interceptors use getAccessToken() - they cannot access React context.
 */
let token: string | null = null;
let refreshToken: string | null = null;
let tenantId: string | null = null;
let on401: (() => void | Promise<void>) | null = null;

export const setAccessToken = (t: string | null) => {
  token = t;
};

export const getAccessToken = () => token;

export const setRefreshToken = (t: string | null) => {
  refreshToken = t;
};

export const getRefreshToken = () => refreshToken;

export const setTenantId = (id: string | null) => {
  tenantId = id;
};

export const getTenantId = () => tenantId;

export const setOn401 = (callback: (() => void | Promise<void>) | null) => {
  on401 = callback;
};

export const getOn401 = () => on401;

/** Clear all tokens from in-memory store (used on logout). */
export const clearTokens = () => {
  token = null;
  refreshToken = null;
  tenantId = null;
};
