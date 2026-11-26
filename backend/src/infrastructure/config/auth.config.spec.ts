import { authConfig } from './auth.config';

/** The password reset settings of auth.config.ts, read from the environment at startup. */
describe('authConfig password reset settings', () => {
  const saved = { ...process.env };

  /** The settings from `env` alone: any PASSWORD_RESET_* of the machine running the test is dropped. */
  function load(env: Record<string, string>) {
    const base = Object.fromEntries(
      Object.entries(saved).filter(([key]) => !key.startsWith('PASSWORD_RESET_')),
    );
    process.env = { ...base, JWT_SECRET: 'test-secret', ...env };
    return authConfig();
  }

  afterEach(() => {
    process.env = { ...saved };
  });

  it('defaults to a 30-minute token, 10 requests per IP and 3 per address in 15 minutes', () => {
    expect(load({})).toMatchObject({
      PASSWORD_RESET_TOKEN_TTL_MINUTES: 30,
      PASSWORD_RESET_MAX_PER_IP: 10,
      PASSWORD_RESET_MAX_PER_EMAIL: 3,
      PASSWORD_RESET_WINDOW_MINUTES: 15,
    });
  });

  it('keeps the token lifetime between 15 and 60 minutes', () => {
    expect(load({ PASSWORD_RESET_TOKEN_TTL_MINUTES: '15' }).PASSWORD_RESET_TOKEN_TTL_MINUTES).toBe(
      15,
    );
    expect(load({ PASSWORD_RESET_TOKEN_TTL_MINUTES: '60' }).PASSWORD_RESET_TOKEN_TTL_MINUTES).toBe(
      60,
    );
    for (const value of ['14', '61', 'soon']) {
      expect(() => load({ PASSWORD_RESET_TOKEN_TTL_MINUTES: value })).toThrow(
        /PASSWORD_RESET_TOKEN_TTL_MINUTES/,
      );
    }
  });

  it('refuses a limit below 1', () => {
    expect(() => load({ PASSWORD_RESET_MAX_PER_EMAIL: '0' })).toThrow(
      /PASSWORD_RESET_MAX_PER_EMAIL/,
    );
  });
});

/**
 * EMERGENCY_TOKEN_VALID_UNTIL ends the break-glass token. A date that cannot be read made the
 * guard compare with NaN, which never expires, so the API refuses to start with one.
 */
describe('authConfig EMERGENCY_TOKEN_VALID_UNTIL', () => {
  const saved = { ...process.env };
  const load = (value: string | undefined) => {
    process.env = { ...saved, JWT_SECRET: 'test-secret', EMERGENCY_TOKEN_VALID_UNTIL: value };
    if (value === undefined) delete process.env.EMERGENCY_TOKEN_VALID_UNTIL;
    return authConfig();
  };

  afterEach(() => {
    process.env = { ...saved };
  });

  it('accepts an ISO 8601 date-time, an empty value and no value', () => {
    expect(load('2026-12-31T23:59:00Z').EMERGENCY_TOKEN_VALID_UNTIL).toBe('2026-12-31T23:59:00Z');
    expect(() => load('')).not.toThrow();
    expect(() => load(undefined)).not.toThrow();
  });

  it.each(['31.12.2026', 'tomorrow', '2026-13-45T00:00:00Z'])(
    'refuses to start with %s',
    (value) => {
      expect(() => load(value)).toThrow(/EMERGENCY_TOKEN_VALID_UNTIL/);
    },
  );
});

/** AUTH_DISABLED signs every request in as a super-admin: development and test only. */
describe('authConfig AUTH_DISABLED', () => {
  const saved = { ...process.env };
  const load = (nodeEnv: string | undefined) => {
    process.env = { ...saved, AUTH_DISABLED: 'true', NODE_ENV: nodeEnv };
    if (nodeEnv === undefined) delete process.env.NODE_ENV;
    return authConfig();
  };

  afterEach(() => {
    process.env = { ...saved };
  });

  it.each(['development', 'test'])('is accepted in %s', (nodeEnv) => {
    expect(() => load(nodeEnv)).not.toThrow();
  });

  it.each(['production', 'staging', 'qa', undefined])(
    'refuses to start with NODE_ENV %p',
    (nodeEnv) => {
      expect(() => load(nodeEnv)).toThrow(/AUTH_DISABLED=true is only allowed/);
    },
  );
});
