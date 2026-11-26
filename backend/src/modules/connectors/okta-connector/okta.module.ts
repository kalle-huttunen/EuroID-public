import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { OktaService } from './okta.service';
import { OktaClient } from './okta.client';
import { OktaMapper } from './okta.mapper';
import { OktaDiscoveryService } from './okta-discovery.service';
import { OktaProvisioningService } from './okta-provisioning.service';
import { ConnectorConfigModule } from '../connector-config.module';

@Module({
  imports: [ConfigModule, ConnectorConfigModule],
  providers: [
    OktaClient, // 1. Low-level HTTP/Auth
    OktaMapper, // 2. Pure Translation Logic
    OktaDiscoveryService, // 3a. Read-only operations (health, discovery)
    OktaProvisioningService, // 3b. User lifecycle and group membership
    OktaService, // 4. Facade (delegates to 3a-3b)
  ],
  exports: [OktaService],
})
export class OktaConnectorModule {}
