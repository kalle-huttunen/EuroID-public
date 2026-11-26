/**
 * Access Explorer Module
 *
 * Provides graph-based access visibility: identity access graphs,
 * entitlement holder queries, access path analysis, and transitive
 * SoD violation detection via Neo4j (policies from MongoDB).
 * The graph is filled by GraphSyncService (domain events) and GraphResyncService (the tenant's
 * MongoDB state, POST /access-explorer/resync).
 *
 * GraphService is injected globally from GraphModule.
 */
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AccessExplorerService } from './access-explorer.service';
import { AccessExplorerController } from './access-explorer.controller';
import { GraphSyncService } from './graph-sync.service';
import { GraphResyncService } from './graph-resync.service';
import { Identity, IdentitySchema } from '../identity/schemas/identity.schema';
import { SodPolicy, SodPolicySchema } from '../policy/schemas/sod-policy.schema';
import {
  EntitlementCatalog,
  EntitlementCatalogSchema,
} from '../entitlement-catalog/schemas/entitlement-catalog.schema';
import {
  AccessRequest,
  AccessRequestSchema,
} from '../access-requests/schemas/access-request.schema';
import { IdentityModule } from '../identity/identity.module';
import { PolicyModule } from '../policy/policy.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      // GraphSyncService reads an identity's email for its node (identity.updated carries none);
      // GraphResyncService reads the tenant's identities
      { name: Identity.name, schema: IdentitySchema },
      // getTransitiveSodViolations reads the SoD policies (read only; SodService owns them)
      { name: SodPolicy.name, schema: SodPolicySchema },
      // GraphResyncService reads the catalog and the active access requests, GraphSyncService
      // the catalog of a system on discovery.completed and the entries of provisioned targets,
      // the SoD check the entries of the policies' entitlements (read only)
      { name: EntitlementCatalog.name, schema: EntitlementCatalogSchema },
      { name: AccessRequest.name, schema: AccessRequestSchema },
    ]),
    // GraphResyncService evaluates each identity's policies as the identity page does, in a batch
    // (like RiskScoringModule): the IDENTITY_ENTITLEMENTS_QUERY event would write one audit entry
    // and one websocket message per identity.
    IdentityModule,
    PolicyModule,
  ],
  controllers: [AccessExplorerController],
  providers: [AccessExplorerService, GraphSyncService, GraphResyncService],
  exports: [AccessExplorerService],
})
export class AccessExplorerModule {}
