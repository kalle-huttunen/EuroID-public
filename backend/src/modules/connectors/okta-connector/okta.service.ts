/**
 * OktaService — Facade implementing IConnector.
 *
 * Thin delegation layer over OktaDiscoveryService and OktaProvisioningService.
 * Resolves OktaConfig from ConnectorConfigService (MongoDB), or env vars when none is installed.
 *
 * All consumers import OktaService — this keeps imports stable while
 * the implementation is split across focused sub-services.
 */

import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IOktaConnector, OktaConfig, OktaGroup, OktaProvisioningIntent } from './okta.interface';
import { OktaDiscoveryService } from './okta-discovery.service';
import { OktaProvisioningService } from './okta-provisioning.service';
import { ConnectorConfigService } from '../connector-config.service';
import { ConnectorException } from '@shared/exceptions/domain-exceptions';
import { StandardUserDto } from '@shared/dtos/standard-user.dto';
import { ProvisioningResult } from '@shared/dtos/provisioning-result.dto';
import type { ConnectorCapability } from '../plugin/connector-manifest.interface';
import type { DeprovisionResult } from '@shared/types/deprovision';
import type { PamAccountResult, PamAccountStatus } from '@shared/types/pam-session';

const CONNECTOR_ID = 'okta';
/** Settings an installed Okta config must have: the org and the API token. */
const REQUIRED_SETTINGS = ['orgUrl', 'apiToken'] as const;

@Injectable()
export class OktaService implements IOktaConnector {
  private readonly logger = new Logger(OktaService.name);

  constructor(
    private readonly discovery: OktaDiscoveryService,
    private readonly provisioning: OktaProvisioningService,
    private readonly connectorConfig: ConnectorConfigService,
    private readonly configService: ConfigService,
  ) {}

  // ── IConnector: create ──

  async create(user: StandardUserDto, intent?: unknown): Promise<{ targetUserId: string }> {
    const config = await this.resolveConfig();
    const result = await this.provisioning.provision(
      config,
      user,
      intent as OktaProvisioningIntent | undefined,
    );
    return { targetUserId: result.targetUserId };
  }

  // ── IConnector: discover ──

  async discover(
    config?: OktaConfig,
  ): Promise<Array<{ nativeId: string; name: string; type: string }>> {
    const cfg = config ?? (await this.resolveConfig());
    return this.discovery.discoverEntitlements(cfg);
  }

  // ── IConnector: healthCheck ──

  async healthCheck(config?: unknown): Promise<boolean> {
    let cfg: OktaConfig;
    try {
      cfg = (config ?? (await this.resolveConfig())) as OktaConfig;
    } catch (err: unknown) {
      // A config error (none, or incomplete) is unhealthy. A failed read is not: a stored config
      // this process cannot decrypt (503) or an unreachable MongoDB fails the check, retried.
      if (err instanceof ConnectorException) return false;
      throw err;
    }
    return this.discovery.healthCheck(cfg);
  }

  // ── IConnector: validateCapabilities ──

  async validateCapabilities(config?: unknown): Promise<ConnectorCapability[]> {
    let cfg: OktaConfig;
    try {
      cfg = (config ?? (await this.resolveConfig())) as OktaConfig;
    } catch {
      return ['healthCheck'];
    }
    return this.discovery.validateCapabilities(cfg);
  }

  // ── Extended: provision with full result ──

  async provision(
    user: StandardUserDto,
    intent?: OktaProvisioningIntent,
    config?: OktaConfig,
  ): Promise<ProvisioningResult> {
    const cfg = config ?? (await this.resolveConfig());
    return this.provisioning.provision(cfg, user, intent);
  }

  // ── Extended: deactivate user ──

  async deactivateUser(oktaUserId: string, config?: OktaConfig): Promise<void> {
    const cfg = config ?? (await this.resolveConfig());
    return this.provisioning.deactivateUser(cfg, oktaUserId);
  }

  // ── Extended: deprovision (deactivate + delete) ──

  async deprovision(oktaUserId: string, config?: OktaConfig): Promise<void> {
    const cfg = config ?? (await this.resolveConfig());
    return this.provisioning.deprovision(cfg, oktaUserId);
  }

  // ── Offboarding: deactivate (or deactivate + delete, per deprovisionStrategy) ──

  async offboardUser(
    user: { oktaUserId?: string; login: string },
    config?: OktaConfig,
  ): Promise<DeprovisionResult> {
    const cfg = config ?? (await this.resolveConfig());
    return this.provisioning.offboardUser(cfg, user);
  }

