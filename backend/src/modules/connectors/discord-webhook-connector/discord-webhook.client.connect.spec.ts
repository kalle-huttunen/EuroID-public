/**
 * SSRF (FOLLOWUPS 2026-11-24, discord-webhook.client.ts): the tenant's webhook URL was fetched
 * without the SSRF guard. The client now checks the URL before each request and connects through
 * the guard's HTTPS agent. Real axios and the real guard; DNS is stubbed and the TLS connect
 * stops right after the agent's lookup, so no request leaves the process.
 */
import {
  STOPPED_BEFORE_CONNECT,
  stubOutboundConnections,
  v4,
  type OutboundConnect,
} from '@testing/stub-outbound-connect';
import { DiscordWebhookClient } from './discord-webhook.client';

const WEBHOOK = 'https://discord.com/api/webhooks/123/token-abc';

describe('DiscordWebhookClient: where a request connects', () => {
  let connects: OutboundConnect[];
  let answerDns: ReturnType<typeof stubOutboundConnections>['answerDns'];
  const client = new DiscordWebhookClient();

  beforeEach(() => {
    ({ connects, answerDns } = stubOutboundConnections());
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each([
    'https://169.254.169.254/api/webhooks/1/t',
    'http://127.0.0.1/api/webhooks/1/t',
    'https://metadata.google.internal/api/webhooks/1/t',
  ])('refuses to post to %s before any lookup or connect', async (webhookUrl) => {
    await expect(client.postMessage({ webhookUrl }, 'Welcome')).rejects.toThrow(
      /blocked|Only HTTPS/,
    );
    expect(connects).toEqual([]);
  });

  it('is unhealthy for a refused webhook URL, without connecting', async () => {
    await expect(
      client.healthCheck({ webhookUrl: 'https://169.254.169.254/api/webhooks/1/t' }),
    ).resolves.toBe(false);
    expect(connects).toEqual([]);
  });

  it('connects to the address the agent checked, with TLS verified for the host', async () => {
    answerDns([v4('162.159.135.232')]);

    await expect(client.postMessage({ webhookUrl: WEBHOOK }, 'Welcome')).rejects.toThrow(
      STOPPED_BEFORE_CONNECT,
    );

    expect(connects).toEqual([
      expect.objectContaining({
        host: 'discord.com',
        servername: 'discord.com',
        addresses: [v4('162.159.135.232')],
      }),
    ]);
    expect(connects[0]!.rejectUnauthorized).not.toBe(false);
  });

  it('refuses a webhook host whose address is private at connect', async () => {
    answerDns([v4('127.0.0.1')]);

    await expect(client.postMessage({ webhookUrl: WEBHOOK }, 'Welcome')).rejects.toThrow(
      /Refused to connect to discord\.com/,
    );
    expect(connects[0]!.addresses).toBeUndefined();
  });
});
