import { registerAs } from '@nestjs/config';
import { z } from 'zod';

/**
 * SMTP settings for email notifications (`modules/notifications`), one set per deployment.
 *
 * SMTP_HOST unset or empty: email is off and nothing else here is read, so no other variable can
 * fail startup. SMTP_HOST set: SMTP_FROM and a frontend URL for the links (FRONTEND_URL, else the
 * first CORS_ORIGINS entry) are required, SMTP_USER and SMTP_PASSWORD go together, and an invalid
 * value fails startup like the other config validators.
 */
export interface MailConfig {
  enabled: boolean;
  host: string;
  port: number;
  /** Implicit TLS (smtps). Default: true on port 465. */
  secure: boolean;
  /** STARTTLS required on a non-TLS port. Default true; false only for a local relay. */
  requireTls: boolean;
  auth?: { user: string; pass: string };
  from: string;
  /** Connection, greeting, socket and DNS timeout, each. */
  timeoutMs: number;
  /** Origin of the web app, without a trailing slash. Email links point here. */
  frontendUrl: string;
}

const blankToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;
const optionalText = z.preprocess(blankToUndefined, z.string().trim().optional());
const optionalFlag = z.preprocess(blankToUndefined, z.enum(['true', 'false']).optional());

const envSchema = z.object({
  SMTP_HOST: optionalText,
  SMTP_PORT: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).max(65535).default(587)),
  SMTP_SECURE: optionalFlag,
  SMTP_REQUIRE_TLS: optionalFlag,
  SMTP_USER: optionalText,
  // Not trimmed: a password may end in a space.
  SMTP_PASSWORD: z.preprocess(blankToUndefined, z.string().optional()),
  SMTP_FROM: optionalText,
  SMTP_TIMEOUT_MS: z.preprocess(
    blankToUndefined,
    z.coerce.number().int().positive().default(10_000),
  ),
  FRONTEND_URL: optionalText,
  CORS_ORIGINS: optionalText,
});

const DISABLED: MailConfig = {
  enabled: false,
  host: '',
  port: 587,
  secure: false,
  requireTls: true,
  from: '',
  timeoutMs: 10_000,
  frontendUrl: '',
};

function fail(message: string): never {
  throw new Error(`Mail config validation failed: ${message}`);
}

function frontendOrigin(frontendUrl: string | undefined, corsOrigins: string | undefined): string {
  const candidate = frontendUrl ?? corsOrigins?.split(',')[0]?.trim();
  if (!candidate) fail('FRONTEND_URL (or CORS_ORIGINS) is required when SMTP_HOST is set');
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    fail('FRONTEND_URL must be an absolute http(s) URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    fail('FRONTEND_URL must be an absolute http(s) URL');
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

/** Parses the mail settings from an environment. Exported for tests. */
export function parseMailConfig(env: NodeJS.ProcessEnv): MailConfig {
  if (!blankToUndefined(env.SMTP_HOST)) return { ...DISABLED };

  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    fail(parsed.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '));
  }
  const e = parsed.data;
  if (!e.SMTP_FROM || !e.SMTP_FROM.includes('@')) {
    fail('SMTP_FROM (a sender address, e.g. "EuroID <no-reply@example.com>") is required');
  }
  if (/[\r\n]/.test(e.SMTP_FROM)) fail('SMTP_FROM must be a single line');
  if (Boolean(e.SMTP_USER) !== Boolean(e.SMTP_PASSWORD)) {
    fail('SMTP_USER and SMTP_PASSWORD must be set together');
  }

  const secure = e.SMTP_SECURE ? e.SMTP_SECURE === 'true' : e.SMTP_PORT === 465;
  return {
    enabled: true,
    host: e.SMTP_HOST!,
    port: e.SMTP_PORT,
    secure,
    requireTls: e.SMTP_REQUIRE_TLS ? e.SMTP_REQUIRE_TLS === 'true' : true,
    ...(e.SMTP_USER && e.SMTP_PASSWORD
      ? { auth: { user: e.SMTP_USER, pass: e.SMTP_PASSWORD } }
      : {}),
    from: e.SMTP_FROM,
    timeoutMs: e.SMTP_TIMEOUT_MS,
    frontendUrl: frontendOrigin(e.FRONTEND_URL, e.CORS_ORIGINS),
  };
}

export const mailConfig = registerAs('mail', (): MailConfig => parseMailConfig(process.env));
