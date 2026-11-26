import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { MongooseModule } from '@nestjs/mongoose';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { authConfig } from '@infrastructure/config/auth.config';
import { encryptionConfig } from '@infrastructure/config/encryption.config';
import { eventsConfig } from '@infrastructure/config/events.config';
import { appConfig } from '@infrastructure/config/app.config';
import { elasticsearchConfig } from '@infrastructure/config/elasticsearch.config';
import { opaConfig } from '@infrastructure/config/opa.config';
import { eventSubscriptionsConfig } from '@infrastructure/config/event-subscriptions.config';
import { CorrelationConfigModule } from './modules/correlation-config/correlation-config.module';
import { BlueprintsModule } from './modules/blueprints/blueprints.module';
import { ConfigActivities } from './activities/config.activities';
import { IdentityModule } from './modules/identity/identity.module';
import { OnboardingModule } from './modules/onboarding/onboarding.module';
import { OffboardingModule } from './modules/offboarding/offboarding.module';
import { LeaversModule } from './modules/leavers/leavers.module';
import { BulkProvisioningModule } from './modules/bulk-provisioning/bulk-provisioning.module';
import { ReconciliationModule } from './modules/reconciliation/reconciliation.module';
import { PolicyModule } from './modules/policy/policy.module';
import { EntitlementCatalogModule } from './modules/entitlement-catalog/entitlement-catalog.module';
import { AuditModule } from './modules/audit/audit.module';
import { ConnectorConfigModule } from './modules/connectors/connector-config.module';
import { PluginRegistryModule } from './modules/connectors/plugin/plugin-registry.module';
import { DevToolsModule } from './modules/dev-tools/dev-tools.module';
import { RoleBundlesModule } from './modules/role-bundles/role-bundles.module';
import { PrivilegedAccessModule } from './modules/privileged-access/privileged-access.module';
import { DeadLetterModule } from './modules/dead-letter/dead-letter.module';
import { AnomalyModule } from './modules/anomaly/anomaly.module';
import { PolicySuggestionsModule } from './modules/policy-suggestions/policy-suggestions.module';
import { AccessRequestsModule } from './modules/access-requests/access-requests.module';
import { AccessReviewModule } from './modules/access-review/access-review.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { RiskScoringModule } from './modules/risk-scoring/risk-scoring.module';
import { IntelligenceModule } from './modules/intelligence/intelligence.module';
import { ComplianceReportingModule } from './modules/compliance-reporting/compliance-reporting.module';
import { ScimInboundModule } from './modules/scim-inbound/scim-inbound.module';
import { EventSubscriptionsModule } from './modules/event-subscriptions/event-subscriptions.module';
import { CredentialLifecycleModule } from './modules/credential-lifecycle/credential-lifecycle.module';
import { MoverModule } from './modules/mover/mover.module';
import { JoinersModule } from './modules/joiners/joiners.module';
import { AccessExplorerModule } from './modules/access-explorer/access-explorer.module';
import { AgentManagementModule } from './modules/agent-management/agent-management.module';
import { NhiModule } from './modules/nhi/nhi.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { ElasticsearchModule } from '@infrastructure/elasticsearch/elasticsearch.module';
import { OpaModule } from '@infrastructure/opa/opa.module';
import { RetentionModule } from '@infrastructure/retention/retention.module';
import { GraphModule } from '@infrastructure/graph/graph.module';
import { CorrelationMiddleware } from '@infrastructure/middleware/correlation.middleware';
import { ObservabilityModule } from '@infrastructure/observability/observability.module';
import { EventsModule } from '@infrastructure/events/events.module';
import { RealTimeModule } from '@infrastructure/realtime/realtime.module';
import { AuthModule } from '@infrastructure/auth/auth.module';
import { TenantModule } from '@infrastructure/multi-tenancy/tenant.module';
import { HealthModule } from '@infrastructure/health/health.module';
import { SecretsModule } from '@infrastructure/secrets/secrets.module';
import { CommonModule } from '@infrastructure/common.module';
import { ActivitiesModule } from './activities/activities.module';
import { RedisModule } from '@infrastructure/cache/redis.module';
import {
  SECURITY_STATE_STORE,
  type SecurityStateStore,
} from '@infrastructure/cache/security-state.store';
import { SharedThrottlerStorage } from '@infrastructure/cache/shared-throttler.storage';
import { ResilienceModule } from '@infrastructure/resilience/resilience.module';
import { TemporalModule } from '@infrastructure/temporal/temporal.module';
import { HttpMetricsInterceptor } from '@infrastructure/observability/http-metrics.interceptor';

