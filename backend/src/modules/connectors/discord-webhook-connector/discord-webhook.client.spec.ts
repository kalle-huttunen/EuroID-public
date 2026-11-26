import axios from 'axios';
import { fakeHttp, httpError } from '@testing/fake-http';
import { DiscordWebhookClient } from './discord-webhook.client';

jest.mock('axios');

const config = { webhookUrl: 'https://discord.com/api/webhooks/123/token-abc' };
/** Discord's webhook object, as GET on the webhook URL (Get Webhook with Token) returns it. */
const webhookObject = { id: '123', type: 1, name: 'EuroID', channel_id: '456', token: 'token-abc' };

describe('DiscordWebhookClient', () => {
  function clientAgainst(handler: Parameters<typeof fakeHttp>[0]) {
    const discord = fakeHttp(handler);
    (axios.create as jest.Mock).mockReturnValue(discord.instance);
    return { client: new DiscordWebhookClient(), discord };
  }

  describe('healthCheck', () => {
    it('reads the webhook without posting anything to the channel', async () => {
      const { client, discord } = clientAgainst(() => webhookObject);

      await expect(client.healthCheck(config)).resolves.toBe(true);

      expect(discord.calls).toEqual([{ method: 'GET', url: config.webhookUrl }]);
      expect(discord.writes()).toEqual([]);
    });

    it('is unhealthy when Discord does not know the webhook or its token', async () => {
      const { client, discord } = clientAgainst(() => {
        throw httpError(404, {}, { message: 'Unknown Webhook', code: 10015 });
      });

      await expect(client.healthCheck(config)).resolves.toBe(false);
      expect(discord.writes()).toEqual([]);
    });

    it('is unhealthy when the URL answers but not with a webhook', async () => {
      const { client } = clientAgainst(() => '<html>not discord</html>');

      await expect(client.healthCheck(config)).resolves.toBe(false);
    });
  });

  describe('postMessage', () => {
    it('posts the message content to the webhook', async () => {
      const { client, discord } = clientAgainst(() => undefined);

      await expect(client.postMessage(config, 'Welcome')).resolves.toBe(true);

      expect(discord.writes()).toEqual([
        { method: 'POST', url: config.webhookUrl, data: { content: 'Welcome' } },
      ]);
    });
  });
});
