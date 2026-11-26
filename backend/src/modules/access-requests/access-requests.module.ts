import { Module, OnModuleInit } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { accessRequestsConfig } from '@infrastructure/config/access-requests.config';
import { AccessRequest, AccessRequestSchema } from './schemas/access-request.schema';
import { AdminUser, AdminUserSchema } from '../auth/schemas/admin-user.schema';
import { AccessRequestsService } from './access-requests.service';
import { AccessRequestCreationService } from './access-request-creation.service';
import { AccessRequestDecisionService } from './access-request-decision.service';
import { AccessRequestQueryService } from './access-request-query.service';
import { AccessRequestSodService } from './access-request-sod.service';
import { AccessRequestClosureService } from './access-request-closure.service';
import { AccessRequestManualRemovalService } from './access-request-manual-removal.service';
import { AccessRequestsController } from './access-requests.controller';
import { EntitlementCatalogModule } from '../entitlement-catalog/entitlement-catalog.module';
import { PolicyModule } from '../policy/policy.module';
import { IdentityModule } from '../identity/identity.module';
import { OffboardImpactEventHandler } from '../../infrastructure/events/handlers/offboard-impact.handler';
import { IdentityEntitlementsRequestHandler } from '../../infrastructure/events/handlers/identity-entitlements-request.handler';
import { IDENTITY_QUERY_PORT } from '@shared/interfaces/identity-query.port';
import { IdentityService } from '../identity/identity.service';
import { MetricsService } from '@infrastructure/observability/metrics.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: AccessRequest.name, schema: AccessRequestSchema },
      // ROLE approval steps: who holds the role (read only)
      { name: AdminUser.name, schema: AdminUserSchema },
    ]),
    ConfigModule.forFeature(accessRequestsConfig),
    EntitlementCatalogModule,
    PolicyModule,
    IdentityModule, // Provides IdentityService as IDENTITY_QUERY_PORT implementation
  ],
  controllers: [AccessRequestsController],
  providers: [
    AccessRequestCreationService,
    AccessRequestDecisionService,
    AccessRequestQueryService,
    AccessRequestSodService,
    AccessRequestClosureService,
    AccessRequestManualRemovalService,
    AccessRequestsService,
    OffboardImpactEventHandler,
    IdentityEntitlementsRequestHandler,
    { provide: IDENTITY_QUERY_PORT, useExisting: IdentityService },
  ],
  // For AccessRequestActivities: AccessRequestSodService (the SoD re-check before fulfilment),
  // AccessRequestClosureService (a request whose end date passed before approval completed)
  exports: [AccessRequestsService, AccessRequestSodService, AccessRequestClosureService],
})
export class AccessRequestsModule implements OnModuleInit {
  constructor(
    private readonly metrics: MetricsService,
    private readonly query: AccessRequestQueryService,
  ) {}

  /** euroid_access_requests_pending counts the requests waiting for approval at each scrape. */
  onModuleInit(): void {
    this.metrics.countAtScrape('euroid_access_requests_pending', () =>
      this.query.countPendingInAllTenants(),
    );
  }
}
