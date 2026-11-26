import { z } from 'zod';

export const BatchRetrySchema = z.object({
  type: z
    .enum([
      'event_handler_failure',
      'event_chain_depth_exceeded',
      'event_validation_failure',
      'workflow_terminal',
      'connector_non_retryable',
    ])
    .optional(),
});

export type BatchRetryDto = z.infer<typeof BatchRetrySchema>;
