/**
 * 2.0dx: the client checked the feed URL (validateUrlForFetch) and then let axios resolve the
 * host again, so a DNS answer that changed in between (DNS rebinding) could take the request, and
 * its credentials, to a private or cloud metadata address. It now connects through the SSRF
 * guard's HTTPS agent, whose lookup checks the addresses the socket gets. Real axios and the real
 * guard; DNS is stubbed and the TLS connect stops right after the agent's lookup.
 */
import {
  STOPPED_BEFORE_CONNECT,
  stubOutboundConnections,
  v4,
  type OutboundConnect,
} from '@testing/stub-outbound-connect';
import { JsonApiHrClient } from './json-api-hr.client';

const FEED = 'https://hr.example.com/api/users';

describe('JsonApiHrClient: where a request connects', () => {
  let connects: OutboundConnect[];
  let answerDns: ReturnType<typeof stubOutboundConnections>['answerDns'];
  const client = new JsonApiHrClient();

  beforeEach(() => {
    ({ connects, answerDns } = stubOutboundConnections());
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each([
    'https://169.254.169.254/api/users',
    'https://[::1]/api/users',
    'http://hr.example.com/api/users',
  ])('refuses the feed URL %s before any lookup or connect', async (url) => {
    await expect(
      client.fetch({ url, auth: { type: 'bearer', token: 'hr-token-123' } }),
    ).rejects.toThrow(/blocked|Only HTTPS/);
    expect(connects).toEqual([]);
  });

  it('refuses a blocked feed URL in the health check, before any lookup or connect', async () => {
    await expect(client.probe({ url: 'https://169.254.169.254/api/users' }, 2000)).rejects.toThrow(
      /blocked/,
    );
    expect(connects).toEqual([]);
  });

  it('connects to the address the agent checked, with TLS verified for the feed host', async () => {
    answerDns([v4('93.184.215.14')]);

    await expect(client.fetch({ url: FEED })).rejects.toThrow(STOPPED_BEFORE_CONNECT);

    expect(connects).toEqual([
      expect.objectContaining({
        host: 'hr.example.com',
        servername: 'hr.example.com',
        addresses: [v4('93.184.215.14')],
      }),
    ]);
    expect(connects[0]!.rejectUnauthorized).not.toBe(false);
  });

  it('refuses a host that was public for the URL check and is private at connect', async () => {
    answerDns([v4('93.184.215.14')], [v4('169.254.169.254')]);

    await expect(
      client.fetch({ url: FEED, auth: { type: 'bearer', token: 'hr-token-123' } }),
    ).rejects.toThrow(/Refused to connect to hr\.example/);

    expect(connects).toEqual([
      expect.objectContaining({
        host: 'hr.example.com',
        error: expect.stringMatching(/^Refused to connect to hr\.example\.com/),
      }),
    ]);
    expect(connects[0]!.addresses).toBeUndefined();
  });

  it('refuses it in the health check too', async () => {
    answerDns([v4('93.184.215.14')], [v4('10.0.0.5')]);

    await expect(client.probe({ url: FEED }, 2000)).rejects.toThrow(/Refused to connect/);
    expect(connects[0]!.addresses).toBeUndefined();
  });
});
