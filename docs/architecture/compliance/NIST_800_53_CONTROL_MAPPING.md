# NIST 800-53 Rev. 5 — Security Control Mapping

> **Status:** Audited against the code on 2026-11-22 (first written for CURRENT_TASK_240)
> **Last Updated:** 2026-11-22
> **Cross-references:** [SOC 2 Mapping](SOC2_TYPE_II_CONTROL_MAPPING.md) | [GDPR Compliance](../../../backend/src/modules/compliance-reporting/docs/GDPR_COMPLIANCE.md) | [Platform Auth](../security/PLATFORM_AUTH_ARCHITECTURE.md)

---

## Overview

This document maps EuroID's controls to NIST SP 800-53 Rev. 5 security control families. Each row cites the code that implements it. Status is one of:

- **Implemented**: the cited code implements the control as described.
- **Partial**: some of it exists; the reason says what is missing.
- **Planned**: no code implements it yet; the reason says what exists instead, if anything.

---

## AC — Access Control

| Control | Title | Implementation Evidence | Status |
|---------|-------|------------------------|--------|
| AC-2 | Account Management | Identity lifecycle workflows (onboarding, mover, offboarding): `backend/src/workflows/` | Implemented |
| AC-2(4) | Automated Audit Actions | Lifecycle services emit domain events that `backend/src/infrastructure/events/handlers/audit-event.handler.ts` writes through `backend/src/modules/audit/audit.service.ts` | Partial: each service must emit its own event; coverage of every account lifecycle change is not verified |
| AC-3 | Access Enforcement | ABAC policy engine with condition groups: `backend/src/modules/policy/policy-engine.service.ts` | Implemented |
| AC-4 | Information Flow Enforcement | Golden Record saved before target writes (`saveToHub` in `backend/src/workflows/onboarding.workflow.ts` and `backend/src/workflows/bulk-provisioning.workflow.ts`); connectors in `backend/src/modules/connectors/` | Partial: the Hub-first order is in the workflows; "connectors are dumb pipes" is a design rule not verified per connector |
| AC-5 | Separation of Duties | SoD engine with conflict detection: `backend/src/modules/policy/sod.service.ts` | Implemented |
| AC-6 | Least Privilege | RBAC with 5 roles (super-admin, policy-admin, connector-admin, operator, viewer): `backend/src/infrastructure/auth/roles.guard.ts` | Implemented |
| AC-6(1) | Authorize Access to Security Functions | GDPR erasure requires `super-admin`: `backend/src/modules/compliance-reporting/gdpr-compliance.controller.ts` | Partial: config changes do not require `super-admin`; connector config endpoints accept `connector-admin` (`backend/src/modules/connectors/connector-config.controller.ts`) |
| AC-6(5) | Privileged Accounts | Time-bounded linked admin accounts: `backend/src/modules/privileged-access/privileged-access.service.ts` | Partial: admin accounts expire, but there are no JIT sessions |
| AC-6(9) | Log Use of Privileged Functions | Privileged access events from `backend/src/modules/privileged-access/privileged-access.service.ts`; emergency access audited in `backend/src/infrastructure/auth/jwt-auth.guard.ts` | Partial: not every privileged-access lifecycle step emits an audited event |
| AC-6(10) | Prohibit Non-Privileged Users from Executing Privileged Functions | `@Roles(...)` enforced by `backend/src/infrastructure/auth/roles.guard.ts` | Partial: enforced where `@Roles` is declared; not verified for every admin endpoint |
| AC-7 | Unsuccessful Logon Attempts | `@Throttle` on login endpoints in `backend/src/modules/auth/auth-local.controller.ts`; 15-minute MFA lockout after failed codes in `backend/src/modules/auth/mfa.service.ts` | Partial: login throttling is per client and there is no per-account password lockout |
| AC-10 | Concurrent Session Control | None | Planned: there is no JIT session model or single-active-session index |
| AC-11 | Session Lock | Admin account expiry (`linkedAdminAccounts[].expiresAt`, `deactivateExpiredSessions`): `backend/src/modules/privileged-access/privileged-access.service.ts` | Partial: privileged accounts expire, but there is no session lock or `maxDurationMinutes` |
| AC-12 | Session Termination | Admin deactivation `PUT admin-accounts/:adminId/deactivate`: `backend/src/modules/privileged-access/privileged-access.controller.ts` | Partial: an admin can deactivate an account; there is no heartbeat-miss termination |
| AC-16 | Security & Privacy Attributes | Identity onion model with attribute ownership: `backend/src/modules/identity/docs/HUB_AND_SPOKE.md`, `backend/src/modules/identity/identity-onion.service.ts` | Implemented |
| AC-17 | Remote Access | None | Planned: there is no connector sandbox (`sandbox-worker.ts` does not exist) |

