import type { INestApplicationContext, Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { createLoggerConfig } from './infrastructure/observability/logger.config';

/**
 * The Temporal worker's Nest application context (worker.ts boots AppModule with it). It logs
 * through the API's winston configuration (createLoggerConfig), so piiRedactFormat redacts the
 * PII keys of every Nest log call an activity or service makes, as in the API. Temporal's own
 * worker and workflow logs go through Temporal's runtime logger and are not affected.
 */
export function createWorkerContext(module: Type<unknown>): Promise<INestApplicationContext> {
  return NestFactory.createApplicationContext(module, { logger: createLoggerConfig() });
}
