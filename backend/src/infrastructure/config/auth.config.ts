import { registerAs } from '@nestjs/config';
import { z } from 'zod';
import { isDevOrTest } from './runtime-env';

const authSchema = z
  .object({
    /** Unset gets the production rules (runtime-env.ts). */
    NODE_ENV: z.string().optional(),
    AUTH_DISABLED: z.string().optional(),
    JWT_SECRET: z.string().optional(),
    OIDC_ISSUER: z.string().url().optional(),
    OIDC_AUDIENCE: z.string().optional(),
    JWT_TENANT_CLAIM: z.string().default('tenantId'),
    EMERGENCY_ADMIN_TOKEN: z.string().optional(),
    /** When the break-glass token stops working: an ISO 8601 date-time (empty: no token works). */
    EMERGENCY_TOKEN_VALID_UNTIL: z
      .string()
      .optional()
      .refine((v) => !v || Number.isFinite(Date.parse(v)), {
        message: 'must be an ISO 8601 date-time, e.g. 2026-12-31T23:59:00Z',
      }),
    DEV_TENANT_ID: z.string().optional(),
    /** Comma-separated user ids (JWT sub) granted platform-admin; see auth/platform-admin.ts. */
    PLATFORM_ADMIN_USER_IDS: z.string().optional(),
    DEFAULT_TENANT_ID: z.string().default('default'),
    THROTTLE_SHORT_LIMIT: z
      .string()
      .transform((v) => parseInt(v || '10', 10))
      .default('10'),
    THROTTLE_MEDIUM_LIMIT: z
      .string()
      .transform((v) => parseInt(v || '100', 10))
      .default('100'),
    /** How long a console admin password reset link or code works (password-reset.service.ts). */
    PASSWORD_RESET_TOKEN_TTL_MINUTES: z.coerce.number().int().min(15).max(60).default(30),
    /** Reset requests and confirmations per client IP, and requests per address, per window. */
    PASSWORD_RESET_MAX_PER_IP: z.coerce.number().int().min(1).default(10),
    PASSWORD_RESET_MAX_PER_EMAIL: z.coerce.number().int().min(1).default(3),
    PASSWORD_RESET_WINDOW_MINUTES: z.coerce.number().int().min(1).default(15),
    /** Failed password sign-ins per account (any client) before it is locked for the window. */
    LOGIN_MAX_FAILURES_PER_ACCOUNT: z.coerce.number().int().min(1).default(10),
    LOGIN_LOCKOUT_MINUTES: z.coerce.number().int().min(1).default(15),
  })
  .refine(
    (data) => {
      if (data.AUTH_DISABLED === 'true') return true;
      return !!data.JWT_SECRET;
    },
    { message: 'JWT_SECRET is required when AUTH_DISABLED is not "true". Set it in .env.' },
  )
  .refine((data) => data.AUTH_DISABLED !== 'true' || isDevOrTest(data.NODE_ENV ?? ''), {
    message:
      'AUTH_DISABLED=true is only allowed when NODE_ENV is development or test. Remove it or set it to "false".',
  });

export type AuthConfig = z.infer<typeof authSchema>;

export const authConfig = registerAs('auth', (): AuthConfig => {
  const parsed = authSchema.safeParse(process.env);
  if (!parsed.success) {
    const msg = parsed.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ');
    throw new Error(`Auth config validation failed: ${msg}`);
  }
  return parsed.data;
});
