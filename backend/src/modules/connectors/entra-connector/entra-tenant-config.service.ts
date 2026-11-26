import { Injectable } from '@nestjs/common';
import { getRequestContext } from '@infrastructure/middleware/get-request-context';
import { CorrelationConfigRegistry } from '../../correlation-config/correlation-config.registry';
import type { EntraConfig } from './entra.interface';
import { ENTRA_SYSTEM } from './entra.constants';

/**
 * The Entra ID config of a call whose caller names none: the current tenant's installed Entra ID
 * connector config (ConnectorConfigService, read through CorrelationConfigRegistry: importing
 * ConnectorConfigModule here would be a module cycle, as it imports modules that import this one),
 * else `undefined`, which EntraClient reads as the ENTRA_* environment variables. The tenant
 * comes from the request context only: without one, no tenant's config is read.
 *
 * An installed config is used as it is. EntraClient rejects one with an empty tenant id, client
 * id or secret, so a tenant whose config is incomplete gets a configuration error, never the
 * deployment's app registration.
 */
@Injectable()
export class EntraTenantConfigService {
  constructor(private readonly registry: CorrelationConfigRegistry) {}

  /** `config` when the caller named one, else the tenant's installed config (undefined: none). */
  async resolve(config: EntraConfig | undefined): Promise<EntraConfig | undefined> {
    return config ?? this.installed();
  }

  /** The current tenant's installed Entra ID connector config, or undefined when it has none. */
  async installed(): Promise<EntraConfig | undefined> {
    if (!getRequestContext()?.tenantId) return undefined;
    // Registered by ConnectorConfigModule on init (connector-config-registry.provider.ts); a unit
    // test without that module has no installed configs
    const connectors = this.registry.getConnectorProvider();
    const installed = connectors ? await connectors.getConfig(ENTRA_SYSTEM) : null;
    return installed ? ((installed.config ?? {}) as unknown as EntraConfig) : undefined;
  }
}
