import { Injectable } from '@nestjs/common';
import type { IBlueprintConfigProvider } from './correlation-config.interface';
import type { IConnectorConfigProvider } from './correlation-config.interface';

export const BLUEPRINTS_PROVIDER_KEY = 'blueprints';
export const CONNECTOR_CONFIG_PROVIDER_KEY = 'connectors';

/**
 * Registry for config providers. Blueprints and ConnectorConfig modules
 * register their implementations on init. Identity uses CorrelationConfigService
 * which delegates to these providers, breaking the circular dependency.
 */
@Injectable()
export class CorrelationConfigRegistry {
  private readonly providers = new Map<
    string,
    IBlueprintConfigProvider | IConnectorConfigProvider
  >();

  register(key: string, provider: IBlueprintConfigProvider | IConnectorConfigProvider): void {
    this.providers.set(key, provider);
  }

  getBlueprintProvider(): IBlueprintConfigProvider | undefined {
    return this.providers.get(BLUEPRINTS_PROVIDER_KEY) as IBlueprintConfigProvider | undefined;
  }

  getConnectorProvider(): IConnectorConfigProvider | undefined {
    return this.providers.get(CONNECTOR_CONFIG_PROVIDER_KEY) as
      | IConnectorConfigProvider
      | undefined;
  }
}
