/**
 * SSRF (FOLLOWUPS 2026-11-24, okta.client.ts): the tenant's org URL was fetched without the SSRF
 * guard, with the API token in the request. The client now checks the URL before each request
 * and connects through the guard's HTTPS agent. Real axios and the real guard; DNS is stubbed and
 * the TLS connect stops right after the agent's lookup, so no request leaves the process.
 */
import {
  STOPPED_BEFORE_CONNECT,
  stubOutboundConnections,
  v4,
  type OutboundConnect,
} from '@testing/stub-outbound-connect';
import { OktaClient } from './okta.client';
import type { OktaConfig } from './okta.interface';

const org = (orgUrl: string): OktaConfig => ({ orgUrl, apiToken: 'ssws-test' });

describe('OktaClient: where a request connects', () => {
  let connects: OutboundConnect[];
  let answerDns: ReturnType<typeof stubOutboundConnections>['answerDns'];
  const client = new OktaClient();

  beforeEach(() => {
    ({ connects, answerDns } = stubOutboundConnections());
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each(['https://169.254.169.254', 'http://127.0.0.1', 'https://[::1]'])(
    'refuses the org URL %s before any lookup or connect',
    async (orgUrl) => {
      await expect(client.getUser(org(orgUrl), '00u1')).rejects.toThrow(/blocked|Only HTTPS/);
      expect(connects).toEqual([]);
    },
  );

  it('is unhealthy for a refused org URL, without connecting', async () => {
    await expect(client.healthCheck(org('https://169.254.169.254'))).resolves.toBe(false);
    expect(connects).toEqual([]);
  });

  it('connects to the address the agent checked, with TLS verified for the org', async () => {
    answerDns([v4('93.184.215.14')]);

    await expect(client.getUser(org('https://acme.okta.example/'), '00u1')).rejects.toThrow(
      STOPPED_BEFORE_CONNECT,
    );

    expect(connects).toEqual([
      expect.objectContaining({
        host: 'acme.okta.example',
        servername: 'acme.okta.example',
        addresses: [v4('93.184.215.14')],
      }),
    ]);
    expect(connects[0]!.rejectUnauthorized).not.toBe(false);
  });

  it('refuses an org host whose address is private at connect', async () => {
    answerDns([v4('169.254.169.254')]);

    await expect(client.getUser(org('https://acme.okta.example'), '00u1')).rejects.toThrow(
      /Refused to connect to acme\.okta\.example/,
    );
    expect(connects[0]!.addresses).toBeUndefined();
  });
});
