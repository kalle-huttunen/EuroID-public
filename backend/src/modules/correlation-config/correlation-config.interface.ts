/**
 * Provider interfaces for correlation config. Blueprints and ConnectorConfig
 * register implementations so IdentityModule can resolve config without
 * importing those modules (breaks circular dependency).
 */

import type { CorrelationConfig } from '@shared/types/correlation-config';

export interface HrPriorityConfig {
  ingestPriority?: number;
  contractTag?: string;
  masteryFields?: string[];
}

export interface HrConnectorWithPriority {
  name: string;
  ingestPriority: number;
  contractTag?: string;
  masteryFields?: string[];
}

/** Blueprint-related config: correlation rules, HR priority from canvas. */
export interface IBlueprintConfigProvider {
  getLatestBlueprint(): Promise<{
    connectorConfigs?: Record<string, { correlationConfig?: CorrelationConfig }>;
    nodes?: unknown[];
  }>;
  getHrPriorityFromBlueprint(sourceName: string): Promise<HrPriorityConfig | null>;
  getHrConnectorsWithPriorityFromBlueprint(
    hrSourceTags: string[],
  ): Promise<HrConnectorWithPriority[]>;
}

/**
 * Connector config: primary HR, HR priority from installed connectors, and an installed
 * connector's config (the Entra ID connector reads its own through it, EntraTenantConfigService).
 */
export interface IConnectorConfigProvider {
  getPrimaryHrSourceName(hrSourceTags: string[]): Promise<string | null>;
  getHrPriorityConfig(name: string): Promise<HrPriorityConfig | null>;
  getInstalledHrConnectorsWithPriority(hrSourceTags: string[]): Promise<HrConnectorWithPriority[]>;
  /** Whether identity sources named `sourceName` come from an installed or built-in HR connector. */
  isHrSourceName(sourceName: string): Promise<boolean>;
  /**
   * The current tenant's installed config of a connector, decrypted (secrets included: internal
   * use only, never logged or returned to a client), or null when the tenant has not installed it.
   */
  getConfig(name: string): Promise<{ config: Record<string, string> } | null>;
}
