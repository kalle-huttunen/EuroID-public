import { z } from 'zod';
import {
  WebhookHeaderNameSchema,
  WebhookHeaderValueSchema,
  refineDistinctHeaderNames,
} from './create-event-subscription.dto';

export const UpdateEventSubscriptionSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  status: z.enum(['ACTIVE', 'PAUSED', 'DISABLED']).optional(),
  filters: z
    .object({
      eventTypes: z.array(z.string().min(1).max(100)).min(1).max(50),
      severityMin: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
    })
    .optional(),
  webhook: z
    .object({
      url: z.string().url().max(2048).optional(),
      /**
       * The complete set of custom headers after the edit. The API never answers header values,
       * so a header sent as null keeps its stored value; a stored header left out is removed.
       */
      headers: z
        .record(WebhookHeaderNameSchema, WebhookHeaderValueSchema.nullable())
        .superRefine(refineDistinctHeaderNames)
        .optional(),
      signingSecret: z.string().min(16).max(256).optional(),
    })
    .optional(),
});

export type UpdateEventSubscriptionDto = z.infer<typeof UpdateEventSubscriptionSchema>;
