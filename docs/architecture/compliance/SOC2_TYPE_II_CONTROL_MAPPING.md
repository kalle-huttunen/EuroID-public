# SOC 2 Type II — Trust Service Criteria Control Mapping

> **Status:** Audited against the code on 2026-11-22 (first written for CURRENT_TASK_240)
> **Last Updated:** 2026-11-22
> **Cross-references:** [GDPR Compliance](../../../backend/src/modules/compliance-reporting/docs/GDPR_COMPLIANCE.md) | [NIST 800-53 Mapping](NIST_800_53_CONTROL_MAPPING.md) | [Platform Auth](../security/PLATFORM_AUTH_ARCHITECTURE.md) | [Data Retention](../security/DATA_RETENTION.md)

---

## Overview

This document maps EuroID's controls to AICPA SOC 2 Type II Trust Service Criteria (TSC). Each row cites the code (file path) that implements it. Status is one of:

- **Implemented**: the cited code implements the control as described.
- **Partial**: some of it exists; the reason says what is missing.
- **Planned**: no code implements it yet; the reason says what exists instead, if anything.

A status is only as good as its evidence: re-check a row against the cited files before relying on it in an audit.

---

## CC1 — Control Environment

| Criteria | Control | Implementation Evidence | Status |
|----------|---------|------------------------|--------|
| CC1.1 | RBAC role hierarchy with 5 defined roles | `backend/src/infrastructure/auth/roles.decorator.ts`, `backend/src/infrastructure/auth/roles.guard.ts` | Implemented |
| CC1.2 | Tenant isolation via schema-level tenantId plugin, tenant guard and request tenant context | `backend/src/infrastructure/multi-tenancy/tenant.plugin.ts`, `backend/src/infrastructure/auth/tenant.guard.ts`, `backend/src/infrastructure/multi-tenancy/tenant-context.interceptor.ts`, `backend/src/infrastructure/multi-tenancy/tenant-context.helper.ts` | Implemented |
| CC1.3 | Per-tenant rate limiting | `backend/src/app.module.ts` (global `ThrottlerGuard`) | Partial: the throttler is keyed per client, not per tenant; there is no `TenantThrottlerGuard` |
| CC1.4 | Environment-based configuration (no hardcoded secrets) | `backend/src/infrastructure/config/` (Zod-validated env config), JWT_SECRET strength check in `backend/src/main.ts` | Implemented |

## CC2 — Communication & Information

| Criteria | Control | Implementation Evidence | Status |
|----------|---------|------------------------|--------|
| CC2.1 | Immutable audit log with SHA-256 hash chain | `backend/src/modules/audit/audit.service.ts` (integrityHash, previousHash) | Implemented |
| CC2.2 | Audit integrity verification endpoint | `backend/src/modules/audit/audit.controller.ts` (`GET /audit/verify-integrity`) | Implemented |
| CC2.3 | Domain event bus for cross-module communication | `backend/src/infrastructure/events/event-emitter.service.ts` (`DomainEventEmitterService`) | Implemented |
| CC2.4 | Correlation ID propagation across services | `backend/src/infrastructure/middleware/correlation.middleware.ts` | Implemented |
| CC2.5 | API changelog maintained for consumers | `docs/architecture/API_CHANGELOG.md` | Implemented |
| CC2.6 | Structured logging with PII redaction | `backend/src/infrastructure/observability/pii-redact.format.ts`, `backend/src/infrastructure/observability/logger.config.ts` | Implemented |

CC2.1 and CC2.2: GDPR erasures run before commit `47fa1cd7` (2026-11-24) recorded no gap, so `verify-integrity` reports the chain there as `broken_link` (GDPR_COMPLIANCE.md, Known Limitations, item 4).

## CC3 — Risk Assessment

