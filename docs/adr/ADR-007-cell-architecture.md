# ADR-007: Cell-Based Architecture for Tenant Isolation

**Status:** Accepted, not implemented (the code has no `CellRegistryService`, `CellRoutingMiddleware`, `CellMongooseProvider` or `cells` collection)
**Date:** 2026-02-23
**Author:** EuroID Team

## Context

EuroID serves multiple tenants on a shared infrastructure. While logical tenant isolation (query-level scoping via `TenantPlugin`) is sufficient for most customers, enterprise tenants require stronger guarantees:

- **Compliance:** Regulations (GDPR, industry-specific mandates) may require physical data separation — not just logical scoping within a shared database.
- **Performance isolation:** A large tenant's bulk operations (e.g., 50,000-user reconciliation) should not degrade performance for other tenants.
- **Blast radius:** A database failure affecting one tenant should not cascade to all tenants.
- **Data residency:** Some tenants require data to be stored in specific geographic regions.

## Decision

Implement a **cell-based architecture** where each cell is an independently deployable isolation boundary containing its own infrastructure components:

### Cell Composition

| Component | Per-Cell | Purpose |
|-----------|----------|---------|
| MongoDB instance | Yes | Physical data isolation |
| Temporal namespace | Yes | Workflow isolation |
| Elasticsearch instance | Optional | Search/analytics isolation |
| Redis instance | Optional | Cache isolation |

### Routing Architecture

1. **`CellRegistryService`:** Resolves which cell a tenant belongs to. Maintains an in-memory cache with configurable TTL to avoid database lookups on every request.
2. **`CellRoutingMiddleware`:** Runs after authentication middleware. Resolves cell from `CellRegistryService` using `req.user.tenantId`. Stores cell context in `AsyncLocalStorage<CellContext>` for downstream access.
3. **`CellMongooseProvider`:** Provides cell-specific MongoDB connections based on the current `CellContext`.
4. **Default cell:** All tenants default to the `'shared'` cell. Cell routing is effectively a no-op for shared-cell tenants, maintaining full backward compatibility.

### Cell Lifecycle

| Status | Meaning |
|--------|---------|
| `PROVISIONING` | Cell infrastructure being created |
| `ACTIVE` | Cell is serving traffic |
| `DRAINING` | Tenants being migrated out |
| `DECOMMISSIONED` | Cell infrastructure torn down |

### Cell Definition Sources

- **Static:** Loaded at deploy time from a JSON configuration file (`loadStaticCells()`)
- **Dynamic:** Stored in the `cells` MongoDB collection, managed via `CellManagementService` API

The `cells` collection has `skipTenantPlugin: true` since it is a control-plane resource, not tenant-scoped.

## Consequences

### Positive
- Physical data isolation for compliance-sensitive tenants
- Performance isolation: one tenant's heavy workload stays within their cell
- Independent scaling: cells can be sized according to tenant needs
- Blast radius containment: cell-level failures don't cascade
- Backward compatible: shared cell is the default, no changes needed for existing tenants

### Negative
- Operational complexity: multi-cell deployments require monitoring, alerting, and management tooling per cell
- Connection management: the application maintains connection pools to multiple MongoDB/Temporal instances
- Cell provisioning is a complex workflow (creating infrastructure, configuring connections, migrating tenant data)

### Risks
- Cell routing failure: if `CellRegistryService` returns an incorrect cell, tenant data could be written to the wrong cell (mitigated by validation and fallback to shared cell)
- Connection string management: cell MongoDB URIs are encrypted via `EncryptionService`, but rotation/leak requires per-cell remediation
- Tenant migration between cells is a multi-step operation that must handle in-flight workflows and ensure zero data loss

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| Schema-per-tenant (single DB) | Simpler than cells, logical isolation within one database | No performance isolation, shared DB failure affects all tenants, no data residency support |
| Database-per-tenant (no cell abstraction) | Physical data isolation | Only isolates the database — Temporal, Elasticsearch, Redis still shared; no unified management abstraction |
| Cloud-native multi-tenancy (e.g., AWS Organizations) | Managed isolation, native compliance features | Vendor lock-in, complex IAM configuration, not portable across cloud providers |
