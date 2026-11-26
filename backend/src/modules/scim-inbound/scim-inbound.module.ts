import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { IdentityModule } from '../identity/identity.module';
import { EntitlementCatalogModule } from '../entitlement-catalog/entitlement-catalog.module';
import { AuthLocalModule } from '../auth/auth-local.module';
import { ScimUsersController } from './scim-users.controller';
import { ScimGroupsController } from './scim-groups.controller';
import { ScimDiscoveryController } from './scim-discovery.controller';
import { ScimTokenController } from './scim-token.controller';
import { ScimInboundMapper } from './scim-inbound.mapper';
import { ScimFilterService } from './scim-filter.service';
import { ScimTokenService } from './scim-token.service';
import { ScimAuthGuard } from './guards/scim-auth.guard';
import { ScimToken, ScimTokenSchema } from './schemas/scim-token.schema';
import { TenantStatusModule } from '@infrastructure/multi-tenancy/tenant-status.service';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: ScimToken.name, schema: ScimTokenSchema }]),
    IdentityModule,
    EntitlementCatalogModule,
    AuthLocalModule, // AdminUser model and auth services (the controller uses the global guards)
    TenantStatusModule, // ScimAuthGuard refuses a token of a suspended tenant
  ],
  controllers: [
    ScimUsersController,
    ScimGroupsController,
    ScimDiscoveryController,
    ScimTokenController,
  ],
  providers: [ScimInboundMapper, ScimFilterService, ScimTokenService, ScimAuthGuard],
  exports: [ScimTokenService],
})
export class ScimInboundModule {}
