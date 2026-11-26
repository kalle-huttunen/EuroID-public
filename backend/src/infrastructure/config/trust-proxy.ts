/**
 * Express's `trust proxy` from TRUST_PROXY (main.ts): which X-Forwarded-For hops request.ip
 * believes. The IP rate limits (sign-in, break-glass, password reset) key on request.ip, so it
 * must match the deployment: unset trusts one reverse proxy (the documented setup), `false` or
 * `0` trusts none (the API reachable directly: a client cannot choose its address then), a
 * number trusts that many hops, anything else is passed on as Express's list of proxy addresses.
 */
export function trustProxySetting(raw: string | undefined): boolean | number | string {
  const value = raw?.trim();
  if (!value) return 1;
  if (value === 'false' || value === '0') return false;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}
