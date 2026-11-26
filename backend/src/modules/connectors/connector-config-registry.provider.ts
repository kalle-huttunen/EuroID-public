import { Injectable, OnModuleInit } from '@nestjs/common';
import {
  CorrelationConfigRegistry,
  CONNECTOR_CONFIG_PROVIDER_KEY,
} from '../correlation-config/correlation-config.registry';
import { ConnectorConfigService } from './connector-config.service';

/**
 * Registers ConnectorConfigService with CorrelationConfigRegistry on module init.
 * Enables IdentityModule to resolve config without importing ConnectorConfigModule.
 */
@Injectable()
export class ConnectorConfigRegistryProvider implements OnModuleInit {
  constructor(
    private readonly registry: CorrelationConfigRegistry,
    private readonly connectorConfigService: ConnectorConfigService,
  ) {}

  onModuleInit(): void {
    this.registry.register(CONNECTOR_CONFIG_PROVIDER_KEY, this.connectorConfigService);
  }
}
