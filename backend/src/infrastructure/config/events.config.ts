import { registerAs } from '@nestjs/config';
import { z } from 'zod';

const eventsSchema = z.object({
  OUTBOX_POLL_INTERVAL_MS: z
    .string()
    .transform((v) => parseInt(v || '2000', 10))
    .default('2000'),
  OUTBOX_POLLER_BATCH_SIZE: z
    .string()
    .transform((v) => parseInt(v || '100', 10))
    .default('100'),
  // How long a claimed outbox event may stay `processing` before a poll takes it again (the
  // process that claimed it stopped before it published). Well above one publish.
  OUTBOX_CLAIM_TIMEOUT_MS: z
    .string()
    .transform((v) => parseInt(v || '300000', 10))
    .default('300000'),
  // With change streams: how often a sweep claims what no change announces (a stale claim, a
  // retry that fell due).
  OUTBOX_SWEEP_INTERVAL_MS: z
    .string()
    .transform((v) => parseInt(v || '15000', 10))
    .default('15000'),
  // The wait before the first retry of a failed publish; it doubles with each failure.
  OUTBOX_RETRY_BASE_MS: z
    .string()
    .transform((v) => parseInt(v || '5000', 10))
    .default('5000'),
});

export type EventsConfig = z.infer<typeof eventsSchema>;

export const eventsConfig = registerAs('events', (): EventsConfig => {
  const parsed = eventsSchema.safeParse(process.env);
  if (!parsed.success) {
    const msg = parsed.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ');
    throw new Error(`Events config validation failed: ${msg}`);
  }
  return parsed.data;
});
