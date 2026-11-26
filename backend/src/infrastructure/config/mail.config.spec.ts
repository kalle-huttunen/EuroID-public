import { parseMailConfig } from './mail.config';

const BASE = {
  SMTP_HOST: 'smtp.example.com',
  SMTP_FROM: 'EuroID <no-reply@example.com>',
  FRONTEND_URL: 'https://euroid.example.com/',
};

describe('parseMailConfig', () => {
  it('is off without SMTP_HOST and reads nothing else, so a bad value cannot fail startup', () => {
    for (const host of [undefined, '', '   ']) {
      const conf = parseMailConfig({ SMTP_HOST: host, SMTP_PORT: 'not-a-port', SMTP_USER: 'u' });
      expect(conf.enabled).toBe(false);
    }
  });

  it('is on with SMTP_HOST and defaults to port 587 with STARTTLS required', () => {
    const conf = parseMailConfig({ ...BASE });
    expect(conf).toMatchObject({
      enabled: true,
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      requireTls: true,
      from: 'EuroID <no-reply@example.com>',
      timeoutMs: 10_000,
      frontendUrl: 'https://euroid.example.com',
    });
    expect(conf.auth).toBeUndefined();
  });

  it('uses implicit TLS on port 465 unless SMTP_SECURE says otherwise', () => {
    expect(parseMailConfig({ ...BASE, SMTP_PORT: '465' }).secure).toBe(true);
    expect(parseMailConfig({ ...BASE, SMTP_PORT: '465', SMTP_SECURE: 'false' }).secure).toBe(false);
    expect(parseMailConfig({ ...BASE, SMTP_REQUIRE_TLS: 'false' }).requireTls).toBe(false);
  });

  it('takes credentials only as a pair', () => {
    expect(parseMailConfig({ ...BASE, SMTP_USER: 'mailer', SMTP_PASSWORD: 'pw ' }).auth).toEqual({
      user: 'mailer',
      pass: 'pw ',
    });
    expect(() => parseMailConfig({ ...BASE, SMTP_USER: 'mailer' })).toThrow(/together/);
    expect(() => parseMailConfig({ ...BASE, SMTP_PASSWORD: 'pw' })).toThrow(/together/);
  });

  it('requires a sender address', () => {
    expect(() => parseMailConfig({ ...BASE, SMTP_FROM: undefined })).toThrow(/SMTP_FROM/);
    expect(() => parseMailConfig({ ...BASE, SMTP_FROM: 'no address' })).toThrow(/SMTP_FROM/);
    expect(() =>
      parseMailConfig({ ...BASE, SMTP_FROM: 'a@b.example\r\nBcc: c@d.example' }),
    ).toThrow(/single line/);
  });

  it('links to FRONTEND_URL, else the first CORS origin, and refuses anything but http(s)', () => {
    const fromCors = parseMailConfig({
      ...BASE,
      FRONTEND_URL: undefined,
      CORS_ORIGINS: 'https://app.example.com, https://other.example.com',
    });
    expect(fromCors.frontendUrl).toBe('https://app.example.com');
    expect(() => parseMailConfig({ ...BASE, FRONTEND_URL: undefined })).toThrow(/FRONTEND_URL/);
    expect(() => parseMailConfig({ ...BASE, FRONTEND_URL: 'javascript:alert(1)' })).toThrow(
      /http\(s\)/,
    );
    expect(() => parseMailConfig({ ...BASE, FRONTEND_URL: 'not a url' })).toThrow(/http\(s\)/);
  });

  it('rejects an invalid port or timeout once email is on', () => {
    expect(() => parseMailConfig({ ...BASE, SMTP_PORT: '70000' })).toThrow(/SMTP_PORT/);
    expect(() => parseMailConfig({ ...BASE, SMTP_TIMEOUT_MS: '-1' })).toThrow(/SMTP_TIMEOUT_MS/);
  });
});