## AU — Audit & Accountability

| Control | Title | Implementation Evidence | Status |
|---------|-------|------------------------|--------|
| AU-2 | Event Logging | Audit service with event types: `backend/src/modules/audit/audit.service.ts`, `backend/src/infrastructure/events/event-types.ts` | Implemented |
| AU-3 | Content of Audit Records | Action, actor, resource, timestamp and tenantId: `backend/src/modules/audit/schemas/audit-event.schema.ts` | Partial: audit records have no correlationId field |
| AU-3(1) | Additional Audit Information | Correlation ID propagation: `backend/src/infrastructure/middleware/correlation.middleware.ts` | Partial: correlation IDs reach requests and logs but are not stored in audit records |
| AU-6 | Audit Record Review, Analysis & Reporting | Audit query API with filters: `GET /api/v1/audit` in `backend/src/modules/audit/audit.controller.ts` | Implemented |
| AU-8 | Time Stamps | `timestamps: true` on every top-level Mongoose schema; MongoDB stores dates in UTC | Implemented |
| AU-9 | Protection of Audit Information | SHA-256 hash chain integrity: `integrityHash`, `previousHash` in `backend/src/modules/audit/audit.service.ts` | Implemented |
| AU-9(2) | Store on Separate System | Dedicated `audit_events` collection; S3 Object Lock export: `backend/src/modules/audit/audit-archive.service.ts`, `backend/src/workflows/audit-archive.workflow.ts` | Partial: the collection lives in the main MongoDB; the off-system export runs only with `AUDIT_ARCHIVE_ENABLED=true` |
| AU-10 | Non-Repudiation | Hash chain with `verify-integrity` endpoint: `GET /api/v1/audit/verify-integrity`, `backend/src/modules/audit/audit-merkle.service.ts` | Implemented |
| AU-11 | Audit Record Retention | Data retention policies: `docs/architecture/security/DATA_RETENTION.md`, `backend/src/infrastructure/retention/` | Implemented |
| AU-12 | Audit Record Generation | Event-driven audit: `backend/src/infrastructure/events/handlers/audit-event.handler.ts` | Partial: there is no audit interceptor; a mutation is audited only if its service emits an event |

AU-9, AU-10 and SI-7: GDPR erasures run before commit `47fa1cd7` (2026-11-24) recorded no gap, so `verify-integrity` reports the chain there as `broken_link` (GDPR_COMPLIANCE.md, Known Limitations, item 4).

## IA — Identification & Authentication

| Control | Title | Implementation Evidence | Status |
|---------|-------|------------------------|--------|
| IA-2 | Identification & Authentication (Org Users) | JWT/OIDC authentication: `backend/src/infrastructure/auth/jwt-auth.guard.ts` | Implemented |
| IA-2(1) | Multi-Factor Authentication to Privileged Accounts | Built-in TOTP MFA (`backend/src/modules/auth/mfa.service.ts`), per-tenant `mfaRequired` enforced for SAML logins (`backend/src/modules/auth/saml-auth.service.ts`); OIDC logins use the IdP's MFA policy | Partial: MFA is a per-tenant setting, not required for privileged roles |
| IA-4 | Identifier Management | Unique identity IDs with tenantId scoping: `backend/src/modules/identity/schemas/identity.schema.ts` | Implemented |
| IA-5 | Authenticator Management | Credential lifecycle management: `backend/src/modules/credential-lifecycle/credential-policy.service.ts`, `backend/src/modules/credential-lifecycle/credential-inventory.service.ts` | Implemented |
| IA-5(1) | Password-Based Authentication | Credential generation service: `backend/src/infrastructure/secrets/credential-generation.service.ts` | Implemented |
| IA-8 | Identification & Authentication (Non-Org Users) | Tenant scoping: `backend/src/infrastructure/auth/tenant.guard.ts`, `backend/src/infrastructure/multi-tenancy/tenant.plugin.ts` | Partial: tenants are separated, but there is no distinct authentication path for non-organizational users |