| Criteria | Control | Implementation Evidence | Status |
|----------|---------|------------------------|--------|
| CC3.1 | 7-factor identity risk scoring engine (entitlements, high-risk entitlements, SoD, anomalies, admin tier, dormancy, peer deviation) | `backend/src/modules/risk-scoring/risk-scoring.service.ts`, `backend/src/infrastructure/config/risk-scoring.config.ts` | Implemented |
| CC3.2 | Anomaly detection for access pattern deviations | `backend/src/modules/anomaly/anomaly.service.ts`, `backend/src/modules/anomaly/anomaly-rules.ts` | Implemented |
| CC3.3 | Blast radius analysis for entitlement changes | `backend/src/modules/analytics/analytics.service.ts` (`computeBlastRadius`) | Partial: blast radius is computed for offboarding only, not for other entitlement changes |
| CC3.4 | Peer comparison for outlier detection | `backend/src/modules/intelligence/intelligence.service.ts` (peer groups and outliers), peer deviation factor in `backend/src/modules/risk-scoring/risk-scoring.service.ts` | Implemented |
| CC3.5 | Orphan entitlement detection | `backend/src/modules/policy-suggestions/policy-suggestions.service.ts` (`analyzeOrphanEntitlements`), `backend/src/modules/reconciliation/orphan-detection.service.ts` (orphan accounts) | Implemented |
| CC3.6 | Drift detection via reconciliation | `backend/src/modules/reconciliation/reconciliation.service.ts` | Implemented |

## CC4 — Monitoring Activities

| Criteria | Control | Implementation Evidence | Status |
|----------|---------|------------------------|--------|
| CC4.1 | OpenTelemetry distributed tracing | `backend/src/infrastructure/observability/tracing.ts`, `backend/src/infrastructure/observability/observability.module.ts` | Implemented |
| CC4.2 | Health check endpoints (liveness + readiness) | `backend/src/infrastructure/health/health.controller.ts` | Implemented |
| CC4.3 | Event subscriptions with OCSF translation | `backend/src/modules/event-subscriptions/event-delivery.service.ts` | Partial: webhook event subscriptions exist; there is no OCSF translation |
| CC4.4 | Temporal workflow visibility and monitoring | `docker-compose.yml` (`temporal-ui`), OpenTelemetry workflow and activity interceptors in `backend/src/worker.ts` | Implemented |

## CC5 — Control Activities

| Criteria | Control | Implementation Evidence | Status |
|----------|---------|------------------------|--------|
| CC5.1 | ABAC policy engine with condition groups | `backend/src/modules/policy/policy-engine.service.ts` | Implemented |
| CC5.2 | Separation of Duties (SoD) enforcement | `backend/src/modules/policy/sod.service.ts`, `backend/src/modules/policy/sod-policy.controller.ts` | Implemented |
| CC5.3 | Zod schema validation at API boundary | Global `ZodValidationPipe` in `backend/src/main.ts` for Zod DTOs; endpoints that take `unknown` bodies parse them with Zod schemas, e.g. `backend/src/modules/policy/sod-policy.controller.ts`, `backend/src/modules/event-subscriptions/event-subscription.service.ts` | Implemented |
| CC5.4 | Simulation/dry-run before destructive actions | `backend/src/modules/blueprints/impact-analysis.service.ts`, `POST /policy/simulate` in `backend/src/modules/policy/policy.controller.ts`, bulk provisioning `dryRun` | Partial: dry runs exist for blueprints, policies and bulk batches, but no code requires one before every destructive action |
| CC5.5 | Access review campaigns with periodic certification | `backend/src/modules/access-review/access-review.service.ts` | Implemented |
| CC5.6 | Role mining for least-privilege optimization | `backend/src/modules/policy-suggestions/policy-suggestions.service.ts` | Partial: there is no role mining; policy suggestions mine birthright patterns from the entitlement distribution |
| CC5.7 | Pact consumer-driven contract tests | None | Planned: there is no Pact dependency or contract; `backend/src/modules/connectors/connector.contract.spec.ts` is a plain Jest spec |

## CC6 — Logical & Physical Access Controls

