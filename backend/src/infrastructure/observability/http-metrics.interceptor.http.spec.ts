/**
 * The HTTP request metrics over a real Nest application with the global exception filters, as
 * main.ts and app.module.ts register them: each request is counted, and its duration observed,
 * with the status code the response got. The interceptor sees a handler's exception before the
 * exception filter sets the response's status, so every failed request was counted as 200,
 * Express's default status.
 */
import { Controller, Get, INestApplication, NotFoundException, Param } from '@nestjs/common';
import { APP_INTERCEPTOR, HttpAdapterHost } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { globalExceptionFilters } from '@shared/filters/global-exception-filters';
import { HttpMetricsInterceptor } from './http-metrics.interceptor';
import { MetricsService } from './metrics.service';

@Controller('probe')
class ProbeController {
  @Get('things/:id')
  thing(@Param('id') id: string) {
    if (id === 'missing') throw new NotFoundException(`Thing ${id} not found`);
    if (id === 'broken') throw new Error('database unreachable');
    return { id };
  }
}

describe('HttpMetricsInterceptor (HTTP)', () => {
  let app: INestApplication;
  let metrics: MetricsService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ProbeController],
      providers: [MetricsService, { provide: APP_INTERCEPTOR, useClass: HttpMetricsInterceptor }],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalFilters(...globalExceptionFilters(app.get(HttpAdapterHost)));
    await app.init();
    metrics = app.get(MetricsService);
  });

  beforeEach(() => {
    metrics.httpRequestsTotal.reset();
    metrics.httpRequestDuration.reset();
  });

  afterAll(async () => {
    await app.close();
  });

  /** The request count and the number of observed durations per status code of the route. */
  async function countedByStatus(): Promise<Record<string, { count: number; observed: number }>> {
    // The response's `finish` event comes before supertest has read it; one tick for safety
    await new Promise((resolve) => setImmediate(resolve));
    const byStatus: Record<string, { count: number; observed: number }> = {};
    const entry = (status: string | number | undefined) =>
      (byStatus[String(status)] ??= { count: 0, observed: 0 });
    for (const v of (await metrics.httpRequestsTotal.get()).values) {
      expect(v.labels).toMatchObject({ method: 'GET', route: '/probe/things/:id' });
      entry(v.labels.status_code).count += v.value;
    }
    for (const v of (await metrics.httpRequestDuration.get()).values) {
      if (v.metricName !== 'euroid_http_request_duration_ms_count') continue;
      entry(v.labels.status_code).observed += v.value;
    }
    return byStatus;
  }

  it('counts a NotFoundException as 404', async () => {
    await request(app.getHttpServer()).get('/probe/things/missing').expect(404);

    expect(await countedByStatus()).toEqual({ '404': { count: 1, observed: 1 } });
  });

  it('counts an unhandled error as 500', async () => {
    await request(app.getHttpServer()).get('/probe/things/broken').expect(500);

    expect(await countedByStatus()).toEqual({ '500': { count: 1, observed: 1 } });
  });

  it('counts a success as 200', async () => {
    await request(app.getHttpServer()).get('/probe/things/42').expect(200);

    expect(await countedByStatus()).toEqual({ '200': { count: 1, observed: 1 } });
  });
});
