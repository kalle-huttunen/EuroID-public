/**
 * DiscordWebhookConnector — Config and types.
 *
 * Low-friction dev connector: POSTs a welcome message to a Discord webhook.
 */

/** Configuration for DiscordWebhookConnector */
export interface DiscordWebhookConfig {
  /** Discord webhook URL (e.g. https://discord.com/api/webhooks/...) */
  webhookUrl: string;
}