  // ── Privileged session: suspend or unsuspend a linked admin account ──

  async setUserEnabled(
    user: { oktaUserId?: string; login: string },
    enabled: boolean,
    config?: OktaConfig,
  ): Promise<PamAccountResult> {
    const cfg = config ?? (await this.resolveConfig());
    return this.provisioning.setUserEnabled(cfg, user, enabled);
  }

  /** The user's status, read only (the hourly PAM sweep); null when Okta has no such user. */
  async getUserStatus(
    user: { oktaUserId?: string; login: string },
    config?: OktaConfig,
  ): Promise<PamAccountStatus | null> {
    const cfg = config ?? (await this.resolveConfig());
    return this.provisioning.getUserStatus(cfg, user);
  }

  // ── Group membership (access review revocation, mover) ──

  async findUserIdByLogin(login: string, config?: OktaConfig): Promise<string | null> {
    const cfg = config ?? (await this.resolveConfig());
    return this.provisioning.findUserIdByLogin(cfg, login);
  }

  async listUserGroups(oktaUserId: string, config?: OktaConfig): Promise<OktaGroup[] | null> {
    const cfg = config ?? (await this.resolveConfig());
    return this.provisioning.listUserGroups(cfg, oktaUserId);
  }

  async removeGroupMember(groupId: string, oktaUserId: string, config?: OktaConfig): Promise<void> {
    const cfg = config ?? (await this.resolveConfig());
    return this.provisioning.removeGroupMember(cfg, groupId, oktaUserId);
  }

  async addGroupMember(groupId: string, oktaUserId: string, config?: OktaConfig): Promise<void> {
    const cfg = config ?? (await this.resolveConfig());
    return this.provisioning.addGroupMember(cfg, groupId, oktaUserId);
  }

  // ── Config Resolution ──

  /**
   * Resolve OktaConfig from ConnectorConfigService (MongoDB) or env vars.
   * ConnectorConfigService takes priority (runtime config from Design Studio). An installed
   * config is the tenant's: one without an org URL or API token is a configuration error (400)
   * naming the empty settings, never completed from the OKTA_* variables (the deployment's own
   * org), as for Entra ID (plan 2.0db). Only a tenant without an installed config uses them. A
   * failed read (a stored config this process cannot decrypt, MongoDB unreachable) propagates
   * like Entra ID's: whether a config is installed is unknown then, so OKTA_* is never used.
   */
  private async resolveConfig(overrideConfig?: OktaConfig): Promise<OktaConfig> {
    if (overrideConfig) return overrideConfig;

    const doc = await this.connectorConfig.getConfig(CONNECTOR_ID);
    if (doc) {
      const c = (doc.config ?? {}) as unknown as Record<string, string | undefined>;
      const empty = REQUIRED_SETTINGS.filter((key) => !String(c[key] ?? '').trim());
      if (empty.length > 0) {
        throw new ConnectorException(
          `Okta config is incomplete (empty: ${empty.join(', ')}): set the org URL and API ` +
            'token in the Okta connector config.',
          HttpStatus.BAD_REQUEST,
        );
      }
      return {
        orgUrl: c.orgUrl as string,
        apiToken: c.apiToken as string,
        defaultGroupId: c.defaultGroupId || undefined,
        deprovisionStrategy: this.strategyOf(c.deprovisionStrategy),
      };
    }

    // Fallback to env vars
    const orgUrl = this.configService.get<string>('OKTA_ORG_URL');
    const apiToken = this.configService.get<string>('OKTA_API_TOKEN');

    if (!orgUrl || !apiToken) {
      throw new ConnectorException(
        'OktaConnector: not configured. Set OKTA_ORG_URL and OKTA_API_TOKEN, or install via Design Studio.',
      );
    }

    return {
      orgUrl,
      apiToken,
      defaultGroupId: this.configService.get<string>('OKTA_DEFAULT_GROUP_ID') || undefined,
      deprovisionStrategy: this.strategyOf(
        this.configService.get<string>('OKTA_DEPROVISION_STRATEGY'),
      ),
    };
  }

  /** 'delete' or 'deactivate'; anything else (unset) is the default, deactivate. */
  private strategyOf(value: string | undefined): OktaConfig['deprovisionStrategy'] {
    return value === 'delete' ? 'delete' : 'deactivate';
  }
}
