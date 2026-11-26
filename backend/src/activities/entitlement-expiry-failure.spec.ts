/**
 * Which expired entries a run picks, and how a failed deprovision is recorded: a failure that
 * retrying cannot fix keeps the entry out for good (until its expiresAt changes), a retryable one
 * until its next attempt, an hour after the first failure, doubling up to a day.
 */
import { HttpStatus } from '@nestjs/common';
import { httpError } from '@testing/fake-http';
import { ConnectorException } from '@shared/exceptions/domain-exceptions';
import type { ProvisioningState } from '../modules/identity/schemas/identity.schema';
import {
  EXPIRY_RETRY_BASE_MS,
  EXPIRY_RETRY_MAX_MS,
  failedWith,
  isExpiryDue,
  nextExpiryFailure,
  notDeprovisionable,
  retryDelayMs,
} from './entitlement-expiry-failure';
import { asDeprovisionFailure } from './deprovision-failure';

const HOUR = 60 * 60 * 1000;
const NOW = new Date('2026-11-22T10:00:00.000Z');
const at = (ms: number) => new Date(NOW.getTime() + ms);
const EXPIRED = at(-HOUR);

const entry = (over: Partial<ProvisioningState> = {}): ProvisioningState =>
  ({ targetSystem: 'scim', status: 'SYNCED', expiresAt: EXPIRED, ...over }) as ProvisioningState;

const failure = (over: Partial<NonNullable<ProvisioningState['expiryFailure']>> = {}) => ({
  expiresAt: EXPIRED,
  failedAt: at(-30 * 60 * 1000),
  reason: 'scim: boom',
  retryable: false,
  attempts: 1,
  ...over,
});

describe('entitlement expiry failures', () => {
  it('uses the defaults without ENTITLEMENT_EXPIRY_RETRY_* set', () => {
    expect(EXPIRY_RETRY_BASE_MS).toBe(HOUR);
    expect(EXPIRY_RETRY_MAX_MS).toBe(24 * HOUR);
  });

  describe('isExpiryDue', () => {
    it('picks an expired entry with no failure recorded', () => {
      expect(isExpiryDue(entry(), NOW)).toBe(true);
      expect(isExpiryDue(entry({ expiresAt: NOW }), NOW)).toBe(true);
    });

    it('leaves out entries not expired, without expiry or already DEPROVISIONED', () => {
      expect(isExpiryDue(entry({ expiresAt: at(1) }), NOW)).toBe(false);
      expect(isExpiryDue(entry({ expiresAt: undefined }), NOW)).toBe(false);
      expect(isExpiryDue(entry({ status: 'DEPROVISIONED' }), NOW)).toBe(false);
    });

    it('leaves out an entry whose failure for this expiresAt is not retryable', () => {
      expect(isExpiryDue(entry({ expiryFailure: failure() }), NOW)).toBe(false);
      expect(isExpiryDue(entry({ expiryFailure: failure() }), at(30 * 24 * HOUR))).toBe(false);
    });

    it('picks a retryable failure again once its next attempt is due', () => {
      const e = entry({ expiryFailure: failure({ retryable: true, nextAttemptAt: at(HOUR) }) });
      expect(isExpiryDue(e, NOW)).toBe(false);
      expect(isExpiryDue(e, at(HOUR - 1))).toBe(false);
      expect(isExpiryDue(e, at(HOUR))).toBe(true);
    });

    it('ignores a failure recorded for another expiresAt (the expiry date changed)', () => {
      const e = entry({ expiryFailure: failure({ expiresAt: at(-48 * HOUR) }) });
      expect(isExpiryDue(e, NOW)).toBe(true);
    });
  });

  describe('retryDelayMs', () => {
    it('waits an hour after the first failure, doubling up to a day', () => {
      expect([1, 2, 3, 4, 5, 6, 7, 100].map((n) => retryDelayMs(n) / HOUR)).toEqual([
        1, 2, 4, 8, 16, 24, 24, 24,
      ]);
    });
  });

  describe('nextExpiryFailure', () => {
    const failedAt = at(5 * 1000);

    it('a retryable failure counts the attempts for this expiresAt and backs off', () => {
      const first = nextExpiryFailure(
        entry(),
        { deprovisioned: false, reason: 'scim: 503', retryable: true },
        NOW,
        failedAt,
      );
      expect(first).toEqual({
        expiresAt: EXPIRED,
        failedAt,
        reason: 'scim: 503',
        retryable: true,
        attempts: 1,
        nextAttemptAt: at(HOUR),
      });

      const third = nextExpiryFailure(
        entry({ expiryFailure: failure({ retryable: true, attempts: 2 }) }),
        { deprovisioned: false, reason: 'scim: 503', retryable: true },
        NOW,
        failedAt,
      );
      expect(third.attempts).toBe(3);
      expect(third.nextAttemptAt).toEqual(at(4 * HOUR));
    });

    it('a failure that retrying cannot fix gets no next attempt', () => {
      const record = nextExpiryFailure(entry(), notDeprovisionable('okta: unsupported'), NOW, NOW);
      expect(record.retryable).toBe(false);
      expect(record).not.toHaveProperty('nextAttemptAt');
    });

    it('starts counting again for a new expiresAt', () => {
      const record = nextExpiryFailure(
        entry({ expiryFailure: failure({ expiresAt: at(-48 * HOUR), attempts: 5 }) }),
        { deprovisioned: false, reason: 'scim: 503', retryable: true },
        NOW,
        NOW,
      );
      expect(record.attempts).toBe(1);
      expect(record.nextAttemptAt).toEqual(at(HOUR));
    });
  });

  // What a deprovision activity throws: its error passed through asDeprovisionFailure
  describe('failedWith', () => {
    it('client errors are not retryable, as in offboarding', () => {
      for (const err of [
        httpError(401),
        httpError(403),
        httpError(404),
        new ConnectorException('ambiguous', HttpStatus.UNPROCESSABLE_ENTITY),
      ]) {
        const out = failedWith(asDeprovisionFailure('scim', err));
        expect(out).toMatchObject({ deprovisioned: false, retryable: false });
        expect(out.reason).toMatch(/^scim: .*\(HTTP 4\d\d\)$/);
      }
    });

    it('5xx, 429, network and LDAP errors are retryable', () => {
      for (const err of [
        httpError(503),
        httpError(429, { 'retry-after': '5' }),
        Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
        new Error('LDAP: busy'),
      ]) {
        expect(failedWith(asDeprovisionFailure('ad', err))).toMatchObject({
          deprovisioned: false,
          retryable: true,
        });
      }
    });

    it('names the target once', () => {
      expect(failedWith(asDeprovisionFailure('scim', httpError(503))).reason).toBe(
        'scim: Request failed with status code 503',
      );
    });

    it('masks emails and DN names in the reason', () => {
      const out = failedWith(
        asDeprovisionFailure('ad', new Error('Insufficient access on CN=Ada Lovelace,OU=People')),
      );
      expect(out.reason).toBe('ad: Insufficient access on CN=•••,OU=People');
      expect(failedWith(new Error('okta: no user ada@acme.test')).reason).toBe(
        'okta: no user a•••@acme.test',
      );
      expect(notDeprovisionable('scim: no account for ada@acme.test').reason).toBe(
        'scim: no account for a•••@acme.test',
      );
    });
  });
});
