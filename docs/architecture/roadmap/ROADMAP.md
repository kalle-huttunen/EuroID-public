# EuroID Roadmap

> **Last reviewed:** 2026-02-26 (TASK_242 — CIEM multi-cloud abstraction + Azure RBAC)
> Single source of truth for all planned work. Detailed architecture blueprints are in `docs/architecture/future/`.

---

## How to Use This Document

- Each item links to a detailed architecture blueprint where one exists
- Items without a blueprint are either connector builds (use the [connector template](../../../backend/src/modules/connectors/docs/CONNECTOR_TEMPLATE.md)) or documentation-only tasks
- Priority: P0 = blocking, P1 = high value, P2 = differentiator, P3 = nice-to-have
- Status: Planned | In Progress | Partially Done | Complete

---

## Wave 1: Foundation (Next)

Focus: Event infrastructure, search, compliance.

| # | Item | Priority | Blueprint | Status | Key Infrastructure |
|---|------|----------|-----------|--------|--------------------|
| 1 | Event Sourcing (identity state) | P1 | [FUTURE_EVENT_SOURCING.md](../future/FUTURE_EVENT_SOURCING.md) | Planned (I-01 to I-03: no event store, no `modules/identity/events/`; `user-event.service.ts` is the per-user timeline) | MongoDB |
| 2 | CQRS (ElasticSearch read model) | P1 | [FUTURE_CQRS.md](../future/FUTURE_CQRS.md) | Partially Done (ES `audit-events` read model, `analytics-indexer.service.ts`, and the `analytics/v2/*` routes; no identity projection; ES optional, fail-open) | ElasticSearch |
| 3 | Immutable Audit (Merkle + WORM) | P1 | [FUTURE_IMMUTABLE_AUDIT.md](../future/FUTURE_IMMUTABLE_AUDIT.md) | Complete (Phase 1-3) | S3 Object Lock |
| 4 | SOC 2 Type II control mapping | P1 | [SOC2_TYPE_II_CONTROL_MAPPING.md](../compliance/SOC2_TYPE_II_CONTROL_MAPPING.md) | Complete (61 controls) | None |
| 5 | NIST 800-53 control mapping | P2 | [NIST_800_53_CONTROL_MAPPING.md](../compliance/NIST_800_53_CONTROL_MAPPING.md) | Complete (60 controls) | None |

### Prerequisites Already Complete

SHA-256 audit hash chain, transactional outbox, 38+ domain event types, 7 identity events, OCC with retry, compliance reporting (SOX + ISO 27001).

---

## Wave 2: Intelligence & Connectors

Focus: Graph-powered access intelligence, policy-as-code, critical connectors.

| # | Item | Priority | Blueprint | Status | Key Infrastructure |
|---|------|----------|-----------|--------|--------------------|
| 6 | Workday HR Connector | P0 | _(use [connector template](../../../backend/src/modules/connectors/docs/CONNECTOR_TEMPLATE.md))_ | Planned (no Workday connector in `backend/src/modules/connectors/`; HR sources are CSV HR and JSON API HR) | None |
| 7 | SIEM Integration (webhooks) | P0 | [FUTURE_SIEM_INTEGRATION.md](../future/FUTURE_SIEM_INTEGRATION.md) | Partially Done (HMAC-signed outbound webhooks for domain events in `modules/event-subscriptions`; no SIEM-specific format or connector) | None |
| 8 | Graph Database (Access Explorer) | P1 | [FUTURE_GRAPH_DATABASE.md](../future/FUTURE_GRAPH_DATABASE.md) | Partially Done (4 Neo4j queries in `access-explorer.service.ts`; without Neo4j they answer 503, no MongoDB query path; the graph is filled by events and by `POST /access-explorer/resync` from MongoDB; Neo4j optional in Compose, profile `graph`) | Neo4j |
| 9 | Policy-as-Code (OPA/Rego) | P1 | [FUTURE_OPA_POLICY.md](../future/FUTURE_OPA_POLICY.md) | Partially Done (A-01, A-02: OPA client, Rego compiler and `OpaEvaluatorService` exist, but the policy engine does not call them) | OPA |
| 10 | Data Fabric (virtual attributes) | P1 | [FUTURE_DATA_FABRIC.md](../future/FUTURE_DATA_FABRIC.md) | Planned (no `modules/data-fabric/`) | Redis |
| 11 | AI Access Intelligence Phase 1 | P1 | [FUTURE_AI_ACCESS_INTELLIGENCE.md](../future/FUTURE_AI_ACCESS_INTELLIGENCE.md) | Complete | None |
| 12 | Google Workspace Connector | P1 | _(use connector template)_ | Planned (no Google Workspace connector; `google-sheets-connector` is an outbound sheet target) | None |
| 13 | Shared Signals (SSF/CAEP) | P1 | [FUTURE_SHARED_SIGNALS.md](../future/FUTURE_SHARED_SIGNALS.md) | Planned (no `modules/shared-signals/`) | None |
| 14 | Credential Lifecycle | P1 | [FUTURE_CREDENTIAL_LIFECYCLE.md](../future/FUTURE_CREDENTIAL_LIFECYCLE.md) | Partially Done (credential inventory, policies and the rotation workflow; no Vault integration, `vaultStorage` is a policy flag only) | Vault |
| 15 | AWS IAM Connector (CIEM Phase 1) | P1 | [FUTURE_CIEM.md](../future/FUTURE_CIEM.md) | Planned (A-06 to A-08: no AWS IAM connector or `modules/ciem/`) | None |

