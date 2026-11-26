import { ServiceUnavailableException } from '@nestjs/common';

/**
 * The tenant's correlation settings could not be read (CorrelationConfigService.
 * getCorrelationConfig with `strict`). Identity correlation needs them before it stores a record:
 * they name the national ID field to remove (identity/national-id.ts), so nothing is stored and
 * the caller retries (an activity is retried by Temporal; a route that lets it through answers
 * 503).
 */
export class CorrelationConfigUnavailableError extends ServiceUnavailableException {
  constructor() {
    super('The correlation settings could not be read: nothing was stored. Try again.');
  }
}
