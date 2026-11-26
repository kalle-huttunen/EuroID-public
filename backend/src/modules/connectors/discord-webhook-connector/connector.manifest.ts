import { ConnectorManifest } from '../plugin/connector-manifest.interface';
import { DiscordWebhookConnectorModule } from './discord-webhook.module';

export const discordWebhookManifest: ConnectorManifest = {
  id: 'discord-webhook',
  name: 'Discord Webhook',
  version: '1.0.0',
  description: 'Dev connector: POSTs a welcome message to a Discord webhook on provision.',
  icon: 'MessageOutlined',
  capabilities: ['provision', 'healthCheck'],
  configSchema: [
    {
      key: 'webhookUrl',
      label: 'Webhook URL',
      // The URL embeds the webhook token, so it is a secret.
      type: 'password',
      required: true,
      placeholder: 'https://discord.com/api/webhooks/...',
      description: 'Discord webhook URL for the target channel',
    },
  ],
  module: DiscordWebhookConnectorModule,
};
