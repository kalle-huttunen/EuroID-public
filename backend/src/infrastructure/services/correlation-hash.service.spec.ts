/**
 * National ID hashing (CorrelationHashService). Without a usable CORRELATION_HMAC_SECRET the
 * service hashed with a fixed key that is in the source code and the same for every tenant, so a
 * stored correlationId could be reversed by trying every HETU. It now refuses to hash.
 */
import { createHmac } from 'crypto';
import { Logger } from '@nestjs/common';
import { CorrelationHashService } from './correlation-hash.service';

const SECRET = 'correlation-secret-for-tests-0123456789';
const HETU = '131085-999X';

/** HMAC(HMAC(secret, tenantId), normalized value), computed here apart from the service. */
function expectedHash(secret: string, tenantId: string, normalized: string): string {
  const tenantKey = createHmac('sha256', secret).update(tenantId).digest();
  return createHmac('sha256', tenantKey).update(normalized).digest('hex');
}

describe('CorrelationHashService', () => {
  const original = process.env.CORRELATION_HMAC_SECRET;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
    if (original === undefined) delete process.env.CORRELATION_HMAC_SECRET;
    else process.env.CORRELATION_HMAC_SECRET = original;
  });

  describe('without a usable secret', () => {
    it('produces no hash when the secret is not set', () => {
      delete process.env.CORRELATION_HMAC_SECRET;

      expect(new CorrelationHashService().hash(HETU, 'tenant-a')).toBeNull();
    });

    it('produces no hash when the secret is shorter than 16 characters', () => {
      process.env.CORRELATION_HMAC_SECRET = 'x'.repeat(15);

      expect(new CorrelationHashService().hash(HETU, 'tenant-a')).toBeNull();
    });

    it('warns once per service, naming the variable and saying the values are dropped', () => {
      delete process.env.CORRELATION_HMAC_SECRET;
      const service = new CorrelationHashService();

      service.hash(HETU, 'tenant-a');
      service.hash('010101-123N', 'tenant-b');

      expect(warn).toHaveBeenCalledTimes(1);
      const message = String(warn.mock.calls[0][0]);
      expect(message).toContain('CORRELATION_HMAC_SECRET');
      expect(message).toMatch(/national ID correlation is off/);
      expect(message).toMatch(/dropped without being hashed/);
    });
  });

  describe('with a secret', () => {
    beforeEach(() => {
      process.env.CORRELATION_HMAC_SECRET = SECRET;
    });

    it('is the HMAC of the normalized value under the tenant key HMAC(secret, tenantId)', () => {
      expect(new CorrelationHashService().hash(HETU, 'tenant-a')).toBe(
        expectedHash(SECRET, 'tenant-a', '131085999X'),
      );
      expect(warn).not.toHaveBeenCalled();
    });

    it('gives one hash for the same HETU written differently', () => {
      const service = new CorrelationHashService();

      expect(service.hash(' 131085999x ', 'tenant-a')).toBe(service.hash(HETU, 'tenant-a'));
      expect(service.hash('131085 999X', 'tenant-a')).toBe(service.hash(HETU, 'tenant-a'));
    });

    it('gives two tenants different hashes for the same HETU', () => {
      const service = new CorrelationHashService();

      expect(service.hash(HETU, 'tenant-a')).not.toBe(service.hash(HETU, 'tenant-b'));
    });
  });
});
