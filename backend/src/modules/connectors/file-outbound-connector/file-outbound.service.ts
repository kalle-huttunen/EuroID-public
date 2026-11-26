/**
 * FileOutboundConnector — Appends provisioning intent to a local JSONL file.
 *
 * Low-friction dev connector. Implements IConnector.
 * Idempotency: File append is inherently append-only. Same user provisioned twice = two lines.
 * Documented in manifest.
 *
 * Sandbox: the output file must be inside FILE_OUTBOUND_ALLOWED_DIR (required in production;
 * the working directory otherwise), checked on the real path, symlinks resolved, before anything
 * is written or created. Errors name no server path; the log does.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConnectorException } from '@shared/exceptions/domain-exceptions';
import * as fs from 'fs/promises';
import * as path from 'path';
import { IConnector } from '../connector.interface';
import { StandardUserDto } from '@shared/dtos/standard-user.dto';
import { FileOutboundConfig, FileOutboundPayload } from './file-outbound.interface';
import { ProvisioningIntent } from '@shared/interfaces/provisioning.interface';
import { ConnectorConfigService } from '../connector-config.service';
import { ConnectorConfigDecryptError } from '../connector-config.errors';
import { maskEmail } from '../../identity/identity-pii';
import { realpathInside } from '../sandboxed-path';

const CONNECTOR_ID = 'file-outbound';

@Injectable()
export class FileOutboundService implements IConnector {
  private readonly logger = new Logger(FileOutboundService.name);

  constructor(private readonly connectorConfig: ConnectorConfigService) {}

  /**
   * Create (provision) — appends user + intent to output file as JSONL.
   * Config from ConnectorConfigService (install connector first).
   */
  async create(user: StandardUserDto, intent?: unknown): Promise<{ targetUserId: string }> {
    const cfg = await this.getConfig();
    return this.provision(cfg, user, intent as ProvisioningIntent | undefined);
  }

  async healthCheck(config?: unknown): Promise<boolean> {
    let cfg: FileOutboundConfig;
    try {
      cfg = (config ?? (await this.getConfig())) as FileOutboundConfig;
    } catch (err: unknown) {
      // Not unhealthy: a process with the right key can read it (503, retried)
      if (err instanceof ConnectorConfigDecryptError) throw err;
      return false;
    }
    let resolvedPath: string;
    try {
      resolvedPath = this.sandboxedOutputPath(cfg.outputFilePath);
    } catch {
      return false;
    }
    const dir = path.dirname(resolvedPath);

    try {
      await fs.access(dir, fs.constants.W_OK);
      await fs.appendFile(resolvedPath, '');
      return true;
    } catch {
      try {
        await fs.mkdir(dir, { recursive: true });
        await fs.appendFile(resolvedPath, '');
        return true;
      } catch {
        return false;
      }
    }
  }

  /**
   * Provision with explicit config (for activities/callers that pass config).
   */
  async provision(
    config: FileOutboundConfig,
    user: StandardUserDto,
    intent?: ProvisioningIntent,
  ): Promise<{ targetUserId: string }> {
    const resolvedPath = this.sandboxedOutputPath(config.outputFilePath);

    const payload: FileOutboundPayload = {
      timestamp: new Date().toISOString(),
      user: {
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        jobTitle: user.jobTitle,
        departmentName: user.departmentName,
      },
      intent,
    };

    const line = JSON.stringify(payload) + '\n';
    await fs.appendFile(resolvedPath, line);

    const targetUserId = `file-${Date.now()}-${user.email}`;
    this.logger.log(`[PROVISION] Appended to ${resolvedPath}: ${maskEmail(user.email)}`);
    return { targetUserId };
  }

  /**
   * The output file's real path inside FILE_OUTBOUND_ALLOWED_DIR (relative paths resolve
   * against it). Outside it, unresolvable, or no directory set in production: 400.
   */
  private sandboxedOutputPath(outputFilePath: string): string {
    const envDir = process.env.FILE_OUTBOUND_ALLOWED_DIR;
    if (process.env.NODE_ENV === 'production' && !envDir) {
      throw new ConnectorException(
        'FileOutboundConnector: FILE_OUTBOUND_ALLOWED_DIR is required in production. Set it to ' +
          'the directory the output files may be written to.',
      );
    }
    const allowedDir = envDir || process.cwd();
    let resolved: string | undefined;
    try {
      resolved = realpathInside(allowedDir, String(outputFilePath ?? ''));
    } catch (err: unknown) {
      this.logger.warn(
        `FileOutboundConnector: cannot resolve ${outputFilePath} under ${allowedDir}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      throw new ConnectorException(
        'FileOutboundConnector: The output file path cannot be resolved by the server',
      );
    }
    if (!resolved) {
      this.logger.warn(
        `FileOutboundConnector: ${outputFilePath} is outside ${allowedDir}: refused`,
      );
      throw new ConnectorException(
        'FileOutboundConnector: The output file path is outside the allowed directory ' +
          '(FILE_OUTBOUND_ALLOWED_DIR)',
      );
    }
    return resolved;
  }

  private async getConfig(): Promise<FileOutboundConfig> {
    const doc = await this.connectorConfig.getConfig(CONNECTOR_ID);
    if (!doc?.config?.outputFilePath) {
      throw new ConnectorException(
        'FileOutboundConnector: not configured. Install with outputFilePath.',
      );
    }
    return doc.config as unknown as FileOutboundConfig;
  }
}
