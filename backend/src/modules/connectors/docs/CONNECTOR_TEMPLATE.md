# {Connector Name} Connector — Architecture

> **Module:** Connectors / {connector-name} (Pillar 3 — Hands)
> **Cross-cutting:** [Connectors Architecture](ARCHITECTURE.md) | [Data Flows](../../../../../docs/architecture/core/DATAFLOWS.md) | [Temporal Workflows](../../../../../docs/architecture/infrastructure/TEMPORAL_WORKFLOWS.md)

> **Template:** Copy this file when creating documentation for a new connector.
> Rename to `docs/ARCHITECTURE.md` or `docs/{CONNECTOR_NAME}_DEEP_DIVE.md` inside
> the connector directory. Delete this preamble after copying.

---

## Overview

- **Connector ID:** `{connector-id}` (as registered in `register-connectors.ts`)
- **Type:** Source (HR) | Target | Bidirectional
- **Protocol:** REST / SCIM / LDAP / GraphQL / File-based
- **Authentication:** OAuth 2.0 / Bearer / Basic / mTLS / API Key
- **Task Queue:** `provisioning-{connector-id}` if the manifest sets `taskQueue` (optional; Entra ID, AD, SCIM and Okta do), else the default queue `provisioning-default`

## Capabilities

| Capability | Supported | Notes |
|-----------|-----------|-------|
| `discover` | Yes/No | Entitlement catalog discovery |
| `provision` | Yes/No | Create/update accounts |
| `deprovision` | Yes/No | Disable/delete accounts |
| `healthCheck` | Yes/No | Connectivity test |
| `reconciliation` | Yes/No | Takes part in drift detection |
| `ingest` | Yes/No | HR data ingest (source connectors) |
| `hrWriteback` | Yes/No | Write-back target-generated attributes to HR |
| `credentialManagement` | Yes/No | Reads credential state (password age, MFA); resets no password |

## Critical Landmines

### Landmine 1: {Name}

**The Trap:** {What goes wrong}

**The Fix:** {How this connector handles it}

## Configuration

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `{field}` | string | Yes | {description} |

## Field Mapping

| Hub Field (StandardUserDto) | {System} Field | Direction | Notes |
|----------------------------|----------------|-----------|-------|
| `profile.email` | `{system_field}` | Hub ← System | |
| `profile.firstName` | `{system_field}` | Hub → System | |

## API Integration

### Rate Limits

| Endpoint | Limit | Strategy |
|----------|-------|----------|
| {API endpoint} | {N}/min | {backoff strategy} |

### Error Handling

| HTTP Status | Meaning | Connector Behavior |
|-------------|---------|-------------------|
| 409 | Already exists | Return existing resource (idempotent) |
| 429 | Rate limited | Exponential backoff via retry policy |
| 5xx | Server error | Retry per `CONNECTOR_RETRY` policy |

## 5-File Pattern

| File | Purpose |
|------|---------|
| `{connector}.module.ts` | NestJS module registration |
| `{connector}.interface.ts` | `IConnector` implementation |
| `{connector}.service.ts` | Business logic (discovery, provisioning) |
| `{connector}.client.ts` | HTTP/LDAP client (raw API calls) |
| `{connector}.mapper.ts` | Field mapping (Hub ↔ System) |

## Related Documents

| Document | Relevance |
|----------|-----------|
| [Connectors Architecture](ARCHITECTURE.md) | General connector patterns, dumb-pipe principle |
| [Data Flows](../../../../../docs/architecture/core/DATAFLOWS.md) | System-wide flow context |