## CM — Configuration Management

| Control | Title | Implementation Evidence | Status |
|---------|-------|------------------------|--------|
| CM-2 | Baseline Configuration | Docker multi-stage builds: `backend/Dockerfile`, `backend/Dockerfile.worker`, `frontend/Dockerfile` | Implemented |
| CM-3 | Configuration Change Control | Audit events on connector and policy config changes: `backend/src/modules/connectors/connector-config.service.ts`, `backend/src/modules/policy/policy.service.ts` | Implemented |
| CM-6 | Configuration Settings | Environment variable-based config, no hardcoded values: `backend/src/infrastructure/config/` | Implemented |
| CM-7 | Least Functionality | None | Planned: there is no feature flag system (`backend/src/infrastructure/feature-flags/` does not exist) |
| CM-8 | System Component Inventory | Per-tenant connector configs: `backend/src/modules/connectors/schemas/connector-config.schema.ts` | Partial: installed connectors are recorded, but configs are not versioned |
| CM-11 | User-Installed Software | None | Planned: there is no connector sandbox; connectors run in-process |

## IR — Incident Response

| Control | Title | Implementation Evidence | Status |
|---------|-------|------------------------|--------|
| IR-4 | Incident Handling | Anomaly detection with severity classification: `backend/src/modules/anomaly/anomaly.service.ts` | Implemented |
| IR-5 | Incident Monitoring | DLQ with retries: `backend/src/modules/dead-letter/dead-letter.service.ts` | Partial: no alerting on failed events was found in code |
| IR-6 | Incident Reporting | Webhook event subscriptions: `backend/src/modules/event-subscriptions/event-delivery.service.ts` | Partial: events can be pushed to a SIEM by webhook; there is no OCSF translation |
| IR-8 | Incident Response Plan | Audited break-glass access: `backend/src/infrastructure/auth/jwt-auth.guard.ts`; runbook `docs/operations/INCIDENT_RESPONSE.md` | Partial: break-glass is an emergency access path, not a response plan; the runbook is not checked against practice |

## RA — Risk Assessment

| Control | Title | Implementation Evidence | Status |
|---------|-------|------------------------|--------|
| RA-3 | Risk Assessment | 7-factor identity risk scoring: `backend/src/modules/risk-scoring/risk-scoring.service.ts`, `backend/src/infrastructure/config/risk-scoring.config.ts` | Implemented |
| RA-5 | Vulnerability Monitoring | None | Planned: no Trivy or other container scan runs (no CI: `.github/` has no workflows; the `.husky/` hooks scan no images) |
| RA-5(2) | Update Vulnerabilities | `.github/dependabot.yml` (weekly npm update pull requests for `backend/` and `frontend/`) | Partial: no `npm audit` runs (no CI, not in the `.husky/` hooks) |
| RA-7 | Risk Response | Dry-run impact analysis: `backend/src/modules/blueprints/impact-analysis.service.ts`, `POST /policy/simulate` | Partial: dry runs exist, but no code requires one before every destructive action |

## SC — System & Communications Protection

