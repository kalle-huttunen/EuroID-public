import { ExceptionFilter, Catch, ArgumentsHost, HttpException, HttpStatus } from '@nestjs/common';
import { Response } from 'express';
import { ZodError } from 'zod';
import { SCIM_SCHEMAS, SCIM_CONTENT_TYPE } from './scim.constants';

/** SCIM error response body (RFC 7644 §3.12) */
export class SCIMError extends HttpException {
  constructor(
    public readonly scimType: string | undefined,
    public readonly detail: string,
    public readonly scimStatus: string,
  ) {
    super(
      {
        schemas: [SCIM_SCHEMAS.ERROR],
        scimType,
        detail,
        status: scimStatus,
      },
      parseInt(scimStatus, 10),
    );
    // HttpException sets message to the HTTP status text by default when response is an object.
    // Override so callers can catch by detail message.
    this.message = detail;
  }
}

/** Exception filter that formats all errors as SCIM JSON */
@Catch()
export class SCIMErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let detail = 'Internal server error';
    let scimType: string | undefined;

    if (exception instanceof SCIMError) {
      status = exception.getStatus();
      detail = exception.detail;
      scimType = exception.scimType;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      detail = exception.message;
      if (status === HttpStatus.CONFLICT) scimType = 'uniqueness';
    } else if (exception instanceof ZodError) {
      // A request value the route's schema refused (a query parameter such as count)
      status = HttpStatus.BAD_REQUEST;
      detail = `Validation failed: ${exception.errors.map((e) => e.message).join(', ')}`;
      scimType = 'invalidValue';
    } else if ((exception as { code?: unknown } | null)?.code === 11000) {
      // A unique index refused the write (a userName, email or group taken meanwhile); the
      // driver's message quotes the value, so it is not answered
      status = HttpStatus.CONFLICT;
      detail = 'A resource with these unique values already exists';
      scimType = 'uniqueness';
    } else if ((exception as { name?: unknown } | null)?.name === 'CastError') {
      // An id that is no ObjectId: no resource has it
      status = HttpStatus.NOT_FOUND;
      detail = 'Resource not found';
    }

    response
      .status(status)
      .contentType(SCIM_CONTENT_TYPE)
      .json({
        schemas: [SCIM_SCHEMAS.ERROR],
        scimType,
        detail,
        status: String(status),
      });
  }
}
