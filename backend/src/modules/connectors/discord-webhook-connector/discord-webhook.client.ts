/**
 * DiscordWebhookClient — HTTP client for Discord webhook API.
 */

import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import { DiscordWebhookConfig } from './discord-webhook.interface';
import { CONNECTOR_TIMEOUT_MS } from '@infrastructure/config/defaults';
import {
  checkUrlWithoutDns,
  createSsrfSafeHttpsAgent,
} from '@infrastructure/url-validation/ssrf-guard';

/**
 * The webhook URL is the tenant's: each request checks it first (https, no blocked name or IP
 * literal) and connects through the SSRF guard's agent, which checks every address the host
 * resolves to (connectors ARCHITECTURE.md, SSRF Protection).
 */
@Injectable()
export class DiscordWebhookClient {
  private readonly logger = new Logger(DiscordWebhookClient.name);
  private readonly axios: AxiosInstance = axios.create({
    timeout: CONNECTOR_TIMEOUT_MS,
    headers: { 'Content-Type': 'application/json' },
    // The agent must make the connection it checked: no redirect, no proxy from the environment
    maxRedirects: 0,
    httpsAgent: createSsrfSafeHttpsAgent(),
    proxy: false,
  });

  /**
   * POST a message to the Discord webhook.
   * @returns true if 200/204
   */
  async postMessage(config: DiscordWebhookConfig, content: string): Promise<boolean> {
    checkUrlWithoutDns(config.webhookUrl);
    const res = await this.axios.post(config.webhookUrl, { content });
    return res.status === 200 || res.status === 204;
  }

  /**
   * Health check without posting: GET on the webhook URL (Discord's "Get Webhook with Token",
   * no auth beyond the token in the URL) answers with the webhook object and sends nothing to
   * the channel. A wrong id or token is an error status; a URL that answers with something else
   * than a webhook object, or one the SSRF guard refuses, is unhealthy too.
   */
  async healthCheck(config: DiscordWebhookConfig): Promise<boolean> {
    try {
      checkUrlWithoutDns(config.webhookUrl);
      const res = await this.axios.get<{ id?: unknown }>(config.webhookUrl);
      return res.status === 200 && typeof res.data?.id === 'string';
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[HEALTH] Discord webhook check failed: ${message}`);
      return false;
    }
  }
}
