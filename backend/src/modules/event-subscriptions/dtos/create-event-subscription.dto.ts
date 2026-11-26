import { z } from 'zod';
import { webhookHeaderNameProblem, webhookHeaderValueProblem } from '../webhook-headers';

/** A custom header name (webhook-headers.ts): an HTTP token EuroID does not set itself. */
export const WebhookHeaderNameSchema = z.string().superRefine((name, ctx) => {
  const problem = webhookHeaderNameProblem(name);
  if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Header name ${problem}` });
});

/** A custom header value: at most 2000 characters, no line break. */
export const WebhookHeaderValueSchema = z.string().superRefine((value, ctx) => {
  const problem = webhookHeaderValueProblem(value);
  if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Header value ${problem}` });
});

/** Header names that differ only in case name one HTTP header. */
export function refineDistinctHeaderNames(headers: Record<string, unknown>, ctx: z.RefinementCtx) {
  const seen = new Set<string>();
  for (const name of Object.keys(headers)) {
    const lower = name.toLowerCase();
    if (seen.has(lower)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [name],
        message: 'Header named twice (header names ignore case)',
      });
    }
    seen.add(lower);
  }
}

export const CreateEventSubscriptionSchema = z.object({
  name: z.string().min(1).max(100),
  filters: z.object({
    eventTypes: z.array(z.string().min(1).max(100)).min(1).max(50),
    severityMin: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
  }),
  webhook: z.object({
    url: z.string().url().max(2048),
    headers: z
      .record(WebhookHeaderNameSchema, WebhookHeaderValueSchema)
      .superRefine(refineDistinctHeaderNames)
      .optional()
      .default({}),
    signingSecret: z.string().min(16).max(256),
  }),
});

export type CreateEventSubscriptionDto = z.infer<typeof CreateEventSubscriptionSchema>;
