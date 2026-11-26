import { Injectable } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import { Logger } from 'winston';
import { getRequestContext } from '../middleware/get-request-context';

/**
 * Injectable logger that auto-injects correlationId and actor from request context.
 * Use LoggerFactoryService.create(serviceName) to get an instance for your service.
 */
export class ContextualLoggerService {
  constructor(
    private readonly logger: Logger,
    private readonly serviceName: string,
  ) {}

  private mergeContext(extra?: Record<string, unknown>): Record<string, unknown> {
    const ctx = getRequestContext();
    return {
      service: this.serviceName,
      correlationId: ctx?.correlationId ?? 'no-context',
      actor: ctx?.actor ?? 'system',
      ...(ctx?.traceId && { traceId: ctx.traceId }),
      ...extra,
    };
  }

  log(message: string, extra?: Record<string, unknown>): void {
    this.logger.info({
      message,
      ...this.mergeContext(extra),
    });
  }

  error(message: string, trace?: string, context?: Record<string, unknown>): void {
    this.logger.error({
      message,
      trace,
      ...this.mergeContext(context),
    });
  }

  warn(message: string, extra?: Record<string, unknown>): void {
    this.logger.warn({
      message,
      ...this.mergeContext(extra),
    });
  }

  debug(message: string, extra?: Record<string, unknown>): void {
    this.logger.debug({
      message,
      ...this.mergeContext(extra),
    });
  }
}

/**
 * Factory to create contextual loggers with a service name.
 * Inject this and call create(MyService.name) in your service constructor.
 */
@Injectable()
export class LoggerFactoryService {
  constructor(
    @Inject(WINSTON_MODULE_PROVIDER) private readonly winstonLogger: Logger,
  ) {}

  create(serviceName: string): ContextualLoggerService {
    return new ContextualLoggerService(this.winstonLogger, serviceName);
  }
}
