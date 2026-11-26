import { ApplicationFailure } from '@temporalio/common';
import { HttpStatus } from '@nestjs/common';
import { ConnectorException } from '@shared/exceptions/domain-exceptions';
import { RateLimitedException } from '@shared/errors/rate-limited.exception';
import { httpError } from '@testing/fake-http';
import {
  asDeprovisionFailure,
  DEPROVISION_REJECTED,
  maskEmails,
  maskPersonalData,
} from './deprovision-failure';

describe('asDeprovisionFailure', () => {
  it('fails at once on client errors retrying cannot fix (401, 403, 404, 422, not configured)', () => {
    for (const err of [
      httpError(401),
      httpError(403),
      httpError(404),
      new ConnectorException('not configured'),
      new ConnectorException('ambiguous', HttpStatus.UNPROCESSABLE_ENTITY),
    ]) {
      const failure = asDeprovisionFailure('okta', err) as ApplicationFailure;
      expect(failure).toBeInstanceOf(ApplicationFailure);
      expect(failure.nonRetryable).toBe(true);
      expect(failure.type).toBe(DEPROVISION_REJECTED);
      expect(failure.message).toMatch(/^okta: .*\(HTTP 4\d\d\)$/);
    }
  });

  it('turns a 429 into RateLimitedException with the retry-after', () => {
    const limited = asDeprovisionFailure('okta', httpError(429, { 'retry-after': '7' }));
    expect(limited).toBeInstanceOf(RateLimitedException);
    expect((limited as RateLimitedException).retryAfterMs).toBe(7000);
  });

  it('rethrows server, network and conflict errors for Temporal to retry', () => {
    for (const err of [httpError(500), httpError(409), new Error('socket hang up')]) {
      const out = asDeprovisionFailure('scim', err);
      expect(out).not.toBeInstanceOf(ApplicationFailure);
      expect((out as Error).message).toMatch(/^scim: /);
    }
  });

  it('masks the stack trace of a retried error too: Temporal writes it into history', () => {
    const err = new Error('Graph timed out for ada@acme.test');
    const out = asDeprovisionFailure('entra', err) as Error;
    expect(out.message).toBe('entra: Graph timed out for a•••@acme.test');
    expect(out.stack).not.toContain('ada@acme.test');
    expect(out.stack).toContain('a•••@acme.test');
  });

  // The stack's first line was built after the message changed, so the prefix came twice
  // (FOLLOWUPS 2026-11-24, deprovision-failure.ts)
  it('names the system once in the stack trace when nothing is masked', () => {
    const out = asDeprovisionFailure('ad', new Error('LDAP connection lost')) as Error;

    expect(out.message).toBe('ad: LDAP connection lost');
    expect(out.stack?.split('\n')[0]).toBe('Error: ad: LDAP connection lost');
  });

  it('passes RateLimitedException and ApplicationFailure through unchanged', () => {
    const rate = new RateLimitedException(1000, 'scim');
    const app = ApplicationFailure.nonRetryable('x');
    expect(asDeprovisionFailure('scim', rate)).toBe(rate);
    expect(asDeprovisionFailure('scim', app)).toBe(app);
  });

  it('masks the name in an LDAP DN, and emails, in the message', () => {
    expect(
      maskPersonalData(
        '0000208D: NameErr: no object CN=Ada Lovelace\\, PhD,OU=Users,DC=corp (ada@acme.test)',
      ),
    ).toBe('0000208D: NameErr: no object CN=•••,OU=Users,DC=corp (a•••@acme.test)');
    const out = asDeprovisionFailure('ad', new Error('Insufficient access on uid=ada,ou=people'));
    expect((out as Error).message).toBe('ad: Insufficient access on uid=•••,ou=people');
  });

  it('masks email addresses in the message', () => {
    expect(maskEmails('no user ada.lovelace@acme.test or "bo@x.example"')).toBe(
      'no user a•••@acme.test or "b•••@x.example"',
    );
  });
});
