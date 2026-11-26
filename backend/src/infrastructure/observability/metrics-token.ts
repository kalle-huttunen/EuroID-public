import { createHash, timingSafeEqual } from 'crypto';

/**
 * Whether the Authorization header of a GET /metrics carries METRICS_TOKEN as a bearer token,
 * compared in constant time (SHA-256 digests, so the length is not compared either).
 */
export function metricsTokenMatches(authorization: unknown, token: string): boolean {
  if (typeof authorization !== 'string') return false;
  const provided = authorization.replace(/^Bearer\s+/i, '');
  if (!provided || provided === authorization) return false;
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(provided), digest(token));
}
