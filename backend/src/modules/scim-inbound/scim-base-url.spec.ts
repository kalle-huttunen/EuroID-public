/**
 * The base of the `meta.location` links SCIM answers. Hunt 2026-11-25 (r2-02 N7): without
 * APP_BASE_URL the controllers read X-Forwarded-Host and X-Forwarded-Proto themselves, so a
 * caller chose the host of the links even with TRUST_PROXY=false. The request's protocol and
 * host now come from Express, which honours forwarded headers only from a trusted proxy.
 */
import type { Request } from 'express';
import { scimBaseUrl } from './scim-base-url';

describe('scimBaseUrl', () => {
  const savedBase = process.env.APP_BASE_URL;
  afterEach(() => {
    if (savedBase === undefined) delete process.env.APP_BASE_URL;
    else process.env.APP_BASE_URL = savedBase;
  });

  const request = {
    protocol: 'https',
    get: (name: string) => (name.toLowerCase() === 'host' ? 'euroid.acme.test' : undefined),
    headers: { 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'http' },
  } as unknown as Request;

  it('takes APP_BASE_URL when it is set', () => {
    process.env.APP_BASE_URL = 'https://id.acme.test/';

    expect(scimBaseUrl(request)).toBe('https://id.acme.test');
  });

  it("uses Express's protocol and host, never the forwarded headers it did not trust", () => {
    delete process.env.APP_BASE_URL;

    expect(scimBaseUrl(request)).toBe('https://euroid.acme.test');
  });
});
