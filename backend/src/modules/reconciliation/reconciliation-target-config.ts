/**
 * The AD and SCIM connector configs reconciliation reads target accounts with: drift detection
 * (activities/reconciliation.activities.ts) and orphan detection (orphan-detection.service.ts).
 *
 * A config that is installed but lacks a setting the connector needs to find accounts (AD: host,
 * Root Base DN; SCIM: base URL) is an error for that system's reconciliation, naming the setting.
 * Read as "no accounts", drift detection raised MISSING_USER for every user (auto-corrected for
 * the active ones).
 */
import { HttpStatus } from '@nestjs/common';
import { ConnectorException } from '@shared/exceptions/domain-exceptions';
import type { ConnectorConfigService } from '../connectors/connector-config.service';
import type { AdConfig } from '../connectors/ad-connector/ad.interface';
import type { SCIMConnectorConfig } from '../connectors/scim-connector/scim.interface';

type RawConfig = Record<string, string>;

function incomplete(connector: string, empty: string[], settings: string): ConnectorException {
  return new ConnectorException(
    `${connector} connector config is incomplete (empty: ${empty.join(', ')}): set ${settings} ` +
      `in the ${connector} connector config.`,
    HttpStatus.BAD_REQUEST,
  );
}

function coerceAdConfig(raw: RawConfig): AdConfig {
  const cfg: AdConfig = {
    host: raw.host ?? '',
    serviceAccount: raw.serviceAccount ?? '',
    password: raw.password ?? '',
  };
  cfg.rootBaseDn = raw.rootBaseDn?.trim() || raw.baseDn?.trim();
  cfg.baseDn = raw.baseDn ?? cfg.rootBaseDn;
  cfg.userSearchBase = raw.userSearchBase?.trim() || undefined;
  if (typeof raw.port === 'string' && raw.port) cfg.port = parseInt(raw.port, 10);
  if (typeof raw.useLdaps === 'string')
    cfg.useLdaps = raw.useLdaps === 'true' || raw.useLdaps === '1';
  if (raw.defaultDomain) cfg.defaultDomain = raw.defaultDomain;
  if (raw.userOu) cfg.userOu = raw.userOu;
  return cfg;
}

/** The tenant's AD config; null when no AD connector config is installed. */
export async function loadAdConfig(configs: ConnectorConfigService): Promise<AdConfig | null> {
  const doc = await configs.getConfig('ad');
  if (!doc?.config) return null;
  const cfg = coerceAdConfig(doc.config as RawConfig);
  const missing = [
    ...(cfg.host.trim() ? [] : [['host', 'the host']]),
    ...(cfg.rootBaseDn ? [] : [['rootBaseDn', 'the Root Base DN']]),
  ];
  if (missing.length > 0) {
    const [keys, labels] = [missing.map(([key]) => key), missing.map(([, label]) => label)];
    throw incomplete('AD', keys, labels.join(' and '));
  }
  return cfg;
}

/** The tenant's SCIM config; null when no SCIM connector config is installed. */
export async function loadScimConfig(
  configs: ConnectorConfigService,
): Promise<SCIMConnectorConfig | null> {
  const doc = await configs.getConfig('scim');
  if (!doc?.config) return null;
  const raw = doc.config as RawConfig;
  const baseUrl = raw.baseUrl?.trim();
  if (!baseUrl) throw incomplete('SCIM', ['baseUrl'], 'the base URL');
  return {
    baseUrl,
    authType: (raw.authType as SCIMConnectorConfig['authType']) || 'bearer',
    bearerToken: raw.bearerToken,
    username: raw.username,
    password: raw.password,
    oauth2TokenUrl: raw.oauth2TokenUrl,
    clientId: raw.clientId,
    clientSecret: raw.clientSecret,
    deprovisionStrategy: raw.deprovisionStrategy as SCIMConnectorConfig['deprovisionStrategy'],
  };
}
