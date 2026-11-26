import type { ExceptionFilter } from '@nestjs/common';
import type { HttpAdapterHost } from '@nestjs/core';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { VersionConflictFilter } from './version-conflict.filter';
import { ZodErrorFilter } from './zod-error.filter';

/**
 * The global exception filters main.ts registers, in registration order. Nest tries the last
 * registered filter first and uses the first whose @Catch() matches, so the catch-all comes first
 * and the specific filters after it. A specific filter's @Catch() names only the types it answers
 * (ZodError; Mongoose VersionError and CastError): a catch-all @Catch() there would take every
 * exception from AllExceptionsFilter. Tests register the same list.
 */
export function globalExceptionFilters(adapterHost: HttpAdapterHost): ExceptionFilter[] {
  return [
    new AllExceptionsFilter(adapterHost),
    new VersionConflictFilter(adapterHost),
    new ZodErrorFilter(adapterHost),
  ];
}
