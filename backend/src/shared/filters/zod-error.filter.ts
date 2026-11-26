import { ArgumentsHost, BadRequestException, Catch } from '@nestjs/common';
import { BaseExceptionFilter, HttpAdapterHost } from '@nestjs/core';
import { ZodError } from 'zod';

/** One `field.path: message` line per issue (`body` for the root), as ZodValidationPipe words it. */
export function zodIssueMessages(error: ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`);
}

/**
 * A ZodError reaching the HTTP layer comes from a controller or service validating request input
 * with `Schema.parse()` (Zod at the gate). It is answered like the global ZodValidationPipe
 * answers a DTO: 400 with one message per invalid field. Without this filter it fell through to
 * the catch-all as a 500.
 */
@Catch(ZodError)
export class ZodErrorFilter extends BaseExceptionFilter {
  constructor(httpAdapterHost: HttpAdapterHost) {
    super(httpAdapterHost.httpAdapter);
  }

  catch(exception: ZodError, host: ArgumentsHost): void {
    super.catch(new BadRequestException(zodIssueMessages(exception)), host);
  }
}