// Resolve .env so it's found whether the app runs from backend/ or from repo root.
// __dirname at runtime is backend/dist (compiled) or backend/src (ts-node).
const backendDir = resolve(__dirname, '..');
const envInBackend = resolve(backendDir, '.env');
const envInCwd = resolve(process.cwd(), '.env');
const envInCwdBackend = resolve(process.cwd(), 'backend', '.env');
const envPaths = [envInBackend, envInCwd, envInCwdBackend].filter((p) => existsSync(p));
const envFilePath = envPaths.length > 0 ? envPaths[0] : '.env';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath,
      load: [
        authConfig,
        encryptionConfig,
        eventsConfig,
        appConfig,
        eventSubscriptionsConfig,
        elasticsearchConfig,
        opaConfig,
      ],
    }),
    ThrottlerModule.forRootAsync({
      useFactory: (config: ConfigService, securityState: SecurityStateStore) => ({
        throttlers: [
          { name: 'short', ttl: 1000, limit: config.get('auth.THROTTLE_SHORT_LIMIT') ?? 10 },
          { name: 'medium', ttl: 60000, limit: config.get('auth.THROTTLE_MEDIUM_LIMIT') ?? 100 },
        ],
        // Routes throttled with sharedThrottleKey (login) count in the shared security state
        // store and fail closed; the others count per instance.
        storage: new SharedThrottlerStorage(securityState),
      }),
      inject: [ConfigService, SECURITY_STATE_STORE],
    }),
    ObservabilityModule,
    EventsModule,
    RedisModule, // Distributed cache (Redis or in-memory fallback)
    ResilienceModule, // Circuit breaker for connector HTTP calls
    RealTimeModule, // WebSocket gateway — bridges domain events to frontend clients
    AuthModule, // Includes AuthLocalModule (login, register, JWT revocation)
    HealthModule,
    SecretsModule, // Encryption for credentials at rest (must load before connectors)
    CommonModule, // CorrelationHashService for identity correlation
    ScheduleModule.forRoot(),
    MongooseModule.forRootAsync({
      useFactory: (config: ConfigService) => {
        const uri = config.get<string>('app.MONGO_URI');
        if (!uri) {
          console.error('[FATAL] MONGO_URI is required. Set it in .env. See backend/.env.example');
          process.exit(1);
        }
        return {
          uri,
          maxPoolSize: config.get('app.MONGO_MAX_POOL_SIZE') ?? 20,
          minPoolSize: config.get('app.MONGO_MIN_POOL_SIZE') ?? 5,
          serverSelectionTimeoutMS: 5000,
          socketTimeoutMS: 45000,
          retryWrites: true,
          w: 'majority',
        };
      },
      inject: [ConfigService],
    }),
    TenantModule, // Tenant context propagation + Mongoose plugin (must load before feature modules)
    TemporalModule, // Shared Temporal client (single connection for all services)
    CorrelationConfigModule, // Config registry for identity (breaks circular deps; load before Blueprints/ConnectorConfig)
    BlueprintsModule, // Persistence for our Design Studio
    IdentityModule, // The Hub
    OnboardingModule, // The Orchestrator
    OffboardingModule, // The Offboarding Orchestrator
    LeaversModule, // HR-driven leavers: detection after each HR sync, mass-leaver approval
    BulkProvisioningModule, // Bulk Operations
    ReconciliationModule, // Reconciliation & Distributed Transactions
    PolicyModule, // Policy Engine (rules, simulation, evaluation)
    EntitlementCatalogModule, // Hybrid governance: POLICY vs EXTERNAL entitlements
    AuditModule, // Cross-cutting audit trail (Global module)
    PluginRegistryModule, // Connector plugin registry (must load before ConnectorConfigModule)
    ConnectorConfigModule, // Connector Marketplace backend (install/config persistence)
    ActivitiesModule, // Temporal activities for worker (aggregates feature activity modules)
    DevToolsModule, // Workflow & Transaction tracking for Developer Tools
    RoleBundlesModule, // Role bundle templates (policy templates)
    PrivilegedAccessModule, // PAM: Linked admin identities
    DeadLetterModule, // Dead letter queue for failed events/workflows
    RetentionModule, // Data retention: purge soft-deleted, TTL config
    AnomalyModule, // Access anomaly detection (rule-based heuristics)
    PolicySuggestionsModule, // Intelligent policy suggestions (birthright, orphan, etc.)
    AccessRequestsModule, // Self-service access request portal
    AccessReviewModule, // Continuous access certification (campaigns, review items)
    AnalyticsModule, // Predictive analytics (offboarding blast radius, license forecast, seasonal patterns)
    RiskScoringModule, // Composite risk score (0-100) per identity, nightly CronWorkflow
    IntelligenceModule, // AI access intelligence: rubber-stamp detection, peer groups, recommendations
    ComplianceReportingModule, // SOX and ISO 27001 compliance reports
    ScimInboundModule, // SCIM 2.0 inbound server (user provisioning from HR/IdPs)
    EventSubscriptionsModule, // Outbound webhook registry for domain events (SIEM foundation)
    CredentialLifecycleModule, // Credential inventory + policy management (password rotation, MFA tracking)
    MoverModule, // Explicit Mover workflow (role/department change → entitlement delta)
    JoinersModule, // HR-driven joiners: onboarding after each HR sync, mass-joiner approval
    GraphModule, // Neo4j graph infrastructure (global — provides GraphService to all modules)
    ElasticsearchModule, // Elasticsearch infrastructure (global — fail-open CQRS read model for analytics)
    OpaModule, // Open Policy Agent infrastructure (global — hybrid policy evaluation)
    AccessExplorerModule, // Graph-based access visibility: access graphs, path analysis, transitive SoD
    AgentManagementModule, // Remote agent registration, heartbeat, lifecycle (v2 Agent endpoints)
    NhiModule, // Non-Human Identity: service accounts, workloads, AI agents with scope attenuation + short-lived creds
    NotificationsModule, // Email notifications (SMTP): approvers, reviewers, expiring access; off without SMTP_HOST
  ],
  providers: [
    ConfigActivities, // Register for the Temporal Worker to find
    CorrelationMiddleware,
    // Rate limiting: runs after auth guards so unauthenticated requests don't count against limit
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // Per-route HTTP request duration + count (Prometheus)
    { provide: APP_INTERCEPTOR, useClass: HttpMetricsInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(CorrelationMiddleware).forRoutes('*');
  }
}

// --- TASK_100: AuthLocalModule now comes via AuthModule (removed duplicate import).
