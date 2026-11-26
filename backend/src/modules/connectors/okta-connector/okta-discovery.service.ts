/**
 * OktaDiscoveryService — Read-only Okta operations.
 *
 * Discovers entitlements (groups + applications) and performs health checks.
 * Dumb pipe: no business logic, just fetches data and maps to entitlement format.
 */

import { Injectable, Logger } from '@nestjs/common';
import { OktaClient } from './okta.client';
import { OktaConfig } from './okta.interface';
import { OKTA_SYSTEM } from './okta.constants';
import type { ConnectorCapability } from '../plugin/connector-manifest.interface';

@Injectable()
export class OktaDiscoveryService {
  private readonly logger = new Logger(OktaDiscoveryService.name);

  constructor(private readonly client: OktaClient) {}

  /**
   * Health check — verify connectivity to Okta org.
   */
  async healthCheck(config: OktaConfig): Promise<boolean> {
    return this.client.healthCheck(config);
  }

  /**
   * Validate which capabilities work given current API token permissions.
   */
  async validateCapabilities(config: OktaConfig): Promise<ConnectorCapability[]> {
    const caps: ConnectorCapability[] = [];
    try {
      const healthy = await this.client.healthCheck(config);
      if (!healthy) return ['healthCheck'];
      caps.push('healthCheck');

      // Test discovery: try listing groups
      try {
        await this.client.listGroups(config);
        caps.push('discover');
      } catch {
        this.logger.warn('[VALIDATE] Group listing unavailable');
      }

      // Assume provision/deprovision if basic auth works
      caps.push('provision', 'deprovision');
      return caps;
    } catch {
      return ['healthCheck'];
    }
  }

  /**
   * Discover entitlements: groups + applications.
   * Returns normalized entitlement list for the entitlement catalog.
   */
  async discoverEntitlements(
    config: OktaConfig,
  ): Promise<Array<{ nativeId: string; name: string; type: string; system?: string }>> {
    const [groups, apps] = await Promise.all([
      this.client.listGroups(config).catch((e) => {
        this.logger.warn(
          `[DISCOVER] Groups unavailable: ${e instanceof Error ? e.message : String(e)}`,
        );
        return [];
      }),
      this.client.listApplications(config).catch((e) => {
        this.logger.warn(
          `[DISCOVER] Applications unavailable: ${e instanceof Error ? e.message : String(e)}`,
        );
        return [];
      }),
    ]);

    const groupEntitlements = groups.map((g) => ({
      nativeId: g.id,
      name: g.profile.name,
      type: 'Group' as const,
      system: OKTA_SYSTEM,
    }));

    const appEntitlements = apps.map((a) => ({
      nativeId: a.id,
      name: a.label || a.name,
      type: 'Application' as const,
      system: OKTA_SYSTEM,
    }));

    const all = [...groupEntitlements, ...appEntitlements];
    this.logger.log(
      `[DISCOVER] Found ${groupEntitlements.length} groups, ${appEntitlements.length} applications`,
    );
    return all;
  }
}
