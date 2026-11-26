/**
 * SSRF (FOLLOWUPS 2026-11-24, servicenow.client.ts): the tenant's instance URL was fetched
 * without the SSRF guard. The client now checks the URL before each request and connects through
 * the guard's HTTPS agent, the OAuth token request (which carries the client secret) included.
 * Real axios and the real guard; DNS is stubbed and the TLS connect stops right after the agent's
 * lookup, so no request leaves the process.
 */
import {
  STOPPED_BEFORE_CONNECT,
  stubOutboundConnections,
  v4,
  type OutboundConnect,
} from '@testing/stub-outbound-connect';
import { ServiceNowClient } from './servicenow.client';
import type { ServiceNowConfig } from './servicenow.interface';

const INSTANCE = 'https://acme.service-now.test';
const basicAuth = (instanceUrl: string): ServiceNowConfig => ({
  instanceUrl,
  clientId: '',
  clientSecret: '',
  username: 'euroid',
  password: 'secret',
});

describe('ServiceNowClient: where a request connects', () => {
  let connects: OutboundConnect[];
  let answerDns: ReturnType<typeof stubOutboundConnections>['answerDns'];
  const client = new ServiceNowClient();

  beforeEach(() => {
    ({ connects, answerDns } = stubOutboundConnections());
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each(['https://169.254.169.254', 'http://127.0.0.1', 'https://localhost'])(
    'refuses the instance URL %s before any lookup or connect',
    async (url) => {
      await expect(client.getUser(basicAuth(url), 'ada@acme.test')).rejects.toThrow(
        /blocked|Only HTTPS/,
      );
      expect(connects).toEqual([]);
    },
  );

  it('is unhealthy for a refused instance URL, without connecting', async () => {
    await expect(client.healthCheck(basicAuth('https://169.254.169.254'))).resolves.toBe(false);
    expect(connects).toEqual([]);
  });

  it('connects to the address the agent checked, with TLS verified for the instance', async () => {
    answerDns([v4('93.184.215.14')]);

    await expect(client.getUser(basicAuth(INSTANCE), 'ada@acme.test')).rejects.toThrow(
      STOPPED_BEFORE_CONNECT,
    );

    expect(connects).toEqual([
      expect.objectContaining({
        host: 'acme.service-now.test',
        servername: 'acme.service-now.test',
        addresses: [v4('93.184.215.14')],
      }),
    ]);
    expect(connects[0]!.rejectUnauthorized).not.toBe(false);
  });

  it('refuses an instance host whose address is private at connect', async () => {
    answerDns([v4('10.0.0.5')]);

    await expect(client.getUser(basicAuth(INSTANCE), 'ada@acme.test')).rejects.toThrow(
      /Refused to connect to acme\.service-now\.test/,
    );
    expect(connects[0]!.addresses).toBeUndefined();
  });

  it('sends the OAuth token request, with the client secret, through the agent too', async () => {
    answerDns([v4('169.254.169.254')]);
    const oauth: ServiceNowConfig = {
      instanceUrl: INSTANCE,
      clientId: 'client-a',
      clientSecret: 'secret-a',
    };

    // The token request is refused at connect; Basic auth has no credentials to fall back to
    await expect(client.getUser(oauth, 'ada@acme.test')).rejects.toThrow(/No valid auth/);
    expect(connects).toEqual([
      expect.objectContaining({
        host: 'acme.service-now.test',
        error: expect.stringMatching(/^Refused to connect to acme\.service-now\.test/),
      }),
    ]);
  });
});
