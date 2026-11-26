# EuroID Backend

> **AI AGENT:** Read `CLAUDE.md` first for safety rules. Then this file for backend-specific paths. Coding rules: `rules/backend.nestjs.md`. Multi-step tasks: `rules/agent-workflows.md`.

---

## Decision Routing (Start Here)

| If your task involves... | Go to | Path | Architecture Doc |
|---|---|---|---|
| User lifecycle (create, update, merge, GDPR) | Identity Hub | `modules/identity/` | `modules/identity/docs/` |
| ABAC rules, role assignment, SoD | Policy Engine | `modules/policy/` | `modules/policy/docs/ARCHITECTURE.md` |
| Connecting to external systems | Connectors | `modules/connectors/[name]-connector/` | `modules/connectors/docs/ARCHITECTURE.md` |
| Drift detection, remediation | Reconciliation | `modules/reconciliation/` | `modules/reconciliation/docs/` |
| Visual pipeline editor, deploy | Blueprints | `modules/blueprints/` | `modules/blueprints/docs/ARCHITECTURE.md` |
| Multi-step orchestration | Temporal Workflows | `src/workflows/` + `src/activities/` | `docs/architecture/infrastructure/TEMPORAL_WORKFLOWS.md` |
| Auth, JWT, SAML SSO, MFA | Auth | `modules/auth/` + `infrastructure/auth/` | `docs/architecture/security/PLATFORM_AUTH_ARCHITECTURE.md` |
| SCIM 2.0 inbound provisioning | SCIM Inbound | `modules/scim-inbound/` | — |
| Access certification campaigns | Access Reviews | `modules/access-review/` | — |
| Anomaly & risk scoring | Anomaly Detection | `modules/anomaly/` | — |
| Predictive analytics, license forecast | Analytics | `modules/analytics/` | `modules/analytics/docs/ARCHITECTURE.md` |
| Entitlement discovery & tagging | Entitlement Catalog | `modules/entitlement-catalog/` | — |
| Role bundle management | Role Bundles | `modules/role-bundles/` | — |
| AI-generated policy suggestions | Policy Suggestions | `modules/policy-suggestions/` | — |
| User offboarding | Offboarding | `modules/offboarding/` | — |
| HR-driven leavers (terminated, end date, missing from feed; mass-leaver approval) | Leavers | `modules/leavers/` | `modules/leavers/docs/ARCHITECTURE.md` |
| HR-driven joiners (onboarding after each HR sync once deployed; mass-joiner approval) | Joiners | `modules/joiners/` | `modules/joiners/docs/ARCHITECTURE.md` |
| Batch/bulk provisioning | Bulk Provisioning | `modules/bulk-provisioning/` | — |
| Audit trail, PII redaction | Audit | `modules/audit/` | — |
| Failed workflow recovery, auto-retry | Dead Letter Queue | `modules/dead-letter/` | — |
| HMAC-signed outbound webhooks | Event Subscriptions | `modules/event-subscriptions/` | — |
| Email notifications (approvers, reviewers, expiring access) | Notifications | `modules/notifications/` | `modules/notifications/docs/ARCHITECTURE.md` |
| Multi-tenancy | Tenant | `infrastructure/multi-tenancy/` | `docs/architecture/infrastructure/ARCHITECTURE_MULTI_TENANCY.md` |
| Observability (traces, metrics) | Observability | `infrastructure/observability/` | `docs/architecture/infrastructure/OBSERVABILITY_ARCHITECTURE.md` |
| WebSocket real-time events | Real-Time | `infrastructure/realtime/` | — |
| Data retention & archival | Retention | `infrastructure/retention/` | `docs/architecture/security/DATA_RETENTION.md` |
| Self-service access requests | Access Requests | `modules/access-requests/` | `modules/access-requests/docs/ARCHITECTURE.md` |
| GDPR consent, DSAR, erasure | Compliance Reporting | `modules/compliance-reporting/` | `modules/compliance-reporting/docs/GDPR_COMPLIANCE.md` |
| Identity correlation rules | Correlation Config | `modules/correlation-config/` | — |
| Privileged account management | Privileged Access | `modules/privileged-access/` | `modules/privileged-access/docs/ARCHITECTURE.md` |
| Risk score calculation | Risk Scoring | `modules/risk-scoring/` | `modules/risk-scoring/docs/ARCHITECTURE.md` |
| Reviewer quality, peer groups, recommendations | Intelligence | `modules/intelligence/` | `modules/intelligence/docs/ARCHITECTURE.md` |
| Credential inventory, rotation, policies | Credential Lifecycle | `modules/credential-lifecycle/` | `modules/credential-lifecycle/docs/ARCHITECTURE.md` |
| Non-human identities (service accounts, AI agents, bots): owner, delegation, kill switch, short-lived credentials | NHI | `modules/nhi/` | `modules/nhi/docs/ARCHITECTURE.md` |
| Role/department change (mover), access re-evaluation, HR-driven mover (mass-mover approval) | Mover | `modules/mover/` | `modules/mover/docs/ARCHITECTURE.md`, `docs/architecture/infrastructure/TEMPORAL_WORKFLOWS.md` (Mover Workflow Flow) |
| Graph-powered access traversal, "who has what" | Access Explorer | `modules/access-explorer/` | — |
| Neo4j graph database (optional) | Graph | `infrastructure/graph/` | — |
| OPA sidecar client (policy-as-code) | OPA | `infrastructure/opa/` | `infrastructure/opa/docs/ARCHITECTURE.md` |
| JIT privileged access sessions | Privileged Access (JIT) | `modules/privileged-access/` | `modules/privileged-access/docs/ARCHITECTURE.md` |
| Remote agent registration, heartbeat, stale detection | Agent Management | `modules/agent-management/` | `modules/agent-management/docs/ARCHITECTURE.md` |

