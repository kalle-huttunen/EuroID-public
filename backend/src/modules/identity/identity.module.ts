import { Module, OnModuleInit } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { MetricsService } from '@infrastructure/observability/metrics.service';
import { IdentityController } from './identity.controller';
import { IdentityService } from './identity.service';
import { IdentityQueryService } from './identity-query.service';
import { IdentityMutationService } from './identity-mutation.service';
import { IdentityCorrelationService } from './identity-correlation.service';
import { IdentityUncorrelatedService } from './identity-uncorrelated.service';
import { IdentityProvisioningService } from './identity-provisioning.service';
import { IdentityOnionService } from './identity-onion.service';
import { IdentityDeletedMatchService } from './identity-deleted-match.service';
import { IdentityEntitlementsService } from './identity-entitlements.service';
import { IdentityPiiService } from './identity-pii.service';
import { IdentityPiiController } from './identity-pii.controller';
import { IdentityAccessExpiryController } from './identity-access-expiry.controller';
import { IdentityAccessExpiryService } from './identity-access-expiry.service';
import { IdentityControlsController } from './identity-controls.controller';
import { IdentityControlsService } from './identity-controls.service';
import { ContractCriticalMasteryService } from './contract-critical-mastery.service';
import { ReconciliationService } from './reconciliation.service';
import { UserEventService } from './user-event.service';
import { CorrelationRuleEngine } from './correlation/correlation-rule.engine';
import { CandidateSuggestionService } from './correlation/candidate-suggestion.service';
import { Identity, IdentitySchema } from './schemas/identity.schema';
import { UserEvent, UserEventSchema } from './schemas/user-event.schema';
import {
  ReconciliationConfig,
  ReconciliationConfigSchema,
} from './schemas/reconciliation-config.schema';
import { ReconciliationConfigService } from './reconciliation-config.service';
import { LeaverPolicy, LeaverPolicySchema } from '../leavers/schemas/leaver-policy.schema';
import { ReconciliationConfigController } from './reconciliation-config.controller';
import { CorrelationConfigModule } from '../correlation-config/correlation-config.module';
import { MachineIdentitySyncService } from './machine-identity-sync.service';
import { UserTimelineHandler } from '../../infrastructure/events/handlers/user-timeline.handler';
import { LeaverTimelineHandler } from '../../infrastructure/events/handlers/leaver-timeline.handler';
import { OffboardingTimelineHandler } from '../../infrastructure/events/handlers/offboarding-timeline.handler';
import { OffboardingManualRemovalHandler } from '../../infrastructure/events/handlers/offboarding-manual-removal.handler';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Identity.name, schema: IdentitySchema },
      { name: UserEvent.name, schema: UserEventSchema },
      { name: ReconciliationConfig.name, schema: ReconciliationConfigSchema },
      // Read-only: rows of deleted identities are judged by the tenant's leaver policy
      { name: LeaverPolicy.name, schema: LeaverPolicySchema },
    ]),
    CorrelationConfigModule, // Unified config; Blueprints/ConnectorConfig register via registry
  ],
  controllers: [
    IdentityController,
    IdentityControlsController,
    IdentityPiiController,
    IdentityAccessExpiryController,
    ReconciliationConfigController,
  ],
  providers: [
    // Sub-services (module-internal, not exported)
    IdentityQueryService,
    IdentityMutationService,
    IdentityCorrelationService,
    IdentityUncorrelatedService,
    IdentityProvisioningService,
    IdentityOnionService,
    IdentityDeletedMatchService,
    IdentityEntitlementsService,
    IdentityPiiService,
    IdentityAccessExpiryService,
    IdentityControlsService,
    ContractCriticalMasteryService,
    // Facade (exported, backward-compatible public API)
    IdentityService,
    ReconciliationService,
    ReconciliationConfigService,
    UserEventService,
    CorrelationRuleEngine,
    CandidateSuggestionService,
    MachineIdentitySyncService,
    UserTimelineHandler,
    LeaverTimelineHandler,
    OffboardingTimelineHandler,
    OffboardingManualRemovalHandler,
  ],
  exports: [
    IdentityService,
    IdentityProvisioningService,
    ReconciliationService,
    ReconciliationConfigService,
    UserEventService,
    MachineIdentitySyncService,
    // The connector install and update routes refuse a contract-critical field's mastery with it
    ContractCriticalMasteryService,
    // The DSAR export lists the subject's access with it
    IdentityEntitlementsService,
  ],
})
export class IdentityModule implements OnModuleInit {
  constructor(
    private readonly metrics: MetricsService,
    private readonly query: IdentityQueryService,
  ) {}

  /** euroid_identities_total counts the identities per status at each scrape. */
  onModuleInit(): void {
    this.metrics.countAtScrape('euroid_identities_total', () =>
      this.query.countByStatusInAllTenants(),
    );
  }
}
