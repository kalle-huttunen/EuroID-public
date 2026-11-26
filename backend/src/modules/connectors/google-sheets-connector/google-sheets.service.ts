/**
 * GoogleSheetsConnector — Appends user rows to a Google Sheet.
 *
 * Low-friction dev connector. Implements IConnector.
 */

import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { IConnector } from '../connector.interface';
import { StandardUserDto } from '@shared/dtos/standard-user.dto';
import { GoogleSheetsConfig } from './google-sheets.interface';
import { GoogleSheetsClient } from './google-sheets.client';
import { ConnectorConfigService } from '../connector-config.service';
import { ConnectorConfigDecryptError } from '../connector-config.errors';
import { maskEmail } from '../../identity/identity-pii';

const CONNECTOR_ID = 'google-sheets';

@Injectable()
export class GoogleSheetsService implements IConnector {
  private readonly logger = new Logger(GoogleSheetsService.name);

  constructor(
    private readonly client: GoogleSheetsClient,
    private readonly connectorConfig: ConnectorConfigService,
  ) {}

  /**
   * Create (provision) — appends user row to Google Sheet.
   */
  async create(user: StandardUserDto, _intent?: unknown): Promise<{ targetUserId: string }> {
    const cfg = await this.getConfig();
    return this.provision(cfg, user);
  }

  async healthCheck(config?: unknown): Promise<boolean> {
    let cfg: GoogleSheetsConfig;
    try {
      cfg = (config ?? (await this.getConfig())) as GoogleSheetsConfig;
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
    config: GoogleSheetsConfig,
    user: StandardUserDto,
  ): Promise<{ targetUserId: string }> {
    const result = await this.client.appendRow(config, user);
    this.logger.log(`[PROVISION] Appended ${maskEmail(user.email)} to Google Sheet`);
    return result;
  }

  private async getConfig(): Promise<GoogleSheetsConfig> {
    const doc = await this.connectorConfig.getConfig(CONNECTOR_ID);
    if (!doc?.config?.sheetId || !doc?.config?.serviceAccountJson) {
      throw new BadRequestException(
        'GoogleSheetsConnector: not configured. Install with sheetId and serviceAccountJson.',
      );
    }
    return {
      sheetId: doc.config.sheetId,
      serviceAccountJson: doc.config.serviceAccountJson,
      sheetName: doc.config.sheetName,
    } as GoogleSheetsConfig;
  }
}
