import { registerAs } from '@nestjs/config';
import { z } from 'zod';

const schema = z.object({
  DLQ_RETRY_POLL_INTERVAL_MS: z
    .string()
    .transform((v) => parseInt(v || '60000', 10))
    .default('60000'),
  DLQ_MAX_RETRIES: z
    .string()
    .transform((v) => parseInt(v || '3', 10))
    .default('3'),
  /**
   * How long a process holds an entry it is retrying or replaying. A re-run that has not finished
   * by then (the process stopped) is taken by the automatic retry and counts as a failed retry.
   */
  DLQ_RETRY_LEASE_MS: z
    .string()
    .transform((v) => parseInt(v || '300000', 10))
    .default('300000'),
});

export type DeadLetterConfig = z.infer<typeof schema>;

export const deadLetterConfig = registerAs('deadLetter', (): DeadLetterConfig => {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const msg = parsed.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ');
    throw new Error(`Dead letter config validation failed: ${msg}`);
  }
  return parsed.data;
});