### Prerequisites Already Complete

SoD validation (BLOCK/WARN), policy staging, bulkhead task queues, circuit breakers, Redis cache, risk scoring, orphan detection, recertification.

---

## Wave 3: Scale & Isolation

Focus: Enterprise-grade multi-tenancy, auto-scaling, security isolation.

| # | Item | Priority | Blueprint | Status | Key Infrastructure |
|---|------|----------|-----------|--------|--------------------|
| 16 | Cell-Based Architecture | P1 | [FUTURE_CELL_ARCHITECTURE.md](../future/FUTURE_CELL_ARCHITECTURE.md) | Planned (A-11: no `infrastructure/cell/` or `modules/cell-management/`) | Kubernetes |
| 17 | KEDA Dynamic Scaling | P1 | [FUTURE_KEDA_SCALING.md](../future/FUTURE_KEDA_SCALING.md) | Planned (A-12: one worker entry point `worker.ts`, no KEDA or Kubernetes manifests) | KEDA + K8s |
| 18 | Connector Sandbox | P2 | [FUTURE_CONNECTOR_SANDBOX.md](../future/FUTURE_CONNECTOR_SANDBOX.md) | Planned (no `infrastructure/sandbox/`; connectors run in-process) | None |
| 19 | Generic REST Outbound Connector | P2 | _(use connector template)_ | Planned (no generic REST connector in `register-connectors.ts`) | None |

---

## Wave 4: Hybrid Cloud & Advanced

Focus: On-premise connectivity, advanced governance, additional connectors.

