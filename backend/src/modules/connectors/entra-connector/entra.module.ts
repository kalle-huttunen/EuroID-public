import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CorrelationConfigModule } from '../../correlation-config/correlation-config.module';
import { EntraService } from './entra.service';
import { EntraClient } from './entra.client';
import { EntraMapper } from './entra.mapper';
import { EntraDiscoveryService } from './entra-discovery.service';
import { EntraProvisioningService } from './entra-provisioning.service';
import { EntraEntitlementsService } from './entra-entitlements.service';
import { EntraTenantConfigService } from './entra-tenant-config.service';

@Module({
  // CorrelationConfigModule: the tenant's installed Entra ID connector config (EntraTenantConfigService)
  imports: [ConfigModule, CorrelationConfigModule],
  providers: [
    EntraClient, // 1. Low-level HTTP/Auth
    EntraMapper, // 2. Pure Translation Logic
    EntraDiscoveryService, // 3a. Read-only operations
    EntraEntitlementsService, // 3b. Group/role/license management (dumb pipe: explicit add/remove)
    EntraProvisioningService, // 3c. User lifecycle
    EntraTenantConfigService, // Config of calls that name none: tenant's installed config, else ENTRA_*
    EntraService, // 4. Facade (delegates to 3a-3c)
  ],
  exports: [EntraService],
})
export class EntraConnectorModule {}
