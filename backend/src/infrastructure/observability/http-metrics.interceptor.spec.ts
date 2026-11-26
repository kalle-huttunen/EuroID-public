/**
 * HttpMetricsInterceptor counts a request when its response is sent, with the status code the
 * response got. A handler's exception passes the interceptor while the response still has
 * Express's default 200; the exception filter sets the real status after it
 * (http-metrics.interceptor.http.spec.ts runs this through a Nest application).
 */
import { EventEmitter } from 'events';
import { HttpMetricsInterceptor } from './http-metrics.interceptor';
import { MetricsService } from './metrics.service';
import { ExecutionContext, CallHandler } from '@nestjs/common';
import { lastValueFrom, of, throwError } from 'rxjs';

describe('HttpMetricsInterceptor', () => {
  let interceptor: HttpMetricsInterceptor;
  let metrics: MetricsService;

  beforeEach(() => {
    metrics = new MetricsService();
    interceptor = new HttpMetricsInterceptor(metrics);
  });

  afterEach(() => {
    metrics.registry.clear();
  });

  /** An Express response as far as the interceptor reads it: status code and `finish`. */
  type MockResponse = EventEmitter & { statusCode: number };

  function mockContext(
    method: string,
    routePath: string,
    type: 'http' | 'ws' = 'http',
  ): { context: ExecutionContext; handler: CallHandler; res: MockResponse } {
    const req = { method, route: { path: routePath }, path: routePath };
    const res = Object.assign(new EventEmitter(), { statusCode: 200 });
    const context = {
      getType: () => type,
      switchToHttp: () => ({
        getRequest: () => req,
        getResponse: () => res,
      }),
    } as unknown as ExecutionContext;
    const handler = { handle: () => of({ ok: true }) } as CallHandler;
    return { context, handler, res };
  }

  /** The requests counted and the durations observed, per label set. */
  async function recorded() {
    const count = (await metrics.httpRequestsTotal.get()).values;
    const observed = (await metrics.httpRequestDuration.get()).values.filter(
      (v) => v.metricName === 'euroid_http_request_duration_ms_count',
    );
    return { count, observed };
  }

  it('records HTTP request duration and count on success', async () => {
    const { context, handler, res } = mockContext('GET', '/api/v1/identity');

    await lastValueFrom(interceptor.intercept(context, handler));
    res.emit('finish');

    const labels = { method: 'GET', route: '/api/v1/identity', status_code: '200' };
    const { count, observed } = await recorded();
    expect(count).toEqual([expect.objectContaining({ labels, value: 1 })]);
    expect(observed).toEqual([expect.objectContaining({ labels, value: 1 })]);
  });

  it('records an error response with the status the exception filter set', async () => {
    const { context, res } = mockContext('POST', '/api/v1/policy');
    const handler = { handle: () => throwError(() => new Error('fail')) } as CallHandler;

    await expect(lastValueFrom(interceptor.intercept(context, handler))).rejects.toThrow('fail');
    // Still Express's default when the error passes; then the filter answers 404
    expect((await recorded()).count).toEqual([]);
    res.statusCode = 404;
    res.emit('finish');

    const labels = { method: 'POST', route: '/api/v1/policy', status_code: '404' };
    const { count, observed } = await recorded();
    expect(count).toEqual([expect.objectContaining({ labels, value: 1 })]);
    expect(observed).toEqual([expect.objectContaining({ labels, value: 1 })]);
  });

  it('skips non-HTTP contexts', (done) => {
    const { context, handler } = mockContext('GET', '/events', 'ws');

    interceptor.intercept(context, handler).subscribe({
      complete: async () => {
        const metricsDump = await metrics.registry.getMetricsAsJSON();
        const countMetric = metricsDump.find((m) => m.name === 'euroid_http_requests_total');
        // No values should have been recorded
        expect(countMetric?.values?.length ?? 0).toBe(0);
        done();
      },
    });
  });
});