| Control | Title | Implementation Evidence | Status |
|---------|-------|------------------------|--------|
| SC-8 | Transmission Confidentiality & Integrity | Helmet with HSTS: `backend/src/main.ts` | Partial: TLS terminates outside the application; the app sends HSTS but does not enforce HTTPS itself |
| SC-12 | Cryptographic Key Establishment & Management | AES-256-GCM envelope encryption: `backend/src/infrastructure/secrets/encryption.service.ts`, `backend/src/infrastructure/secrets/aws-kms.provider.ts`, `backend/src/infrastructure/secrets/azure-keyvault.provider.ts` | Implemented |
| SC-13 | Cryptographic Protection | AES-256-GCM for connector config and MFA secrets: `backend/src/infrastructure/secrets/encryption.service.ts` | Partial: there is no field-level PII encryption (`pii-encryption.plugin.ts` does not exist) |
| SC-28 | Protection of Information at Rest | Encrypted connector and MFA secrets: `backend/src/modules/connectors/connector-config.service.ts`, `backend/src/modules/auth/mfa.service.ts` | Partial: PII fields (`personalEmail`, `mobilePhone`) are stored in plaintext |
| SC-28(1) | Cryptographic Protection (at rest) | AES-256-GCM with key derivation from passphrase: `backend/src/infrastructure/secrets/encryption.service.ts` | Implemented |

## SI — System & Information Integrity

| Control | Title | Implementation Evidence | Status |
|---------|-------|------------------------|--------|
| SI-2 | Flaw Remediation | Git hooks: `.husky/pre-commit` (ESLint, related Jest tests), `.husky/pre-push` (backend type check, tests, Temporal e2e); `.github/dependabot.yml` | Partial: no CI and no automated security scanning; the local hooks can be bypassed |
| SI-3 | Malicious Code Protection | None | Planned: no CodeQL or other SAST runs (no CI, not in the `.husky/` hooks) |
| SI-4 | System Monitoring | OpenTelemetry distributed tracing: `backend/src/infrastructure/observability/tracing.ts`, `backend/src/infrastructure/observability/observability.module.ts` | Implemented |
| SI-5 | Security Alerts, Advisories & Directives | None | Planned: there is no Shared Signals (SSF/CAEP) implementation (`backend/src/modules/shared-signals/` does not exist) |
| SI-6 | Security & Privacy Function Verification | Playwright specs: `frontend/e2e/` | Partial: no CI job runs the e2e specs and there are no Pact contract tests |
| SI-7 | Software, Firmware & Information Integrity | Audit hash chain integrity verification: `GET /audit/verify-integrity` | Implemented |
| SI-10 | Information Input Validation | Zod validation at the API boundary: global `ZodValidationPipe` in `backend/src/main.ts`; endpoints with `unknown` bodies parse them with Zod schemas | Implemented |

## PM — Program Management

| Control | Title | Implementation Evidence | Status |
|---------|-------|------------------------|--------|
| PM-5 | System Inventory | Entitlement catalog with orphan detection: `backend/src/modules/entitlement-catalog/schemas/entitlement-catalog.schema.ts`, `analyzeOrphanEntitlements()` in `backend/src/modules/policy-suggestions/policy-suggestions.service.ts` | Implemented |
| PM-14 | Testing, Training & Monitoring | Backend Jest tests and the Temporal workflow e2e suite run in the `.husky/pre-push` hook; Playwright specs in `frontend/e2e/` | Partial: there is no CI; no hook runs the Playwright specs and there are no Pact contract tests |

---

## Summary

| Family | Controls Mapped | Implemented | Partial | Planned |
|--------|----------------|-------------|---------|---------|
| AC — Access Control | 16 | 5 | 9 | 2 |
| AU — Audit & Accountability | 10 | 6 | 4 | 0 |
| IA — Identification & Authentication | 6 | 4 | 2 | 0 |
| CM — Configuration Management | 6 | 3 | 1 | 2 |
| IR — Incident Response | 4 | 1 | 3 | 0 |
| RA — Risk Assessment | 4 | 1 | 2 | 1 |
| SC — System & Comms Protection | 5 | 2 | 3 | 0 |
| SI — System & Information Integrity | 7 | 3 | 2 | 2 |
| PM — Program Management | 2 | 1 | 1 | 0 |
| **Total** | **60** | **26** | **27** | **7** |
