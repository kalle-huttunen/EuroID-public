/**
 * The connector circuit breaker opens on a target that is down, and only for the tenant and
 * target that failed (real cockatiel, mocked metrics and events).
 *
 * Hunt 2026-11-25 (01 F2, r2-01 N4): one breaker per connector name for the whole process
 * counted every thrown error. Five free UPNs in a row (Graph 404), five 429s, or one tenant's
 * wrong client secret opened Entra ID (or SCIM) for every tenant for 30 s. Now a breaker is
 * per tenant, connector and target, and only a 5xx answer or no answer at all counts.
 */
import { AxiosError, AxiosHeaders } from 'axios';
import { NotFoundException, ConflictException, HttpStatus } from '@nestjs/common';
import { BrokenCircuitError } from 'cockatiel';
import { ConnectorException } from '@shared/exceptions/domain-exceptions';
import { RateLimitedException } from '@shared/errors/rate-limited.exception';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { ConnectorCircuitBreakerService } from './connector-circuit-breaker';
import type { DomainEventEmitterService } from '../events/event-emitter.service';
import type { MetricsService } from '../observability/metrics.service';

function axiosError(status?: number): AxiosError {
  const config = { headers: new AxiosHeaders() };
  return new AxiosError(
    'request failed',
    status === undefined ? 'ECONNREFUSED' : 'ERR_BAD_RESPONSE',
    config,
    undefined,
    status === undefined ? undefined : { status, statusText: '', headers: {}, config, data: {} },
  );
}

describe('ConnectorCircuitBreakerService', () => {
  let breaker: ConnectorCircuitBreakerService;

  beforeEach(() => {
    breaker = new ConnectorCircuitBreakerService(
      { emit: jest.fn() } as unknown as DomainEventEmitterService,
      {
        circuitBreakerTripsTotal: { inc: jest.fn() },
        circuitBreakerState: { set: jest.fn() },
      } as unknown as MetricsService,
    );
  });

  const failTimes = async (n: number, error: unknown, target = 'graph-a', tenant = 'tenant-a') => {
    for (let i = 0; i < n; i++) {
      await withTenantContext(tenant, () =>
        breaker.execute('entra-id', () => Promise.reject(error), target),
      ).catch(() => undefined);
    }
  };
  const call = (target = 'graph-a', tenant = 'tenant-a') =>
    withTenantContext(tenant, () => breaker.execute('entra-id', async () => 'ok', target));

  it.each([
    ['a 404', new NotFoundException('Resource not found')],
    ['a 409', new ConflictException('Resource conflict')],
    ['a 400', new ConnectorException('bad request', HttpStatus.BAD_REQUEST)],
    ['a 429', new RateLimitedException(1000, 'entra-id')],
    ['an axios 401', axiosError(401)],
  ])('stays closed after many failures that are %s', async (_label, error) => {
    await failTimes(8, error);
    await expect(call()).resolves.toBe('ok');
  });

  it.each([
    ['a 502 from the target', new ConnectorException('upstream', HttpStatus.BAD_GATEWAY)],
    ['an axios 503', axiosError(503)],
    ['no answer', axiosError()],
  ])('opens after five failures that are %s', async (_label, error) => {
    await failTimes(5, error);
    await expect(call()).rejects.toBeInstanceOf(BrokenCircuitError);
  });

  it("keeps another tenant's calls to the same connector going", async () => {
    await failTimes(5, axiosError());
    await expect(call('graph-a', 'tenant-b')).resolves.toBe('ok');
  });

  it('keeps calls to another target of the same tenant going', async () => {
    await failTimes(5, axiosError());
    await expect(call('graph-b')).resolves.toBe('ok');
  });
});