> **Note:** Modules with co-located architecture docs have a `docs/` subdirectory. Cross-cutting docs remain in `docs/architecture/`. See `docs/DOCUMENTATION_STRATEGY.md` for the full documentation strategy.

---

## Tech Stack

| Layer | Stack |
|---|---|
| Framework | NestJS 11 (Modular) |
| Orchestration | Temporal (TypeScript SDK) |
| Database | MongoDB (Mongoose 9) |
| Validation | Zod (Runtime DTOs) |
| Auth | JWT (`jose`), SAML 2.0 (`@node-saml/node-saml`), TOTP MFA (`otpauth`) |
| HTTP Client | Axios |
| LDAP | `ldapts` (TypeScript-native) |
| Real-Time | Socket.io (WebSocket) |
| Observability | OpenTelemetry (traces), Prometheus (`prom-client`), Winston (logs) |
| Security | Helmet, `@nestjs/throttler`, SSRF guard, AES envelope encryption |
| Docs | OpenAPI / Swagger |

---

## All Modules

| Module | Path | Purpose |
|---|---|---|
| Identity | `modules/identity/` | Golden Record, GDPR, DSAR, consent, conflict resolution, expired access the expiry run could not remove: retry (operator) or close as removed manually (policy-admin) (`POST /identity/:id/access/expiry/retry`, `.../removed-manually`) |
| Policy | `modules/policy/` | ABAC policy CRUD, simulation, evaluation; access review exclusions (a review revoke the engine honours in every intent, `GET /identity/:id/access/review-exclusions`, counts per policy; ended when the identity's offboarding has run) |
| Connectors | `modules/connectors/` | Plugin registry + all connector implementations |
| Reconciliation | `modules/reconciliation/` | Drift detection, auto-remediation, connector health |
| Blueprints | `modules/blueprints/` | Visual pipeline, deploy/pause/resume, impact analysis |
| Auth | `modules/auth/` | Local auth (email/password), SAML SSO, MFA (TOTP) |
| SCIM Inbound | `modules/scim-inbound/` | SCIM 2.0 server (Users, Groups, ServiceProviderConfig); a user update that changes a field an HR source masters is refused (400, `scimType: "mutability"`) |
| Access Review | `modules/access-review/` | Certification campaigns, reviewer decisions |
| Analytics | `modules/analytics/` | Offboarding forecast, license forecast, seasonal patterns |
| Anomaly | `modules/anomaly/` | Anomaly detection, risk scores, triage |
| Entitlement Catalog | `modules/entitlement-catalog/` | Discovered entitlements, tagging |
| Role Bundles | `modules/role-bundles/` | Reusable role bundle CRUD |
| Policy Suggestions | `modules/policy-suggestions/` | AI-generated policy recommendations |
| Onboarding | `modules/onboarding/` | Onboarding workflow trigger |
| Offboarding | `modules/offboarding/` | Offboarding workflow trigger |
| Leavers | `modules/leavers/` | Leaver detection after each HR sync, mass-leaver batches (approve/reject), per-tenant leaver policy |
| Joiners | `modules/joiners/` | Joiner detection after each HR sync: onboarding of the identities it minted once the pipeline is deployed, mass-joiner batches (`/joiners/*`), per-tenant mass-joiner policy |
| Bulk Provisioning | `modules/bulk-provisioning/` | Batch provisioning with approval gates |
| Audit | `modules/audit/` | Immutable audit trail, integrity verification, PII reveal |
| Dead Letter | `modules/dead-letter/` | Failed workflow inspection, replay, dismiss, auto-retry |
| Event Subscriptions | `modules/event-subscriptions/` | Outbound webhooks (the only subscription type): HMAC-SHA256 signed deliveries, retries, delivery history, test send |
| Notifications | `modules/notifications/` | Email over SMTP to access request approvers, access reviewers and owners of expiring time-bound access; off without `SMTP_HOST` |
| Dev Tools | `modules/dev-tools/` | Workflow & transaction inspection (dev only) |
| Access Requests | `modules/access-requests/` | Self-service access request portal, approval queues |
| Compliance Reporting | `modules/compliance-reporting/` | GDPR consent, DSAR export, erasure |
| Correlation Config | `modules/correlation-config/` | Identity correlation rule configuration |
| Privileged Access | `modules/privileged-access/` | Privileged access management (PAM), admin accounts |
| Risk Scoring | `modules/risk-scoring/` | Risk score calculation engine |
| Intelligence | `modules/intelligence/` | Rubber-stamp detection, peer group deviation, smart recommendations |
| Credential Lifecycle | `modules/credential-lifecycle/` | Credential inventory, password policies, rotation tracking |
| Mover | `modules/mover/` | Mover workflow trigger (role/department change → entitlement delta), access preview and re-evaluation (`GET /identity/:id/access/preview`, `POST /identity/:id/access/re-evaluate`), lifting an access review exclusion with the run that gives the access back (re-evaluation; for an account, onboarding) (`POST /identity/:id/access/review-exclusions/:exclusionId/lift`, policy-admin), mover timeline, HR-driven mover after each HR sync with mass-mover batches (`/movers/*`) and per-tenant mass-mover policy |
| NHI | `modules/nhi/` | Non-human identities (service accounts, workloads, AI agents, bots; collection `agent_identities`): create, delegate, revoke, kill switch, short-lived credentials (`/nhi`) |
| Access Explorer | `modules/access-explorer/` | Graph-powered "who has access to what" queries (Neo4j; `503` without it), filled by domain events and by the resync from MongoDB (`POST /access-explorer/resync`, super-admin) |
| Graph (infra) | `infrastructure/graph/` | Neo4j driver (optional): fail-open reads and writes for the event sync and health check, strict ones (`503`) for the access explorer and the resync |
| Agent Management | `modules/agent-management/` | Remote agent topology: register, heartbeat, stale detection, decommission |

---

## Connectors (Registered)

11 registered connectors, each with a `connector.manifest.ts` and the files of the **5-File Pattern** it needs: module, interface and service in every connector, client and mapper where it has them (`csv-hr` and `file-outbound` have neither; `discord-webhook`, `google-sheets`, `json-api-hr` and `servicenow` have no mapper). Full details: `rules/connectors.md`.

| Connector | Type | Protocol |
|---|---|---|
| Entra ID | Target | Microsoft Graph API |
| Active Directory | Target | LDAP (`ldapts`) |
| Okta | Target | Okta REST API (`/api/v1`) |
| SCIM 2.0 (Generic) | Target | SCIM 2.0 (push provisioning) |
| ServiceNow | Target | ServiceNow Table API (`sys_user`, incidents) |
| CSV HR | Source | File parse |
| JSON API HR | Source | HTTP |
| File Outbound | Target | File write |
| Discord Webhook | Target | Webhook |
| GitHub | Target | GitHub API |
| Google Sheets | Target | Google Sheets API |

SCIM 2.0 inbound (EuroID as the SCIM server) is the `modules/scim-inbound/` module, not a connector.

**Registration:** `modules/connectors/plugin/register-connectors.ts`

**Entra ID:** For directory role discovery, grant `RoleManagement.Read.Directory` to the app registration.

**Shared connector infrastructure:**

| File | Purpose |
|---|---|
| `connector.interface.ts` | `IConnector` contract |
| `connector-config.controller.ts` | Connector CRUD, install, health-check, discover API |
| `connector-config.service.ts` | Config persistence & lifecycle |
| `hr-ingestion.service.ts` | HR source ingestion orchestration |
| `sync-scheduler.service.ts` | Scheduled sync coordination |
| `schemas/connector-config.schema.ts` | Mongoose schema for connector configs |
| `hr/` | HR source abstraction layer |
| `plugin/` | Plugin registry & manifest loading |

---

## Temporal Workflows

| Workflow | File | Purpose |
|---|---|---|
| Onboarding | `onboarding.workflow.ts` | Full user onboarding saga; the health check step in `onboarding-health-check.ts` |
| Offboarding | `offboarding.workflow.ts` | User offboarding & access revocation: the person's linked admin accounts first, each by a child offboarding (`offboarding-linked-admins.ts`), then every target (`offboarding-deprovision.ts`) |
| Reconciliation | `reconciliation.workflow.ts` | Daily drift detection |
| Reconcile Batch | `reconcile-batch.workflow.ts` | Scatter-gather batch reconciliation |
| Bulk Provisioning | `bulk-provisioning.workflow.ts` | Batch provisioning with approval gates; result builders in `bulk-provisioning-results.ts` |
| Scheduled Sync | `scheduled-sync.workflow.ts` | Periodic connector sync |
| Archival | `archival.workflow.ts` | Cold storage export before TTL delete |
| Distributed Transaction | `distributed-transaction.workflow.ts` | Multi-system saga with compensation |
| Access Review | `access-review.workflow.ts` | Certification campaign lifecycle |
| Access Request Approval | `access-request-approval.workflow.ts` | Self-service access request approval flow |
| Admin Account Provisioning | `admin-account-provisioning.workflow.ts` | Privileged admin account provisioning (accounts created disabled), one child per admin tier from onboarding (`onboarding-admin-tiers.ts`) |
| Privileged Session | `privileged-session.workflow.ts` | PAM just-in-time session: enables a linked admin account's accounts in the targets, waits on a durable timer or the end signal, disables them |
| Entitlement Expiry | `entitlement-expiry.workflow.ts` | Auto-revoke expired entitlements |
| Orphan Cleanup | `orphan-cleanup.workflow.ts` | Detect and clean up orphaned accounts |
| Recertification Scheduler | `recertification-scheduler.workflow.ts` | Periodic access recertification campaigns |
| Risk Score Calculation | `risk-score-calculation.workflow.ts` | Identity risk score computation |
| Intelligence Batch | `intelligence-batch.workflow.ts` | Nightly peer group + reviewer quality scoring |
| Audit Archive | `audit-archive.workflow.ts` | Daily: creates the tenants' Merkle checkpoints, then S3 Object Lock export (WORM compliance) |
| Mover | `mover.workflow.ts` | Role/department change → entitlement delta (add/remove) |
| Credential Rotation | `credential-rotation.workflow.ts` | Nightly CronWorkflow, one activity call per active tenant: fills the credential inventory from Entra ID and AD, reports due credentials; resets no password |

---

## Temporal Activities

| Activity | File | Purpose |
|---|---|---|
| HR | `hr.activities.ts` | HR source sync & ingestion |
| Identity | `identity.activities.ts` | Identity hub read/write |
| Entra | `entra.activities.ts` | Entra ID / Microsoft 365 provisioning |
| AD | `ad.activities.ts` | Active Directory provisioning |
| Okta | `okta.activities.ts` | Okta health check, provisioning, disable, deprovision and entitlement discovery (`provisioning-okta` queue) |
| SCIM | `scim.activities.ts` | SCIM outbound provisioning |
| Policy | `policy.activities.ts` | Policy evaluation, ProvisioningIntent; the targets an access review excluded for a person (`getReviewExcludedTargets`, onboarding) |
| Reconciliation | `reconciliation.activities.ts` | Drift detection & remediation |
| Bulk Provisioning | `bulk-provisioning.activities.ts` | Batch provisioning execution; pre-flight validation in `bulk-provisioning-validation.ts` |
| Pipeline | `pipeline.activities.ts` | Blueprint pipeline orchestration |
| Scheduled Sync | `scheduled-sync.activities.ts` | Connector sync execution |
| Archival | `archival.activities.ts` | Cold storage export (S3 / Azure Blob) |
| Writeback | `writeback.activities.ts` | Field writeback to source systems |
| Distributed Transaction | `distributed-transaction.activities.ts` | Saga step execution & compensation |
| Offboarding | `offboarding.activities.ts` | Publishes an offboarding's per-system result as `identity.offboarding_completed` (`recordOffboardingOutcome`), read by the timeline and the Leavers history |
| Access Review | `access-review.activities.ts` | Campaign item generation & enforcement |
| Access Review Revocation | `access-review-revocation.activities.ts` | Removes revoked access at campaign close: list and record on the default queue, `revokeReviewAccess` on the Entra, AD, Okta and SCIM queues, `revokeReviewAccount` (an account item in another target, through offboarding's per-target deprovision: `access-review-account-revocation.ts`) on the default queue |
| Config | `config.activities.ts` | Config loading from env |
| Rate Limiter | `rate-limiter.activities.ts` | Throttling / token bucket |
| Access Request | `access-request.activities.ts` | Access request lifecycle |
| Entitlement Expiry | `entitlement-expiry.activities.ts` | Expiry detection and revocation |
| Orphan | `orphan.activities.ts` | Orphaned account detection |
| Privileged Access | `privileged-access.activities.ts` | PAM provisioning (`getOrCreateLinkedAdminIdentity`, `settleAdminAccountState`); the live linked admin identities an offboarding cascades to, their sessions told to end (`getLinkedAdminIdentities`); the privileged session's reads and writes (`getPrivilegedSessionTargets`, `markPrivilegedSessionActivating`, `recordPrivilegedSession{Active,Failed,Ended}`) |
| Recertification | `recertification.activities.ts` | Recertification campaign execution |
| Risk Score | `risk-score.activities.ts` | Risk score data gathering and calculation |
| Intelligence | `intelligence.activities.ts` | Peer group build + reviewer quality scoring |
| Audit Archive | `audit-archive.activities.ts` | Creates Merkle checkpoints (`getUnarchivedCheckpoints`), S3 Object Lock export for them |
| Credential | `credential.activities.ts` | Credential state reads from Entra ID and AD (last password change, Entra ID MFA methods); no password reset |
| Mover | `mover.activities.ts`, `mover-access.activities.ts` | Policy evaluation of a move by identity id (`evaluateMoverChange`), entitlement delta computation, run outcome (timeline event, access baseline); `applyMoverAccess` on the Entra ID, AD, Okta and SCIM queues |
| Credential Rotation | `credential-rotation.activities.ts`, `credential-inventory-refresh.ts` | The rotation run: inventory refresh (credential state read through `credential.activities.ts`, status from the credential policy), due and expiring-soon events; no reset (no secret storage) |
| GitHub | `github.activities.ts` | Onboarding health check and organization invitation (the GitHub account when the identity has a GitHub login, else the email), offboarding membership removal or invitation cancel (default queue) |
| ServiceNow | `servicenow.activities.ts` | Onboarding health check and sys_user create/update with a tracking incident, offboarding deactivate (default queue) |
| No-account targets | `no-account-target.activities.ts` | Onboarding health check and delivery for Discord webhook, Google Sheets and File outbound, which keep no account (default queue) |

**Activity Modules:** `activities.module.ts`, `access-request-activities.module.ts`, `archival-activities.module.ts`, `audit-archive-activities.module.ts`, `blueprint-activities.module.ts`, `bulk-activities.module.ts`, `connector-activities.module.ts`, `credential-activities.module.ts`, `credential-rotation-activities.module.ts`, `entitlement-expiry-activities.module.ts`, `identity-activities.module.ts`, `intelligence-activities.module.ts`, `mover-activities.module.ts`, `orphan-activities.module.ts`, `privileged-access-activities.module.ts`, `recertification-activities.module.ts`, `reconciliation-activities.module.ts`, `risk-score-activities.module.ts`, `writeback-activities.module.ts`

---

## Infrastructure (`infrastructure/`)

| Module | Path | Purpose |
|---|---|---|
| AuthModule | `infrastructure/auth/` | JWT validation, RBAC, tenant guards. Dev bypass: `AUTH_DISABLED=true` |
| EventsModule | `infrastructure/events/` | Domain event bus (audit, metrics, timeline); every `@OnEvent` handler failure to the dead-letter queue (`handler-failure-capture.service.ts`) |
| HealthModule | `infrastructure/health/` | Liveness + readiness probes |
| ObservabilityModule | `infrastructure/observability/` | Logger (Winston, PII redaction) + Metrics (Prometheus) + Tracing (OpenTelemetry) |
| SecretsModule | `infrastructure/secrets/` | AES envelope encryption, key rotation |
| MultiTenancyModule | `infrastructure/multi-tenancy/` | Mongoose plugin, TenantGuard, TenantContextInterceptor |
| RealTimeModule | `infrastructure/realtime/` | WebSocket (socket.io), tenant-scoped rooms |
| RetentionModule | `infrastructure/retention/` | Data retention TTL, soft-delete purge, cold storage archival |
| ConfigModule | `infrastructure/config/` | Default values, Temporal config |
| TemporalModule | `infrastructure/temporal/` | Shared Temporal client, task queue config, rate-limit interceptor, payload encryption codec |
| CacheModule | `infrastructure/cache/` | Redis module |
| ResilienceModule | `infrastructure/resilience/` | Circuit breaker |
| ElasticsearchModule | `infrastructure/elasticsearch/` | Optional ES wrapper for the analytics read model: connects to `ELASTICSEARCH_NODE` (default `http://localhost:9200`) at start; when it cannot, it runs fail-open (writes skipped, searches empty) |
| GraphModule | `infrastructure/graph/` | Neo4j driver (optional, `NEO4J_*`): fail-open for the event sync and health check, `503` for the access explorer and the resync |
| OpaModule | `infrastructure/opa/` | OPA sidecar HTTP client — policy query, bundle push, fail-open (no-op when `OPA_ENABLED=false`) |
| Services | `infrastructure/services/` | Correlation hash utilities |

## Shared (`shared/`)

| Module | Path | Purpose |
|---|---|---|
| DTOs | `shared/dtos/` | `StandardUserDto`, `ProvisioningResult`, `BulkOperation`, `DistributedTransaction` |
| Errors | `shared/errors/` | Custom exceptions (`RateLimitedException`, etc.) |
| Filters | `shared/filters/` | Exception filters (`VersionConflictFilter`, `ZodErrorFilter`), registered from `global-exception-filters.ts` |
| SCIM Shared | `shared/scim/` | SCIM types, filter parser, error formatting |
| Utils | `shared/utils/` | Utility functions |

### Cross-Cutting Concerns

| Type | File | Purpose |
|---|---|---|
| Guard | `infrastructure/auth/jwt-auth.guard.ts` | JWT token validation |
| Guard | `infrastructure/auth/roles.guard.ts` | RBAC role enforcement; `platform-admin` only by `PLATFORM_ADMIN_USER_IDS` (`platform-admin.ts`) |
| Guard | `infrastructure/auth/tenant.guard.ts` | Multi-tenancy enforcement |
| Interceptor | `infrastructure/multi-tenancy/tenant-context.interceptor.ts` | Injects tenant context per request |
| Interceptor | `infrastructure/temporal/rate-limit-activity.interceptor.ts` | Temporal activity rate limiting |
| Helper | `infrastructure/temporal/tenant-workflow.ts` | Workflow handle by id only for the caller's tenant (`TenantId` search attribute), else 404 |
| Codec | `infrastructure/temporal/temporal-payload-codec.ts` | Encrypts every Temporal payload of the API's client and the worker (`temporalDataConverter`); `src/scripts/decode-temporal-payloads.ts` decrypts an exported history |
| Helper | `workflows/child-workflow-tenant.ts` | Child workflow start options with the parent's `TenantId` and memo (behind a per-workflow patch) |
| Helper | `infrastructure/secrets/config-secret-mask.ts` | Secret masking in responses; a saved mask keeps the stored value |
| Middleware | `infrastructure/middleware/correlation.middleware.ts` | Correlation ID for distributed tracing |
| Filter | `shared/filters/version-conflict.filter.ts` | Mongoose version conflict → HTTP 409 |
| Filter | `shared/filters/zod-error.filter.ts` | ZodError from a `Schema.parse()` of request input → HTTP 400 with field paths |
| SSRF Guard | `infrastructure/url-validation/ssrf-guard.ts` | Prevents SSRF in connector URL fields |
| Decorator | `infrastructure/auth/public.decorator.ts` | Marks endpoints as public (skips JWT) |
| Decorator | `infrastructure/auth/roles.decorator.ts` | Declares required roles on endpoints |
| Decorator | `infrastructure/auth/auth-user.decorator.ts` | Extracts authenticated user from request |

---

## RBAC Roles

| Role | Scope |
|---|---|
| `super-admin` | Full access inside its own tenant. GDPR erasure, the tenant's admins, emergency ops. |
| `platform-admin` | Not a tenant role: tenant management (`/tenants`) and deployment diagnostics. Granted only by `PLATFORM_ADMIN_USER_IDS` (user ids); see `docs/architecture/security/PLATFORM_AUTH_ARCHITECTURE.md` § Platform Admin. |
| `policy-admin` | Policy CRUD, blueprint deploy, SoD, simulation, leaver batches and leaver policy, HR mover batches and mass-mover policy, HR joiner batches and mass-joiner policy, closing a failed expiry or an access request's failing removal as removed manually, lifting an access review exclusion. |
| `connector-admin` | Connector install, config, health-check. |
| `operator` | Identity CRUD, onboarding/offboarding, reconciliation, provisioning. |
| `viewer` | Read-only access across all modules. |

---

## API Endpoints

Full endpoint reference: `docs/architecture/api/API_REFERENCE.md`.

Swagger UI: `http://localhost:3001/api/docs`. OpenAPI spec: `swagger-spec.json`.

Contract changelog: `docs/architecture/API_CHANGELOG.md`.

---

## Database Migrations

Uses `migrate-mongo` for versioned schema migrations. Files in `backend/migrations/`.

| Command | Purpose |
|---|---|
| `npm run migrate:up` | Apply all pending migrations |
| `npm run migrate:down` | Roll back the last migration |
| `npm run migrate:create -- <name>` | Create a new migration file |
| `npm run migrate:status` | Show applied/pending migrations |
| `npm run migrate:up:dist`, `migrate:status:dist`, `migrate:down:dist` | The same on the compiled migrations in `dist/` (after `npm run build`, no ts-node): what the API image runs |

`migrate:up`, `migrate:down` and `migrate:status` load the TypeScript files through ts-node (development). The API image (`Dockerfile`) has neither ts-node nor `src/`: its CMD runs `npm run migrate:up:dist` before the app starts, which loads each `migrations/<name>.ts` as its compiled `dist/migrations/<name>.js` (`scripts/load-compiled-migrations.js`, preloaded with `node -r`). migrate-mongo records a migration by its file name, extension included, so both ways record and recognise the same `.ts` names in `migration_changelog`. Config: `migrate-mongo-config.ts` (compiled to `dist/migrate-mongo-config.js` for the image).

---

## Data Flow

```
1. Inbound     Connector → Identity.sources + EntitlementCatalog
2. Normalize   Zod → Identity.profile (Golden Record)
3. Evaluate    Policy Engine → ProvisioningIntent
4. Simulate    Dry-run → Impact Report
5. Outbound    Connector → Target System
6. Reconcile   Drift detection → Auto-Remediate
7. Archive     TTL expiry → Cold Storage (S3/Azure Blob)
```

---

## Environment Variables

See `.env.example` for the full list. Critical variables:

| Variable | Required | Purpose |
|---|---|---|
| `MONGO_URI` | Yes | MongoDB connection string |
| `TEMPORAL_ADDRESS` | Yes | Temporal server (default `localhost:7233`) |
| `TEMPORAL_NAMESPACE` | No | Temporal namespace of the API's client, the worker and its schedules, all from `infrastructure/config/temporal.config.ts` (default `default`); needs the `TenantId` search attribute (`docs/DEPLOYMENT.md` § 4) |
| `ENCRYPTION_KEY` | Yes (prod) | Base64-encoded 32-byte key for connector credential encryption |
| `JWT_SECRET` | Yes (prod) | JWT signing secret for local auth |
| `PORT` | No | API port (default `3001`) |
| `AUTH_DISABLED` | No | Set `true` for local dev without IdP |

---

## Dev Commands

| Command | Purpose |
|---|---|
| `npm run start:dev` | API server with watch (port 3001) |
| `npm run start:worker:watch` | Temporal worker with watch |
| `npm run build` | Compile to `dist/` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint with auto-fix |
| `npm run format` | Prettier |
| `npm test` | Jest (unit + integration) |
| `npm run test:watch` | Jest in watch mode |
| `npm run test:cov` | Jest with coverage |
| `npm run test:e2e` | End-to-end tests (at most 2 workers, `test/jest-e2e.json`) |
| `npm run start:prod` | Production API |
| `npm run start:worker:prod` | Production worker |
| `npm run seed:demo` | Fill a tenant with demo data (`-- --tenant <id> --count <n> --reset`); see `docs/GETTING_STARTED.md` § Demo Data |

---

## Test Structure

> **Full guide:** `backend/docs/TESTING.md` — patterns, helpers, known issues, examples.

| Type | Location |
|---|---|
| Unit | `*.spec.ts` next to source |
| Integration | `*.integration.spec.ts` |
| Connector contract | `connector.contract.spec.ts` |
| Policy simulation | `policy-simulation.spec.ts` (fixtures in `test/fixtures/`) |
| Workflow | `onboarding.workflow.spec.ts`, `offboarding.workflow.spec.ts` |
| Infrastructure | `src/testing/` (`mock-factories.ts`, `test-db.ts`, `test-helpers.ts`) |

---

## Don't Duplicate (Check Before Creating)

- **Activity exists?** Check `src/activities/` (34 activity files).
- **Workflow exists?** Check `src/workflows/` (19 workflows).
- **Shared type exists?** Check `shared/dtos/`, `shared/scim/`, `shared/errors/`.
- **Guard/middleware exists?** Check `infrastructure/auth/`, `infrastructure/middleware/`, `shared/filters/`.
- **Connector infra exists?** Check `modules/connectors/connector.interface.ts`, `connector-config.service.ts`.

---

## Project Structure

```
backend/src/
├── main.ts                        # NestJS API entrypoint (port 3001)
├── worker.ts                      # Temporal worker entrypoint
├── worker-default-activities.ts   # Activity map of the default task queue
├── worker-scheduled-workflows.ts  # Workflows worker.ts starts on a schedule (each exported from workflows/index.ts)
├── app.module.ts
├── activities/                    # Temporal activities (side effects, idempotent)
│   ├── *.activities.ts            # 34 activity files
│   └── *-activities.module.ts     # 18 activity DI modules, plus activities.module.ts
├── workflows/                     # Temporal workflows (pure, deterministic)
│   └── *.workflow.ts              # 19 workflow files
├── infrastructure/                # Cross-cutting infrastructure concerns
│   ├── auth/                      # JWT, RBAC, Tenant guards, decorators
│   ├── cache/                     # Redis module
│   ├── common.module.ts           # Aggregate infrastructure module
│   ├── config/                    # Defaults, Temporal config
│   ├── events/                    # Domain event bus
│   ├── graph/                     # Optional Neo4j driver (access explorer)
│   ├── health/                    # Liveness / readiness probes
│   ├── middleware/                # Correlation ID middleware
│   ├── multi-tenancy/             # Mongoose plugin, guard, interceptor
│   ├── observability/             # Logger + Metrics + Tracing (merged)
│   ├── realtime/                  # WebSocket gateway (socket.io)
│   ├── resilience/                # Circuit breaker
│   ├── retention/                 # Data retention, cold storage archival
│   ├── elasticsearch/             # Optional ES wrapper (CQRS read model, fail-open)
│   ├── opa/                       # OPA sidecar HTTP client (fail-open)
│   ├── secrets/                   # AES envelope encryption, key rotation
│   ├── services/                  # Correlation hash
│   ├── temporal/                  # Task queue config, rate-limit interceptor
│   └── url-validation/            # SSRF guard
├── shared/                        # Domain-shared, reusable artifacts
│   ├── dtos/                      # StandardUserDto, ProvisioningResult, etc.
│   ├── errors/                    # Custom exceptions
│   ├── filters/                   # Exception filters (version-conflict → 409, ZodError → 400)
│   ├── scim/                      # Shared SCIM types, filter parser
│   └── utils/                     # Utility functions
├── testing/                       # Test infrastructure (top-level)
│   ├── index.ts                   # Barrel export
│   ├── mock-factories.ts
│   ├── test-db.ts
│   └── test-helpers.ts
├── modules/                       # Feature modules
│   ├── access-explorer/           # Neo4j access graph queries, resync
│   ├── access-requests/           # Self-service access request portal
│   ├── access-review/
│   ├── agent-management/          # Remote agent topology (heartbeat, stale detection)
│   ├── analytics/
│   ├── anomaly/
│   ├── audit/
│   ├── auth/
│   ├── blueprints/
│   ├── bulk-provisioning/
│   ├── compliance-reporting/      # GDPR consent, DSAR, erasure
│   ├── connectors/                # Plugin registry + 11 connector implementations
│   ├── correlation-config/        # Identity correlation rules
│   ├── credential-lifecycle/      # Credential inventory, policies, rotation
│   ├── dead-letter/
│   ├── dev-tools/
│   ├── entitlement-catalog/
│   ├── event-subscriptions/       # Outbound webhooks
│   ├── identity/
│   ├── intelligence/              # Reviewer quality, peer groups, recommendations
│   ├── mover/                     # Mover workflow trigger (role/dept change, HR sync), mover batches
│   ├── leavers/                   # HR-driven leavers, mass-leaver batches
│   ├── joiners/                   # HR-driven joiners, mass-joiner batches
│   ├── nhi/                       # Non-human identities
│   ├── notifications/             # Email over SMTP
│   ├── offboarding/
│   ├── onboarding/
│   ├── policy/
│   ├── policy-suggestions/
│   ├── privileged-access/         # PAM, admin accounts
│   ├── reconciliation/
│   ├── risk-scoring/              # Risk score calculation
│   ├── role-bundles/
│   └── scim-inbound/
└── scripts/
```

### Path Aliases

| Alias | Points To | Use For |
|---|---|---|
| `@infrastructure/*` | `src/infrastructure/*` | Auth, events, middleware, secrets, resilience, etc. |
| `@shared/*` | `src/shared/*` | DTOs, errors, filters, SCIM, utils |
| `@modules/*` | `src/modules/*` | Feature modules |
| `@testing/*` | `src/testing/*` | Mock factories, test DB, test helpers |
| `@testing` | `src/testing/index.ts` | Bare barrel import |
