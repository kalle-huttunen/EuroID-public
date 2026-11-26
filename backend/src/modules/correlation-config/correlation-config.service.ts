import { Injectable, Logger } from '@nestjs/common';
import type { CorrelationConfig } from '@shared/types/correlation-config';
import { toSourceName } from '@shared/utils/source-name';
import type { HrPriorityConfig, HrConnectorWithPriority } from './correlation-config.interface';
import { CorrelationConfigRegistry } from './correlation-config.registry';
import { CorrelationConfigUnavailableError } from './correlation-config.errors';

/**
 * Composite config service that delegates to Blueprints and ConnectorConfig
 * via the registry. IdentityModule uses this instead of importing those modules.
 */
@Injectable()
export class CorrelationConfigService {
  private readonly logger = new Logger(CorrelationConfigService.name);

  constructor(private readonly registry: CorrelationConfigRegistry) {}

  /**
   * Load correlation config from blueprint's euroid-core connector config. Without settings (no
   * blueprint provider, none stored) the default email rule. When the blueprint cannot be read,
   * the default too, unless `strict`: then CorrelationConfigUnavailableError. Identity correlation
   * reads it strictly before it stores a record, since the settings name the national ID field to
   * remove (identity/national-id.ts); callers that only need the field mastery overrides keep
   * the fallback.
   */
  async getCorrelationConfig(
    _tenantId: string,
    options: { strict?: boolean } = {},
  ): Promise<CorrelationConfig> {
    const provider = this.registry.getBlueprintProvider();
    if (!provider) {
      return { rules: [{ strategy: 'email' }], conflictAction: 'review', confidenceThreshold: 0.7 };
    }
    try {
      const canvas = await provider.getLatestBlueprint();
      const euroidConfig = canvas?.connectorConfigs?.['euroid-core'] as
        | { correlationConfig?: CorrelationConfig }
        | undefined;
      const cfg = euroidConfig?.correlationConfig;
      if (cfg && Array.isArray(cfg.rules) && cfg.rules.length > 0) {
        return {
          rules: cfg.rules,
          conflictAction: cfg.conflictAction ?? 'review',
          confidenceThreshold: cfg.confidenceThreshold ?? 0.7,
          fieldMasteryOverrides: cfg.fieldMasteryOverrides,
          hrWriteback: cfg.hrWriteback ?? false,
        };
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to load correlation config: ${message}`);
      if (options.strict) throw new CorrelationConfigUnavailableError();
    }
    return { rules: [{ strategy: 'email' }], conflictAction: 'review', confidenceThreshold: 0.7 };
  }

  async getPrimaryHrSourceName(hrSourceTags: string[]): Promise<string | null> {
    const provider = this.registry.getConnectorProvider();
    if (!provider) return null;
    return provider.getPrimaryHrSourceName(hrSourceTags);
  }

  async getHrPriorityConfig(sourceName: string): Promise<HrPriorityConfig | null> {
    const provider = this.registry.getConnectorProvider();
    if (!provider) return null;
    return provider.getHrPriorityConfig(sourceName);
  }

  async getHrPriorityFromBlueprint(sourceName: string): Promise<HrPriorityConfig | null> {
    const provider = this.registry.getBlueprintProvider();
    if (!provider) return null;
    return provider.getHrPriorityFromBlueprint(sourceName);
  }

  async getHrConnectorsWithPriorityFromBlueprint(
    hrSourceTags: string[],
  ): Promise<HrConnectorWithPriority[]> {
    const provider = this.registry.getBlueprintProvider();
    if (!provider) return [];
    return provider.getHrConnectorsWithPriorityFromBlueprint(hrSourceTags);
  }

  async getInstalledHrConnectorsWithPriority(
    hrSourceTags: string[],
  ): Promise<HrConnectorWithPriority[]> {
    const provider = this.registry.getConnectorProvider();
    if (!provider) return [];
    return provider.getInstalledHrConnectorsWithPriority(hrSourceTags);
  }

  /**
   * Whether identity sources named `sourceName` come from an HR connector, for a tenant whose
   * reconciliation config names no HR sources: a connector whose manifest declares `ingest`,
   * under its own id or the `sourceSystem` its installed config sets (ConnectorConfigService), or
   * a Design Studio source node (the canvas category of HR connectors) with that `sourceSystem`.
   */
  async isHrSourceName(sourceName: string): Promise<boolean> {
    const connectors = this.registry.getConnectorProvider();
    if (connectors && (await connectors.isHrSourceName(sourceName))) return true;
    return this.isDesignStudioSource(sourceName);
  }

  private async isDesignStudioSource(sourceName: string): Promise<boolean> {
    const provider = this.registry.getBlueprintProvider();
    if (!provider) return false;
    try {
      const canvas = await provider.getLatestBlueprint();
      const nodes = (canvas?.nodes ?? []) as Array<{
        data?: { role?: string; type?: string; config?: unknown };
      }>;
      for (const node of nodes) {
        if (node.data?.role !== 'source') continue;
        const type = node.data.type;
        const names = [
          type,
          (node.data.config as { sourceSystem?: unknown } | undefined)?.sourceSystem,
          type
            ? (canvas.connectorConfigs?.[type] as { sourceSystem?: unknown } | undefined)
                ?.sourceSystem
            : undefined,
        ];
        if (names.some((n) => typeof n === 'string' && n && toSourceName(n) === sourceName)) {
          return true;
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to read Design Studio sources: ${message}`);
    }
    return false;
  }
}
