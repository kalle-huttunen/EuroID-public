import { Catch, ArgumentsHost, HttpStatus } from '@nestjs/common';
import { Response } from 'express';
import { Error as MongooseError } from 'mongoose';
import { AllExceptionsFilter } from './all-exceptions.filter';

/**
 * Global exception filter for the Mongoose errors that have an answer of their own:
 * - VersionError → 409 Conflict (optimistic concurrency)
 * - CastError of an ObjectId (invalid id) → 400 Bad Request (prevents schema leak)
 * It catches only these two types, so every other exception goes on to AllExceptionsFilter; a
 * CastError of another kind gets the catch-all answer (generic 500 and its log line) from the
 * AllExceptionsFilter this filter extends.
 */
@Catch(MongooseError.VersionError, MongooseError.CastError)
export class VersionConflictFilter extends AllExceptionsFilter {
  catch(
    exception: MongooseError.VersionError | MongooseError.CastError,
    host: ArgumentsHost,
  ): void {
    if (exception instanceof MongooseError.VersionError) {
      const response = host.switchToHttp().getResponse<Response>();
      response.status(HttpStatus.CONFLICT).json({
        statusCode: 409,
        message: 'This record was modified by another user. Please refresh and try again.',
      });
      return;
    }

    if (exception.kind === 'ObjectId') {
      const response = host.switchToHttp().getResponse<Response>();
      response.status(HttpStatus.BAD_REQUEST).json({
        statusCode: 400,
        message: 'Invalid ID format',
      });
      return;
    }

    super.catch(exception, host);
  }
}
