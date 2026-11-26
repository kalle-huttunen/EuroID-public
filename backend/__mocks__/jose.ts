/**
 * Mock for jose (ESM-only) to avoid Jest parse errors in tests that transitively import it.
 * Provides functional stubs for jwtVerify, createRemoteJWKSet, SignJWT.
 *
 * SignJWT produces real-ish JWTs (base64-encoded header.payload.signature) so tests
 * that inspect token structure (3-segment split) work correctly. jwtVerify decodes
 * the payload from tokens produced by this mock.
 */

import { createHmac } from 'crypto';

function base64url(input: string | Buffer): string {
  const buf = typeof input === 'string' ? Buffer.from(input) : input;
  return buf.toString('base64url');
}

class MockSignJWT {
  private payload: Record<string, unknown>;
  private header: Record<string, unknown> = { alg: 'HS256', typ: 'JWT' };

  constructor(payload: Record<string, unknown>) {
    this.payload = { ...payload };
  }

  setProtectedHeader(header: Record<string, unknown>): this {
    this.header = { ...this.header, ...header };
    return this;
  }

  setIssuedAt(): this {
    this.payload.iat = Math.floor(Date.now() / 1000);
    return this;
  }

  setExpirationTime(exp: string): this {
    const now = Math.floor(Date.now() / 1000);
    const match = exp.match(/^(\d+)([smhd])$/);
    if (match) {
      const multipliers: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
      this.payload.exp = now + parseInt(match[1]) * (multipliers[match[2]] || 3600);
    } else {
      this.payload.exp = now + 3600;
    }
    return this;
  }

  setIssuer(issuer: string): this {
    this.payload.iss = issuer;
    return this;
  }

  setSubject(subject: string): this {
    this.payload.sub = subject;
    return this;
  }

  setAudience(audience: string | string[]): this {
    this.payload.aud = audience;
    return this;
  }

  async sign(secret: Uint8Array): Promise<string> {
    const headerB64 = base64url(JSON.stringify(this.header));
    const payloadB64 = base64url(JSON.stringify(this.payload));
    const data = `${headerB64}.${payloadB64}`;
    const sig = createHmac('sha256', Buffer.from(secret)).update(data).digest();
    return `${data}.${base64url(sig)}`;
  }
}

export const SignJWT = MockSignJWT;

export const jwtVerify = jest.fn(async (token: string, secret: Uint8Array, options?: { issuer?: string; audience?: string | string[] }) => {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid token format');

  const headerB64 = parts[0];
  const payloadB64 = parts[1];
  const sigB64 = parts[2];

  // Verify signature
  const data = `${headerB64}.${payloadB64}`;
  const expectedSig = createHmac('sha256', Buffer.from(secret)).update(data).digest('base64url');
  if (sigB64 !== expectedSig) {
    const err = new Error('signature verification failed');
    (err as unknown as Record<string, unknown>).code = 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED';
    throw err;
  }

  const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());

  // Check issuer if specified
  if (options?.issuer && payload.iss !== options.issuer) {
    const err = new Error(`unexpected "iss" claim value`);
    (err as unknown as Record<string, unknown>).code = 'ERR_JWT_CLAIM_VALIDATION_FAILED';
    throw err;
  }

  // Check audience if specified
  if (options?.audience) {
    const expected = Array.isArray(options.audience) ? options.audience : [options.audience];
    const actual = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : [];
    const hasMatch = actual.some((a: string) => expected.includes(a));
    if (!hasMatch) {
      const err = new Error(`unexpected "aud" claim value`);
      (err as unknown as Record<string, unknown>).code = 'ERR_JWT_CLAIM_VALIDATION_FAILED';
      throw err;
    }
  }

  return { payload, protectedHeader: JSON.parse(Buffer.from(headerB64, 'base64url').toString()) };
});

export const createRemoteJWKSet = jest.fn(() => ({}));
