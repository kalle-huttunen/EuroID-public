/**
 * DiscordWebhookConnector — POSTs welcome message to Discord webhook.
 *
 * Low-friction dev connector. Implements IConnector.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConnectorException } from '@shared/exceptions/domain-exceptions';
import { IConnector } from '../connector.interface';
import { StandardUserDto } from '@shared/dtos/standard-user.dto';
import { DiscordWebhookConfig } from './discord-webhook.interface';
import { DiscordWebhookClient } from './discord-webhook.client';
import { ProvisioningIntent } from '@shared/interfaces/provisioning.interface';
import { ConnectorConfigService } from '../connector-config.service';
import { ConnectorConfigDecryptError } from '../connector-config.errors';
import { maskEmail } from '../../identity/identity-pii';

const CONNECTOR_ID = 'discord-webhook';

@Injectable()
export class DiscordWebhookService implements IConnector {
  private readonly logger = new Logger(DiscordWebhookService.name);

  constructor(
    private readonly client: DiscordWebhookClient,
    private readonly connectorConfig: ConnectorConfigService,
  ) {}

  /**
   * Create (provision) — POSTs welcome message to Discord webhook.
   */
  async create(user: StandardUserDto, intent?: unknown): Promise<{ targetUserId: string }> {
    const cfg = await this.getConfig();
    return this.provision(cfg, user, intent as ProvisioningIntent | undefined);
  }

  async healthCheck(config?: unknown): Promise<boolean> {
    let cfg: DiscordWebhookConfig;
    try {
      cfg = (config ?? (await this.getConfig())) as DiscordWebhookConfig;
    } catch (err: unknown) {
      // Not unhealthy: a process with the right key can read it (503, retried)
      if (err instanceof ConnectorConfigDecryptError) throw err;
      return false;
    }
    return this.client.healthCheck(cfg);
  }

  /**
   * Provision with explicit config (for activities/callers that pass config).
   */
  async provision(
    config: DiscordWebhookConfig,
    user: StandardUserDto,
    _intent?: ProvisioningIntent,
  ): Promise<{ targetUserId: string }> {
    const message = `User ${user.email} (${user.jobTitle ?? 'N/A'}) provisioned!`;
    await this.client.postMessage(config, message);
    this.logger.log(`[PROVISION] Posted to Discord: ${maskEmail(user.email)}`);
    return { targetUserId: `discord-${user.email}` };
  }

  private async getConfig(): Promise<DiscordWebhookConfig> {
    const doc = await this.connectorConfig.getConfig(CONNECTOR_ID);
    if (!doc?.config?.webhookUrl) {
      throw new ConnectorException(
        'DiscordWebhookConnector: not configured. Install with webhookUrl.',
      );
    }
    return doc.config as unknown as DiscordWebhookConfig;
  }
}
