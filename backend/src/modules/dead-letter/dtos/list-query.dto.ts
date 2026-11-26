import { z } from 'zod';

/**
 * Filters of GET /dead-letter. `source` is a case-insensitive prefix of the entry's source
 * (an event type such as `identity.created`, `webhook:<subscriptionId>:<eventType>`,
 * `distributed-transaction`); empty means no filter. offset is a whole number from 0; limit is
 * clamped by the controller as before.
 */
export const DeadLetterListQuerySchema = z.object({
  type: z
    .enum([
      'event_handler_failure',
      'event_chain_depth_exceeded',
      'event_validation_failure',
      'workflow_terminal',
      'connector_non_retryable',
    ])
    .optional(),
  status: z.enum(['pending', 'replayed', 'dismissed', 'retrying', 'failed_permanently']).optional(),
  source: z.string().trim().max(200).optional(),
  // A number of entries to skip: anything else is 400 (skip(NaN) failed in the driver, a 500)
  offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
});

export type DeadLetterListQuery = z.infer<typeof DeadLetterListQuerySchema>;
