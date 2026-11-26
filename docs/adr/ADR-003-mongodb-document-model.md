# ADR-003: MongoDB Document Model

**Status:** Accepted
**Date:** 2026-02-23
**Author:** EuroID Team

## Context

EuroID manages hierarchical identity data: each identity contains linked accounts from multiple HR/target systems, per-system provisioning states, entitlement assignments, and flexible custom attributes. The data model must support:

- **Multi-tenant isolation:** Each tenant's data must be scoped and inaccessible to other tenants.
- **Schema flexibility:** Different organizations have different custom fields; the schema must accommodate this without migrations.
- **Hierarchical embedding:** An identity's linked accounts and provisioning states are tightly coupled and always accessed together.
- **Optimistic concurrency:** Concurrent updates to the same identity (e.g., two HR syncs) must be detected and resolved.

## Decision

Use **MongoDB** with **Mongoose ODM** as the primary database. Key design choices:

1. **Document-per-identity:** Each identity is a single document containing all layers (see ADR-001). Linked accounts, provisioning states, and controls are embedded subdocuments, not separate collections.
2. **Tenant scoping via plugin:** A `TenantPlugin` using Node.js `AsyncLocalStorage` automatically injects `tenantId` into all Mongoose queries. Tenants share a single database with logical scoping.
3. **Optimistic concurrency:** Mongoose's `optimisticConcurrency: true` on the Identity schema uses `__v` (version) field to detect concurrent modifications.
4. **Flexible schema extension:** `profile.customAttributes` is a `Record<string, unknown>` for organization-specific fields. Core fields are strongly typed; custom fields are schemaless.
5. **Soft delete:** `deletedAt` field for identity deletion. No middleware filters deleted documents: queries exclude them explicitly with `NOT_DELETED` (`{ deletedAt: null }`, `backend/src/modules/identity/identity.constants.ts`).
6. **Cell-based physical isolation:** Premium tenants can be assigned to dedicated MongoDB instances (cells) for physical data separation (see ADR-007, accepted, not implemented).

## Consequences

### Positive
- Natural fit for the Onion Model: embedded subdocuments map directly to identity layers
- No JOIN overhead: all identity data is in a single document read
- Schema evolution without migrations: new fields can be added to custom attributes or subdocuments
- Tenant scoping is transparent to application code via the plugin
- Rich indexing: compound indexes on `tenantId` + business fields for efficient queries

### Negative
- No referential integrity constraints: application code must enforce cross-collection consistency
- 16MB document size limit: identities with many linked accounts must be monitored
- No native transactions across collections (mitigated by single-document atomicity for most operations)
- Optimistic concurrency adds retry logic for concurrent writes

### Risks
- Connection pool exhaustion under high concurrency (mitigated by monitoring and configurable pool size)
- Query performance degradation if indexes are not maintained as query patterns evolve

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| PostgreSQL with JSONB | Referential integrity, mature tooling, JSONB for flexible fields | Schema migrations required for structural changes, ORM mapping overhead for deeply nested structures, less natural fit for document-oriented data |
| DynamoDB | Managed, auto-scaling, single-digit-ms latency | Vendor lock-in (AWS), limited query patterns without GSIs, no local development parity, partition key design complexity |
| CockroachDB | Distributed SQL, strong consistency, PostgreSQL-compatible | Operational complexity of distributed consensus, higher latency for writes, less mature ecosystem than PostgreSQL/MongoDB |
