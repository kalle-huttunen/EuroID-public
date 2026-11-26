import { Catch, ArgumentsHost, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { HttpAdapterHost, BaseExceptionFilter } from '@nestjs/core';
import { Response } from 'express';

/**
 * Global catch-all exception filter (registered first, so it gets every exception that no more
 * specific global filter catches, see global-exception-filters.ts).
 * - HttpExceptions: delegates to NestJS default handling (correct status + message).
 * - Client errors from Express's body parsing (http-errors with a 4xx status and `expose: true`,
 *   e.g. 413 for a body over the size limit): their status and message, also via NestJS.
 * - Everything else: logs full error internally, returns generic 500 to the client.
 *   Prevents stack traces, file paths, and internal details from leaking.
 */
@Catch()
export class AllExceptionsFilter extends BaseExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  constructor(httpAdapterHost: HttpAdapterHost) {
    super(httpAdapterHost.httpAdapter);
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    if (exception instanceof HttpException || isExposedClientError(exception)) {
      super.catch(exception, host);
      return;
    }

    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    const message = exception instanceof Error ? exception.message : String(exception);
    const stack = exception instanceof Error ? exception.stack : undefined;
    this.logger.error(`Unhandled exception: ${message}`, stack);

    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Internal server error',
    });
  }
}

/**
 * An http-errors error that marks its message as safe for the client: http-errors sets
 * `expose: true` on 4xx errors only. Other errors with a `statusCode` (an SDK's upstream
 * response, say) are not trusted with the client's status or message.
 */
function isExposedClientError(exception: unknown): boolean {
  if (!exception || typeof exception !== 'object') return false;
  const { expose, statusCode } = exception as { expose?: unknown; statusCode?: unknown };
  return expose === true && typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500;
}
