import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';
import { trace, context } from '@opentelemetry/api';

export interface RequestContext {
  correlationId: string;
  traceId?: string; // OTel trace ID for correlation with traces
  actor: string; // Will be 'anonymous' until Auth is wired (Task 6)
  tenantId: string; // Set by TenantContextInterceptor after JwtAuthGuard
  identityId?: string; // Set by controllers when operating on a specific identity
  startTime: number;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

/** Only allow safe characters in correlation IDs to prevent log injection. */
const SAFE_CORRELATION_ID = /^[a-zA-Z0-9._\-]{1,128}$/;

@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    const rawId = req.headers['x-correlation-id'] as string | undefined;
    const correlationId =
      rawId && SAFE_CORRELATION_ID.test(rawId) ? rawId : randomUUID();

    // Link to OTel trace ID for correlation between logs and traces
    const span = trace.getSpan(context.active());
    const traceId = span?.spanContext().traceId;

    // Echo back to the caller
    res.setHeader('X-Correlation-ID', correlationId);
    if (traceId) {
      res.setHeader('X-Trace-Id', traceId);
    }

    const ctx: RequestContext = {
      correlationId,
      traceId,
      actor: 'anonymous',
      tenantId: '',
      startTime: Date.now(),
    };

    requestContext.run(ctx, () => next());
  }
}
