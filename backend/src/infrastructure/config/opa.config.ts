import { registerAs } from '@nestjs/config';
import { z } from 'zod';

const opaSchema = z.object({
  OPA_ENABLED: z
    .string()
    .transform((v) => v === 'true' || v === '1')
    .default('false'),
  OPA_URL: z.string().default('http://localhost:8181'),
  OPA_POLICY_PATH: z.string().default('euroid/policy/evaluate'),
  OPA_REQUEST_TIMEOUT_MS: z
    .string()
    .transform((v) => parseInt(v || '5000', 10))
    .default('5000'),
  OPA_FALLBACK_ON_ERROR: z
    .string()
    .transform((v) => v !== 'false' && v !== '0')
    .default('true'),
  OPA_BUNDLE_SYNC_INTERVAL_MS: z
    .string()
    .transform((v) => parseInt(v || '30000', 10))
    .default('30000'),
});

export type OpaConfig = z.infer<typeof opaSchema>;

export const opaConfig = registerAs('opa', (): OpaConfig => {
  const parsed = opaSchema.safeParse(process.env);
  if (!parsed.success) {
    const msg = parsed.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ');
    throw new Error(`OPA config validation failed: ${msg}`);
  }
  return parsed.data;
});