| Criteria | Control | Implementation Evidence | Status |
|----------|---------|------------------------|--------|
| CC6.1 | JWT/OIDC authentication with configurable providers | `backend/src/infrastructure/auth/jwt-auth.guard.ts`, `docs/architecture/security/PLATFORM_AUTH_ARCHITECTURE.md` | Implemented |
| CC6.2 | JIT privileged access with time-bounded sessions | `backend/src/modules/privileged-access/privileged-access.service.ts` (`linkedAdminAccounts[].expiresAt`, `deactivateExpiredSessions` run by the hourly expiry sweep) | Partial: admin accounts are time-bounded, but there is no JIT session model (`jit-session.schema.ts` does not exist) |
| CC6.3 | Heartbeat monitoring for active sessions | None | Planned: there are no privileged-session heartbeats or heartbeat-miss revocation |
| CC6.4 | Break-glass emergency access with full audit trail | `backend/src/infrastructure/auth/jwt-auth.guard.ts` (`EMERGENCY_ADMIN_TOKEN`: rate limited, each use audited as `EMERGENCY_ACCESS`, severity critical) | Implemented |
| CC6.5 | Field-level PII encryption (AES-256-GCM) | `backend/src/infrastructure/secrets/encryption.service.ts` | Planned: AES-256-GCM encrypts connector config and MFA secrets only; PII fields such as `personalEmail` and `mobilePhone` are stored in plaintext |
| CC6.6 | Credential lifecycle management | `backend/src/modules/credential-lifecycle/credential-policy.service.ts`, `backend/src/modules/credential-lifecycle/credential-inventory.service.ts`, `backend/src/workflows/credential-rotation.workflow.ts` | Implemented |
| CC6.7 | Connector sandbox execution isolation | None | Planned: connectors run in-process as plugins; there is no sandbox worker |
| CC6.8 | Graph-powered access path analysis | `backend/src/modules/access-explorer/access-explorer.service.ts` (Neo4j `findAccessPath`, `getIdentityAccessGraph`; fail-open without Neo4j), `backend/src/infrastructure/graph/graph.service.ts` | Implemented |

## CC7 — System Operations

| Criteria | Control | Implementation Evidence | Status |
|----------|---------|------------------------|--------|
| CC7.1 | Temporal durable execution for multi-step workflows | `backend/src/workflows/`, `backend/src/activities/` | Implemented |
| CC7.2 | Circuit breaker pattern for external calls | `backend/src/infrastructure/resilience/connector-circuit-breaker.ts`, `backend/src/modules/blueprints/circuit-breaker.service.ts` | Implemented |
| CC7.3 | Dead letter queue (DLQ) for failed events | `backend/src/modules/dead-letter/dead-letter.service.ts` | Implemented |
| CC7.4 | Scheduled reconciliation workflows | `backend/src/workflows/scheduled-sync.workflow.ts`, `backend/src/workflows/reconcile-batch.workflow.ts` | Implemented |
| CC7.5 | Graceful shutdown with in-flight request draining | None | Planned: `backend/src/main.ts` does not call `enableShutdownHooks()` and has no shutdown handling |
| CC7.6 | Docker multi-stage builds with Trivy scanning | `backend/Dockerfile`, `backend/Dockerfile.worker`, `frontend/Dockerfile` (multi-stage) | Partial: there is no CI (`.github/` has no workflows) and no Trivy scan runs; the `.husky/` hooks scan no images |

## CC8 — Change Management

| Criteria | Control | Implementation Evidence | Status |
|----------|---------|------------------------|--------|
| CC8.1 | CI/CD pipeline with lint, type check, tests, security audit | `.husky/pre-commit` (lint-staged: Prettier, ESLint, related Jest tests, tenant checks), `.husky/pre-push` (backend type check, tests, Temporal e2e) | Partial: no CI and no security audit; local git hooks run lint, type check and tests and can be bypassed |
| CC8.2 | CodeQL SAST analysis | None | Planned: no CodeQL or other SAST runs (no CI, not in the `.husky/` hooks) |
| CC8.3 | License compliance checking | None | Planned: no license check runs (no CI, not in the `.husky/` hooks) |
| CC8.4 | E2E tests with Playwright | `frontend/e2e/`, `frontend/playwright.config.ts` | Partial: the Playwright specs exist, but no CI job runs them |
| CC8.5 | Feature flag system for gradual rollout | None | Planned: there is no feature flag system (`backend/src/infrastructure/feature-flags/` does not exist) |
| CC8.6 | Audit events for configuration changes | `backend/src/modules/policy/policy.service.ts` (policy create/update/delete events), `backend/src/modules/connectors/connector-config.service.ts` (`CONNECTOR_INSTALLED`, `CONFIG_CHANGED`, `CONNECTOR_REMOVED`), `backend/src/infrastructure/events/handlers/audit-event.handler.ts` | Implemented |

