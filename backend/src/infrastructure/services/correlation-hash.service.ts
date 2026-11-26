/**
 * CorrelationHashService — HMAC-SHA256 hashing for national IDs (HETU, SSN)
 *
 * Deterministic hashing (same input → same output) for correlation lookups.
 * Tenant-scoped key derivation ensures cross-tenant isolation.
 * Raw PII is never stored — only the hash (correlationId) is persisted.
 *
 * The key comes from CORRELATION_HMAC_SECRET (at least 16 characters). Without it nothing is
 * hashed: there is no fallback key, and the caller drops the national ID unhashed
 * (identity/national-id.ts). The functions below are the whole algorithm; the
 * strip-raw-national-id migration uses them too.
 */

import { Injectable, Logger } from '@nestjs/common';
import { createHmac } from 'crypto';

const HMAC_ALGORITHM = 'sha256';

/** The environment variable holding the master secret. */
export const CORRELATION_SECRET_VAR = 'CORRELATION_HMAC_SECRET';
/** A shorter secret is refused like a missing one. */
export const MIN_CORRELATION_SECRET_LENGTH = 16;

/** The master secret when it is usable, else null (national ID correlation is off). */
export function correlationSecret(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const secret = env[CORRELATION_SECRET_VAR];
  return secret && secret.length >= MIN_CORRELATION_SECRET_LENGTH ? secret : null;
}

/**
 * Derive tenant-scoped HMAC key from master secret.
 * HMAC_KEY = HMAC(MASTER_SECRET, tenantId)
 */
export function tenantCorrelationKey(secret: string, tenantId: string): Buffer {
  const hmac = createHmac(HMAC_ALGORITHM, secret);
  hmac.update(tenantId);
  return hmac.digest();
}

/**
 * Normalize input: trim, uppercase, remove hyphens/spaces.
 * HETU 131085-999X → 131085999X
 */
export function normalizeNationalId(raw: string): string {
  return (raw || '').trim().toUpperCase().replace(/[- ]/g, '');
}

/** HMAC-SHA256 hex digest of the normalized value under `key`. */
export function nationalIdDigest(key: Buffer, rawValue: string): string {
  const hmac = createHmac(HMAC_ALGORITHM, key);
  hmac.update(normalizeNationalId(rawValue));
  return hmac.digest('hex');
}

@Injectable()
export class CorrelationHashService {
  private readonly logger = new Logger(CorrelationHashService.name);
  private disabledReported = false;

  /**
   * Hash a raw value (e.g. national ID) for correlation lookups.
   * Deterministic: same input + tenantId → same output.
   * @param rawValue Raw national ID (HETU, SSN, etc.)
   * @param tenantId Tenant for key derivation (isolation)
   * @returns 64-char hex digest, or null when CORRELATION_HMAC_SECRET is not usable
   */
  hash(rawValue: string, tenantId: string): string | null {
    const secret = correlationSecret();
    if (!secret) {
      this.reportDisabled();
      return null;
    }
    return nationalIdDigest(tenantCorrelationKey(secret, tenantId), rawValue);
  }

  /** Once per process (the service is a singleton): what a missing secret means. */
  private reportDisabled(): void {
    if (this.disabledReported) return;
    this.disabledReported = true;
    this.logger.warn(
      `[CorrelationHash] ${CORRELATION_SECRET_VAR} is not set or is shorter than ` +
        `${MIN_CORRELATION_SECRET_LENGTH} characters: national ID correlation is off, and ` +
        'national ID values are dropped without being hashed',
    );
  }
}
