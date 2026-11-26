import { registerAs } from '@nestjs/config';
import { z } from 'zod';

const appSchema = z
  .object({
    MONGO_URI: z.string().optional(),
    MONGO_MAX_POOL_SIZE: z
      .string()
      .transform((v) => parseInt(v || '20', 10))
      .default('20'),
    MONGO_MIN_POOL_SIZE: z
      .string()
      .transform((v) => parseInt(v || '5', 10))
      .default('5'),
    CONNECTOR_TIMEOUT_MS: z
      .string()
      .transform((v) => parseInt(v || '15000', 10))
      .default('15000'),
    CONNECTOR_TIMEOUT_HR_MS: z
      .string()
      .transform((v) => parseInt(v || '30000', 10))
      .default('30000'),
    CSV_HR_MAX_ROWS: z
      .string()
      .transform((v) => parseInt(v || '100000', 10))
      .default('100000'),
    CSV_HR_MAX_FILE_SIZE_MB: z
      .string()
      .transform((v) => parseInt(v || '50', 10))
      .default('50'),
    JSON_HR_MAX_ITEMS: z
      .string()
      .transform((v) => parseInt(v || '100000', 10))
      .default('100000'),
    POLICY_PAGE_SIZE: z
      .string()
      .transform((v) => parseInt(v || '500', 10))
      .default('500'),
    IMPACT_ANALYSIS_SAMPLE_SIZE: z
      .string()
      .transform((v) => parseInt(v || '500', 10))
      .default('500'),
    IMPACT_ANALYSIS_PAGE_SIZE: z
      .string()
      .transform((v) => parseInt(v || '300', 10))
      .default('300'),
    POLICY_SUGGESTIONS_PAGE_SIZE: z
      .string()
      .transform((v) => parseInt(v || '300', 10))
      .default('300'),
    HR_FETCH_PAGE_SIZE: z
      .string()
      .transform((v) => parseInt(v || '500', 10))
      .default('500'),
    IDENTITY_PROVISIONING_PAGE_SIZE: z
      .string()
      .transform((v) => parseInt(v || '500', 10))
      .default('500'),
    ARCHIVAL_BATCH_SIZE: z
      .string()
      .transform((v) => parseInt(v || '1000', 10))
      .default('1000'),
    RECONCILE_BATCH_PAGE_SIZE: z
      .string()
      .transform((v) => parseInt(v || '5000', 10))
      .default('5000'),
    SKU_CACHE_TTL_MS: z
      .string()
      .transform((v) => parseInt(v || '300000', 10))
      .default('300000'),
  })
  .refine((data) => !!data.MONGO_URI, {
    message: 'MONGO_URI is required. Set it in .env. See backend/.env.example',
  });

export type AppConfig = z.infer<typeof appSchema>;

export const appConfig = registerAs('app', (): AppConfig => {
  const parsed = appSchema.safeParse(process.env);
  if (!parsed.success) {
    const msg = parsed.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ');
    throw new Error(`App config validation failed: ${msg}`);
  }
  return parsed.data;
});
