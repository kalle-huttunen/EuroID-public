/**
 * Each registered connector's own health check, by connector id, for ConnectorHealthService.
 *
 * Entra ID, AD and SCIM go through their activities, as POST /connectors/:name/health-check does,
 * with the tenant's saved config. The other connectors' services load their saved config
 * themselves (ConnectorConfigService, tenant from the request context); the HR sources take it as
 * an argument. A check resolves to whether the connector answered as healthy.
 */
import type { AdConfig } from './ad-connector/ad.interface';
import type { EntraConfig } from './entra-connector/entra.interface';
import type { SCIMConnectorConfig } from './scim-connector/scim.interface';
import type { EntraActivities } from '../../activities/entra.activities';
import type { AdActivities } from '../../activities/ad.activities';
import type { ScimActivities } from '../../activities/scim.activities';

/** Injection token for the map of health checks (ConnectorConfigModule builds it). */
export const CONNECTOR_HEALTH_CHECKS = Symbol('CONNECTOR_HEALTH_CHECKS');

export type ConnectorHealthCheck = (
  config: Record<string, string>,
  tenantId: string,
) => Promise<boolean>;

/** A connector service whose healthCheck loads its saved config when given none. */
interface SelfConfiguredHealth {
  healthCheck(): Promise<boolean>;
}

/** An HR source service: its healthCheck needs the saved config. */
interface ConfiguredHealth {
  healthCheck(config: Record<string, unknown>): Promise<boolean>;
}

export interface ConnectorHealthCheckDeps {
  entra: Pick<EntraActivities, 'checkEntraHealth'>;
  ad: Pick<AdActivities, 'checkAdHealthEnriched'>;
  scim: Pick<ScimActivities, 'checkScimHealth'>;
  okta: SelfConfiguredHealth;
  serviceNow: SelfConfiguredHealth;
  gitHub: SelfConfiguredHealth;
  googleSheets: SelfConfiguredHealth;
  discordWebhook: SelfConfiguredHealth;
  fileOutbound: SelfConfiguredHealth;
  csvHr: ConfiguredHealth;
  jsonApiHr: ConfiguredHealth;
}

export function buildConnectorHealthChecks(
  deps: ConnectorHealthCheckDeps,
): Record<string, ConnectorHealthCheck> {
  return {
    'entra-id': (config, tenantId) =>
      deps.entra.checkEntraHealth(
        Object.keys(config).length ? (config as unknown as EntraConfig) : undefined,
        tenantId,
      ),
    ad: async (config, tenantId) =>
      (await deps.ad.checkAdHealthEnriched(coerceAdConfig(config), tenantId)).connected,
    scim: async (config, tenantId) => {
      const scimConfig = coerceScimConfig(config);
      return scimConfig ? (await deps.scim.checkScimHealth(scimConfig, tenantId)).healthy : false;
    },
    okta: () => deps.okta.healthCheck(),
    servicenow: () => deps.serviceNow.healthCheck(),
    github: () => deps.gitHub.healthCheck(),
    'google-sheets': () => deps.googleSheets.healthCheck(),
    'discord-webhook': () => deps.discordWebhook.healthCheck(),
    'file-outbound': () => deps.fileOutbound.healthCheck(),
    'csv-hr': (config) => deps.csvHr.healthCheck(config),
    'json-api-hr': (config) => deps.jsonApiHr.healthCheck(config),
  };
}

/** SCIM config from the saved (string) config; null without a base URL. */
export function coerceScimConfig(raw: Record<string, string>): SCIMConnectorConfig | null {
  const baseUrl = raw.baseUrl?.trim();
  if (!baseUrl) return null;
  const authType = (raw.authType as SCIMConnectorConfig['authType']) || 'bearer';
  return {
    baseUrl,
    authType,
    bearerToken: raw.bearerToken,
    username: raw.username,
    password: raw.password,
    oauth2TokenUrl: raw.oauth2TokenUrl,
    clientId: raw.clientId,
    clientSecret: raw.clientSecret,
    deprovisionStrategy: raw.deprovisionStrategy as SCIMConnectorConfig['deprovisionStrategy'],
  };
}

/** AD config from the saved (string) config. */
export function coerceAdConfig(raw: Record<string, string>): AdConfig {
  const cfg: AdConfig = {
    host: raw.host ?? '',
    serviceAccount: raw.serviceAccount ?? '',
    password: raw.password ?? '',
  };
  cfg.rootBaseDn = raw.rootBaseDn?.trim() || raw.baseDn?.trim();
  cfg.baseDn = raw.baseDn ?? cfg.rootBaseDn;
  cfg.userSearchBase = raw.userSearchBase?.trim() || undefined;
  if (typeof raw.port === 'string' && raw.port) {
    cfg.port = parseInt(raw.port, 10);
  }
  if (typeof raw.useLdaps === 'string') {
    cfg.useLdaps = raw.useLdaps === 'true' || raw.useLdaps === '1';
  }
  if (raw.defaultDomain) cfg.defaultDomain = raw.defaultDomain;
  if (raw.userOu) cfg.userOu = raw.userOu;
  return cfg;
}