| # | Item | Priority | Blueprint | Status | Key Infrastructure |
|---|------|----------|-----------|--------|--------------------|
| 20 | Remote Agent Topology | P1 | [FUTURE_REMOTE_AGENT.md](../future/FUTURE_REMOTE_AGENT.md) | Partially Done (A-13, A-14: control plane `modules/agent-management/` only; no agent binary) | gRPC / Temporal Cloud |
| 21 | Session-Based JIT Access | P2 | [FUTURE_SESSION_JIT_ACCESS.md](../future/FUTURE_SESSION_JIT_ACCESS.md) | Planned (A-03 to A-05: no `jit-session.*` in `modules/privileged-access/`) | Vault |
| 22 | CIEM Full (Phases 2-6) | P2 | [FUTURE_CIEM.md](../future/FUTURE_CIEM.md) | Planned (no `modules/ciem/`) | Neo4j |
| 23 | Identity Verification | P2 | [FUTURE_IDENTITY_VERIFICATION.md](../future/FUTURE_IDENTITY_VERIFICATION.md) | Planned (A-09, A-10: no `modules/identity-verification/`) | None |
| 24 | Access Graph Visualization | P2 | [FUTURE_IDENTITY_ENTITLEMENT_MAP.md](../future/FUTURE_IDENTITY_ENTITLEMENT_MAP.md) | Complete (Neo4j infra + Access Explorer + graph sync + frontend) | Neo4j (from #8) |
| 25 | Okta Native Connector | P2 | _(use connector template)_ | Complete (native API: users, groups, apps, MFA, credentials) | None |
| 26 | ServiceNow Connector | P2 | _(use connector template)_ | Complete (ticket integration: incidents, users, change requests) | None |
| 27 | Slack Connector | P2 | _(use connector template)_ | Planned (no Slack connector in `register-connectors.ts`) | None |

---

## Wave 5: Audit Remediation (Production Hardening)

Focus: Close gaps identified in acquisition audit (Feb 2026). Cross-referenced against `AUDIT_ACTIONS.md` (40 capabilities, 20 actions) and `ACQUISITION_AUDIT_REPORT.md` (12 areas, 10 risks). **9 of ~30 flagged gaps were already resolved** before this wave began (`enableShutdownHooks()`, once counted here, is item 46).

| # | Item | Priority | Task | Status | Notes |
|---|------|----------|------|--------|-------|
| 28 | E2E tests (10 critical paths) | P0 | [CURRENT_TASK_237](../../../docs/tasks/archive/CURRENT_TASK_237.md) | Complete | 20 E2E tests, NestFactory.create bootstrap |
| 29 | Prometheus alert rule files | P0 | [CURRENT_TASK_237](../../../docs/tasks/archive/CURRENT_TASK_237.md) | Planned | No alert rule file or PrometheusRule manifest in the repository; thresholds are described in `docs/operations/ALERTING_THRESHOLDS.md` |
| 30 | Docker-compose credential hygiene | P0 | [CURRENT_TASK_237](../../../docs/tasks/archive/CURRENT_TASK_237.md) | Complete | All defaults removed, .env.example added |
| 31 | Credential rotation determinism fix | P0 | [CURRENT_TASK_237](../../../docs/tasks/archive/CURRENT_TASK_237.md) | Complete | workflowInfo().startTime |
| 32 | Socket.IO Redis adapter | P1 | [CURRENT_TASK_238](../../../docs/tasks/archive/CURRENT_TASK_238.md) | Planned | `main.ts` uses the in-memory `IoAdapter`; `@socket.io/redis-adapter` is a dependency but unused, there is no `RedisIoAdapter` |
| 33 | Comprehensive health checks | P1 | [CURRENT_TASK_238](../../../docs/tasks/archive/CURRENT_TASK_238.md) | Partially Done | `GET /health/ready` reports MongoDB (503 without it), the connectors' sync freshness, the shared security state store (Redis) and the access graph (Neo4j); it checks neither Temporal nor Elasticsearch (`backend/src/infrastructure/health/health.controller.ts`) |
| 34 | Per-tenant rate limiting | P1 | [CURRENT_TASK_238](../../../docs/tasks/archive/CURRENT_TASK_238.md) | Planned | The global `ThrottlerGuard` (`app.module.ts`, shared store `shared-throttler.storage.ts`) limits per client, not per tenant; there is no `TenantThrottlerGuard` |
| 35 | SSF `.well-known` prefix fix | P1 | [CURRENT_TASK_238](../../../docs/tasks/archive/CURRENT_TASK_238.md) | Planned | Nothing to fix yet: no SSF endpoint exists (no `backend/src/modules/shared-signals/`; design in `docs/architecture/future/FUTURE_SHARED_SIGNALS.md`), and the global prefix excludes only `scim/v2/(.*)` (`backend/src/infrastructure/config/global-prefix.ts`) |
| 36 | Pact contract tests | P1 | [CURRENT_TASK_239](../../../docs/tasks/archive/CURRENT_TASK_239.md) | Planned | No Pact dependency or contract; `modules/connectors/connector.contract.spec.ts` is a plain Jest spec |
| 37 | Field-level PII encryption | P1 | [CURRENT_TASK_239](../../../docs/tasks/archive/CURRENT_TASK_239.md) | Planned | No PII encryption plugin: PII fields are stored in plaintext; `EncryptionService` encrypts connector config and MFA secrets only |
| 38 | CI/CD staging auto-deploy | P1 | [CURRENT_TASK_239](../../../docs/tasks/archive/CURRENT_TASK_239.md) | Planned | There is no CI (`.github/` has no workflows) and no deploy step; the `.husky/` git hooks are the only gates |
| 39 | License cost integration | P2 | [CURRENT_TASK_241](../../../docs/tasks/archive/CURRENT_TASK_241.md) | Complete | Configurable per-SKU pricing, cost summary + optimization + forecast |
| 40 | Shared writeback mapper utility | P2 | [CURRENT_TASK_241](../../../docs/tasks/archive/CURRENT_TASK_241.md) | Complete | WritebackFieldConfig pattern, AD + Entra refactored |
| 41 | Frontend test coverage 60%+ | P2 | [CURRENT_TASK_241](../../../docs/tasks/archive/CURRENT_TASK_241.md) | Complete | Measured 2026-11-25: statements 79%, branches 66%, functions 76%, lines 81%. Floors in `frontend/vitest.config.ts`: statements 77, branches 64, functions 73, lines 79. Enforced only by `npm run test:coverage`: there is no CI, and the pre-push hook runs no frontend tests |
| 42 | PAM session recording | P2 | [CURRENT_TASK_240](../../../docs/tasks/archive/CURRENT_TASK_240.md) | Planned | No session recording exists, and no design file of its own: a future extension in `docs/architecture/future/FUTURE_SESSION_JIT_ACCESS.md`. What exists: time-bound privileged sessions of linked admin accounts (`privilegedSessionWorkflow`), whose activation and end are audited (`admin_account.activated`, `admin_account.deactivated`) |
| 43 | Role mining / role discovery | Not set | None | Planned | Audit flagged it "Missing" and it still is: no `role-mining.service.ts` and no role mining code in `backend/src` |
| 44 | Feature flags (A-15) | Not set | None | Planned | Audit flagged it "Missing" and it still is: no `backend/src/infrastructure/feature-flags/` and no feature flag code in `backend/src` |
| 45 | Kubernetes manifests | Not set | None | Planned | Audit flagged "P0 Empty dirs" and there are still none: no Kubernetes, Kustomize or KEDA manifests in the repository (no `infra/` or `k8s/` directory) |
| 46 | Graceful shutdown (`enableShutdownHooks()`) | Not set | None | Planned | Audit flagged it "Missing" and it still is: `backend/src/main.ts` does not call `enableShutdownHooks()` |

### Audit Items Already Resolved (no further action needed)

| Item | Original Status | Resolution |
|------|----------------|------------|
| Temporal determinism (onboarding + JIT) | "CRITICAL" | Fixed — `workflowInfo().startTime` and `condition()` timeout |
| SCIM token scope enforcement | "HIGH" | Implemented — `@RequireScopes()` decorator + guard validation |
| Schema migration framework | "P0 Missing" | Implemented: `migrate-mongo` with 11 migration files in `backend/migrations/` |
| Temporal client TLS | "HIGH Missing" | Implemented — mTLS via env vars (opt-in) |
| Mover workflow | "Missing" | Implemented — full delta computation with bulkhead routing |
| SCIM outbound connector | "Not implemented" | Implemented — complete connector module |
| DLQ auto-retry | "Requires manual intervention" | Implemented — exponential backoff poller + batch retry API |
| Outbound webhooks | "Not implemented" | Implemented: `event-subscriptions` module, HMAC-signed webhooks (no SIEM format, no OCSF) |
| DR runbook | "No tested procedure" | Exists — `DISASTER_RECOVERY.md` + `RUNBOOK.md` |

---

## Connector Summary

| Connector | Status | Priority | Notes |
|-----------|--------|----------|-------|
| Microsoft Entra ID | Production | — | Full lifecycle |
| Active Directory | Production | — | LDAP/LDAPS |
| SCIM 2.0 (in + out) | Production | — | Generic SaaS |
| CSV HR | Production | — | File-based HR |
| JSON API HR | Production | — | REST-based HR |
| Workday | Planned | P0 | Wave 2 item 6: no connector yet |
| Google Workspace | Planned | P1 | Wave 2 item 12: no connector yet |
| AWS IAM | Planned | P1 | Wave 2 item 15 (CIEM Phase 1): no connector yet |
| Generic REST | Planned | P2 | Wave 3 item 19: no connector yet |
| Okta | Production | P2 | Native API (users, groups, apps, MFA, credentials) |
| ServiceNow | Production | P2 | Ticket integration (incidents, users, change requests) |
| Slack | Planned | P2 | Wave 4 item 27: no connector yet |

---

## Dependency Graph

```
Event Sourcing (1) ──> CQRS (2) ──> Cell Architecture (16)
                   ──> Immutable Audit (3, Phases 2-5)
                   ──> Graph DB (8) ──> OPA Policy (9)
                                    ──> Data Fabric (10)
                                    ──> Access Graph Viz (24)

KEDA (17) ──> (independent, infra-only)
Connector Sandbox (18) ──> Remote Agent (20)
Credential Lifecycle (14) ──> Session JIT (21)
SIEM Integration (7) ──> Shared Signals (13)
AWS IAM Connector (15) ──> CIEM Full (22)
Workday (6), Google (12) ──> independent
SOC 2 (4), NIST (5) ──> independent (documentation only)

Wave 5 (Audit Remediation):
  [TASK_237] P0 (E2E, alerts, docker, determinism) ──> parallel, no deps
  [TASK_238] P1 (Socket.IO, health, rate limit, SSF) ──> parallel, no deps
  [TASK_239] P1 (Pact, PII encrypt, CI/CD) ──> depends on TASK_237 (E2E for staging gate)
  [TASK_240] P2 (SOC 2, NIST, Graph, PAM) ──> Graph needs Neo4j (#8)
  [TASK_241] P2 (License costs, mappers, frontend) ──> parallel, no deps
```

---

## Infrastructure Requirements

| Component | Used By | Wave | Status |
|-----------|---------|------|--------|
| Redis | Data Fabric, caching, rate limiting | 2 | Available (optional) |
| ElasticSearch | CQRS read model | 1 | Optional (not in Compose; the API runs fail-open without it, `ELASTICSEARCH_NODE`) |
| Neo4j | Graph DB, Access Explorer | 2 | Optional (Compose profile `graph`) |
| OPA | Policy-as-Code | 2 | Not provisioned |
| S3 + Object Lock | WORM audit storage | 1 | Not provisioned |
| Kubernetes | KEDA, cells | 3 | Not provisioned |
| KEDA | Dynamic scaling | 3 | Not provisioned |
| gRPC / Temporal Cloud | Remote agent | 4 | Not provisioned |
| HashiCorp Vault | Credential lifecycle, JIT | 2-4 | Not provisioned |

---

## Cross-Cutting Constraints

Every new feature must account for:

- **GDPR:** Erasure cascades, DSAR export, consent. See [GDPR Compliance](../../../backend/src/modules/compliance-reporting/docs/GDPR_COMPLIANCE.md).
- **Multi-tenancy:** Tenant-scoped data, JWT claims, Temporal workflow prefixes. See [Multi-Tenancy](../infrastructure/ARCHITECTURE_MULTI_TENANCY.md).
- **Observability:** Correlation IDs, structured logging, Prometheus metrics. See [Observability](../infrastructure/OBSERVABILITY_ARCHITECTURE.md).
- **Security:** CodeGuard rules, SSRF guards, PII redaction. See [Security Rules](../../../skills/software-security/SKILL.md).

---

## Related Documents

| Document | Purpose |
|----------|---------|
| [Future Designs Index](../future/README.md) | All architecture blueprints with status |
| [ADR Log](../../adr/DECISIONS_LOG.md) | Architecture decision records |
| [API Changelog](../API_CHANGELOG.md) | Shipped feature history |
| [Diagrams Index](../DIAGRAMS_INDEX.md) | All architecture diagrams |
| [CURRENT_TASK_237](../../tasks/archive/CURRENT_TASK_237.md) | P0 — E2E tests, alerting, docker creds, determinism fix |
| [CURRENT_TASK_238](../../tasks/archive/CURRENT_TASK_238.md) | P1 — Socket.IO, health checks, rate limiting, SSF prefix |
| [CURRENT_TASK_239](../../tasks/archive/CURRENT_TASK_239.md) | P1 — Pact tests, PII encryption, CI/CD staging |
| [CURRENT_TASK_240](../../tasks/archive/CURRENT_TASK_240.md) | P2 — SOC 2, NIST, graph DB, PAM sessions |
| [CURRENT_TASK_241](../../tasks/archive/CURRENT_TASK_241.md) | P2 — License costs, shared mappers, frontend coverage |
| [Audit Actions (archived)](../../oldtasks/AUDIT_ACTIONS.md) | Original capabilities audit (Feb 22, 2026) |
| [Acquisition Audit (archived)](../../oldtasks/ACQUISITION_AUDIT_REPORT.md) | Due diligence report (Feb 24, 2026) |
