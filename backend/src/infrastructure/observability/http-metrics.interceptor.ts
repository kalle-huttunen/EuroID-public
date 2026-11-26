import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import type { Response } from 'express';
import { Observable } from 'rxjs';
import { MetricsService } from './metrics.service';

/**
 * Global interceptor that records HTTP request duration and count per route.
 * Route labels use the Express route pattern (e.g. /api/v1/identity/:id)
 * to avoid high-cardinality from path params.
 *
 * Recorded when the response is sent (`finish`), with the status code it got: a handler's
 * exception passes this interceptor while the response still has Express's default 200, and the
 * exception filter sets the real status after it.
 */
@Injectable()
export class HttpMetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const req = context.switchToHttp().getRequest();
    const res = context.switchToHttp().getResponse<Response>();
    const method = req.method;
    const start = Date.now();

    res.once('finish', () => this.record(method, req, res.statusCode, start));
    return next.handle();
  }

  private record(
    method: string,
    req: { route?: { path?: string }; path?: string },
    statusCode: number,
    start: number,
  ): void {
    const route = req.route?.path || req.path || 'unknown';
    const duration = Date.now() - start;
    const labels = { method, route, status_code: String(statusCode) };
    this.metrics.httpRequestDuration.observe(labels, duration);
    this.metrics.httpRequestsTotal.inc(labels);
  }
}
