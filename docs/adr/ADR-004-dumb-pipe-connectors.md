# ADR-004: Dumb Pipe Connectors

**Status:** Accepted
**Date:** 2026-02-23
**Author:** EuroID Team

## Context

IGA platforms typically require connectors to integrate with dozens of target systems (Entra ID, Active Directory, Slack, Google Workspace, etc.). A recurring pattern in IGA products is that connectors gradually accumulate business logic — access policies, group membership rules, license assignment decisions — making them increasingly complex, inconsistent, and difficult to maintain.

When business logic lives in connectors:
- Each connector reimplements rules differently, leading to inconsistent behavior.
- Testing requires mocking the target system AND the embedded business logic.
- Policy changes require modifying every affected connector.
- New connectors must duplicate existing business logic from other connectors.

## Decision

Enforce a strict **"dumb pipe"** architecture for all connectors. Connectors handle only:

| Responsibility | Example |
|----------------|---------|
| Field translation | `StandardUserDto.firstName` → Entra `givenName` |
| Protocol execution | LDAP `addUser()`, Microsoft Graph API `POST /users` |
| Idempotency | Catch `409 Conflict` / LDAP error 68, return existing resource |
| Raw discovery | Fetch groups/licenses from target, return raw metadata |
| Health checks | LDAP bind/unbind, token validation |
| Status mapping | `status: ACTIVE` → `accountEnabled: true` (pure, deterministic) |

All business logic — who gets provisioned, what groups they join, what licenses they receive — is the exclusive responsibility of the **Policy Engine** (`modules/policy`).

The connector interface is defined by `ConnectorManifest` (`backend/src/modules/connectors/plugin/connector-manifest.interface.ts`), which declares:
- Capabilities (`discover`, `provision`, `deprovision`, `healthCheck`, `reconciliation`, `ingest`, `hrWriteback`, `credentialManagement`)
- Connection configuration fields (`configSchema: ConfigField[]`, which drives the install form; plain field definitions, not a Zod schema)
- An optional Temporal task queue (`taskQueue`), the NestJS module, service and activity classes, and `activityBindings`

The manifest declares no field mappings.

## Consequences

### Positive
- Connectors are simple, testable, and consistent: each one is essentially a protocol adapter
- Policy changes are centralized: modify one place (Policy Engine), all connectors respect the change
- New connectors are fast to build: copy the template, implement field mapping and protocol calls
- Clear separation of concerns enables independent connector and policy development

### Negative
- Requires a robust Policy Engine: all decision-making is concentrated in one module
- Field mapping contracts must be well-defined: connectors and the Policy Engine must agree on `StandardUserDto` structure
- Some "simple" operations (e.g., "disable user in AD") still require a round-trip through the Policy Engine

### Risks
- Policy Engine becomes a bottleneck if not properly optimized for throughput
- Developers may be tempted to add "just a small rule" to a connector for convenience — requires code review discipline

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| Smart connectors with embedded rules | Self-contained, no dependency on central policy engine | Rules duplicated across connectors, inconsistent behavior, testing complexity, policy changes require modifying each connector |
| Connector-local policy evaluation | Connectors evaluate policies locally using a shared rule engine | Distribution of policy state, cache invalidation complexity, still duplicates evaluation logic |
| Hybrid (connector hints + central policy) | Connectors provide capability hints, policy engine makes final decisions | Blurred boundary, "hints" tend to evolve into full rules over time |