## CC9 — Risk Mitigation

| Criteria | Control | Implementation Evidence | Status |
|----------|---------|------------------------|--------|
| CC9.1 | Blueprint simulation engine (dry-run impact analysis) | `backend/src/modules/blueprints/impact-analysis.service.ts` | Implemented |
| CC9.2 | Policy testing mode (`testing` status) | `backend/src/modules/policy/schemas/policy.schema.ts`: status enum | Implemented |
| CC9.3 | Connector config versioning | `backend/src/modules/connectors/schemas/connector-config.schema.ts` | Planned: connector configs have no version or history |

## A1 — Availability

| Criteria | Control | Implementation Evidence | Status |
|----------|---------|------------------------|--------|
| A1.1 | Health check with fail-open design | `backend/src/infrastructure/health/health.service.ts` (MongoDB down: 503; stale connectors: degraded with 200) | Implemented |
| A1.2 | Per-tenant rate limiting | `backend/src/app.module.ts` (global `ThrottlerGuard`) | Partial: the throttler is keyed per client, not per tenant |
| A1.3 | Horizontal scaling via KEDA worker autoscaling | None | Planned: there are no KEDA or Kubernetes manifests and no `backend/src/workers/`; `backend/src/worker.ts` is the single worker entry point. Design: `docs/architecture/future/FUTURE_KEDA_SCALING.md` |
| A1.4 | Redis I/O adapter for WebSocket scaling | None | Planned: `@socket.io/redis-adapter` is a dependency, but `backend/src/main.ts` uses the in-memory `IoAdapter` |
| A1.5 | Staging auto-deploy on merge to main | None | Planned: there is no CI (`.github/` has no workflows) and no `infra/` directory |

## P1 — Privacy

| Criteria | Control | Implementation Evidence | Status |
|----------|---------|------------------------|--------|
| P1.1 | GDPR Right to Erasure (Art. 17) | `backend/src/modules/compliance-reporting/gdpr-erasure.service.ts` | Implemented |
| P1.2 | DSAR export (Art. 15 & 20) | `backend/src/modules/compliance-reporting/dsar-export.service.ts` | Implemented |
| P1.3 | Consent management (Art. 6) | `backend/src/modules/compliance-reporting/consent.service.ts` | Implemented |
| P1.4 | PII redaction in logs | `backend/src/infrastructure/observability/pii-redact.format.ts` | Implemented |
| P1.5 | Field-level PII encryption at rest | None | Planned: PII fields in `backend/src/modules/identity/schemas/identity.schema.ts` are stored in plaintext |
| P1.6 | Data retention policies | `docs/architecture/security/DATA_RETENTION.md`, `backend/src/infrastructure/retention/data-retention.service.ts` | Implemented |

---

## Summary

| Category | Controls Mapped | Implemented | Partial | Planned |
|----------|----------------|-------------|---------|---------|
| CC1 — Control Environment | 4 | 3 | 1 | 0 |
| CC2 — Communication | 6 | 6 | 0 | 0 |
| CC3 — Risk Assessment | 6 | 5 | 1 | 0 |
| CC4 — Monitoring | 4 | 3 | 1 | 0 |
| CC5 — Control Activities | 7 | 4 | 2 | 1 |
| CC6 — Logical Access | 8 | 4 | 1 | 3 |
| CC7 — System Operations | 6 | 4 | 1 | 1 |
| CC8 — Change Management | 6 | 1 | 2 | 3 |
| CC9 — Risk Mitigation | 3 | 2 | 0 | 1 |
| A1 — Availability | 5 | 1 | 1 | 3 |
| P1 — Privacy | 6 | 5 | 0 | 1 |
| **Total** | **61** | **38** | **10** | **13** |
