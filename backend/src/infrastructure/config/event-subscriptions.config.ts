import { registerAs } from '@nestjs/config';
import { z } from 'zod';

const schema = z
  .object({
    WEBHOOK_MAX_SUBSCRIPTIONS_PER_TENANT: z
      .string()
      .transform((v) => parseInt(v || '10', 10))
      .default('10'),
    WEBHOOK_MAX_RETRY_ATTEMPTS: z
      .string()
      .transform((v) => parseInt(v || '5', 10))
      .default('5'),
    WEBHOOK_DELIVERY_TIMEOUT_MS: z
      .string()
      .transform((v) => parseInt(v || '10000', 10))
      .default('10000'),
    /**
     * How long a process holds a delivery it is sending. A send that has not finished by then
     * (the process stopped) is taken by the retry poller and counts as an attempt.
     */
    WEBHOOK_DELIVERY_LEASE_MS: z
      .string()
      .transform((v) => parseInt(v || '60000', 10))
      .default('60000'),
  })
  .refine((c) => c.WEBHOOK_DELIVERY_LEASE_MS > c.WEBHOOK_DELIVERY_TIMEOUT_MS, {
    message:
      'WEBHOOK_DELIVERY_LEASE_MS must be longer than WEBHOOK_DELIVERY_TIMEOUT_MS, or a send still waiting for the receiver is sent a second time',
  });

export type EventSubscriptionsConfig = z.infer<typeof schema>;

export const eventSubscriptionsConfig = registerAs(
  'eventSubscriptions',
  (): EventSubscriptionsConfig => {
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
      const msg = parsed.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ');
      throw new Error(`Event subscriptions config validation failed: ${msg}`);
    }
    return parsed.data;
  },
);
