import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { authConfig } from '@infrastructure/config/auth.config';
import { PolicyController } from './policy.controller';
import { SodPolicyController } from './sod-policy.controller';
import { PolicyService } from './policy.service';
import { PolicyEngineService } from './policy-engine.service';
import { PamFilterService } from './pam-filter.service';
import { SodService } from './sod.service';
import { Policy, PolicySchema } from './schemas/policy.schema';
import { SodPolicy, SodPolicySchema } from './schemas/sod-policy.schema';
import { ReviewExclusion, ReviewExclusionSchema } from './schemas/review-exclusion.schema';
import { ReviewExclusionService } from './review-exclusion.service';
import { ReviewExclusionRecorder } from './review-exclusion-recorder.service';
import { ReviewExclusionController } from './review-exclusion.controller';
import { IdentityModule } from '../identity/identity.module';
import { RoleBundlesModule } from '../role-bundles/role-bundles.module';
import { EntitlementCatalogModule } from '../entitlement-catalog/entitlement-catalog.module';
import { PolicyActivities } from '../../activities/policy.activities';
import { IDENTITY_QUERY_PORT } from '@shared/interfaces/identity-query.port';
import { ROLE_BUNDLE_RESOLVER_PORT } from '@shared/interfaces/role-bundle-resolver.port';
import { POLICY_DECISION_PORT } from '@shared/interfaces/policy-decision.port';
import { IdentityService } from '../identity/identity.service';
import { RoleBundlesService } from '../role-bundles/role-bundles.service';
import { OpaEvaluatorService } from './opa/opa-evaluator.service';
import { RegoCompilerService } from './opa/rego-compiler.service';
import { IdentityEntitlementsPolicyHandler } from '../../infrastructure/events/handlers/identity-entitlements-policy.handler';
import { ReviewExclusionOffboardingHandler } from '../../infrastructure/events/handlers/review-exclusion-offboarding.handler';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Policy.name, schema: PolicySchema },
      { name: SodPolicy.name, schema: SodPolicySchema },
      { name: ReviewExclusion.name, schema: ReviewExclusionSchema },
    ]),
    ConfigModule.forFeature(authConfig),
    IdentityModule, // Provides IdentityService as IDENTITY_QUERY_PORT implementation
    RoleBundlesModule, // Provides RoleBundlesService as ROLE_BUNDLE_RESOLVER_PORT implementation
    EntitlementCatalogModule, // PamFilterService needs EntitlementCatalogService for admin redirect lookups
  ],
  controllers: [PolicyController, SodPolicyController, ReviewExclusionController],
  providers: [
    PolicyService,
    PolicyEngineService,
    PamFilterService,
    SodService,
    // Access review exclusions: read by the engine, written at campaign close (AccessReviewModule)
    ReviewExclusionService,
    ReviewExclusionRecorder,
    PolicyActivities,
    RegoCompilerService,
    OpaEvaluatorService,
    IdentityEntitlementsPolicyHandler,
    ReviewExclusionOffboardingHandler,
    { provide: IDENTITY_QUERY_PORT, useExisting: IdentityService },
    { provide: ROLE_BUNDLE_RESOLVER_PORT, useExisting: RoleBundlesService },
    { provide: POLICY_DECISION_PORT, useExisting: PolicyEngineService },
  ],
  exports: [
    PolicyService,
    PolicyEngineService,
    SodService,
    PolicyActivities,
    OpaEvaluatorService,
    POLICY_DECISION_PORT,
    ReviewExclusionRecorder,
    ReviewExclusionService, // the lift and its re-evaluation (MoverModule)
  ],
})
export class PolicyModule {}
