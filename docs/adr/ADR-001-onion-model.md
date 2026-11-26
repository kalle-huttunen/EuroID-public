# ADR-001: Onion Model Identity Schema

**Status:** Accepted
**Date:** 2026-02-23
**Author:** EuroID Team

## Context

The EuroID platform ingests identity data from multiple HR sources (Workday, SAP SuccessFactors, etc.) and provisions to multiple target systems (Entra ID, Active Directory, Slack). This creates several challenges:

- **Multi-HR conflict resolution:** When two HR systems provide different values for the same field (e.g., `jobTitle`), the system needs clear ownership and merge semantics.
- **Attribute ownership:** Each field must have a defined "master" source. Non-owner writes should be silently ignored to prevent data corruption.
- **Audit trail:** Every change to identity data must be traceable to its source system and timestamp.
- **Provisioning state tracking:** Each target system has its own sync status that must be tracked independently.

A flat JSON document model conflates source data, computed data, and provisioning state into a single level, making conflict resolution ambiguous and audit trails difficult to reconstruct.

## Decision

Adopt a **layered "Onion Model"** for the identity document, stored as a single MongoDB document per identity in the `identities` collection. The layers are:

| Layer | Schema Field | Purpose |
|-------|-------------|---------|
| 1 — Golden Record | `profile` (`IdentityProfile`) | Computed, read-only for connectors. The reconciled "truth" produced by `ReconciliationService`. |
| 2 — Source Data | `sources[]` (`LinkedAccount[]`) | Raw per-source data. Each entry carries `sourceName`, `externalId`, `rawData`, `contractType` (primary/secondary), and `sourceRole` (primary-hr/secondary-hr/target). |
| 3 — Admin Controls | `controls` (`IdentityControls`) | Manual overrides: `isLoginDisabled`, `manualDepartment` and `manualJobTitle` (each with a `manualDepartmentInfo` / `manualJobTitleInfo` record: reason, author, time, optional expiry), `overrides`. Takes priority over source data. |
| 4 — Provisioning | `provisioning[]` (`ProvisioningState[]`) | Per-target sync status: `PENDING`, `SYNCING`, `SYNCED`, `ERROR`, `DEPROVISIONED`. |
| 5 — Metadata | Root fields | `tenantId`, timestamps, `deletedAt` (soft-delete), optimistic concurrency version. The HMAC of the national ID is `profile.correlationId` (Layer 1), not a root field. |

Connectors write exclusively to Layer 2 (their own source entry). The Policy Engine and Reconciliation Service compute Layer 1 from Layer 2 + Layer 3 inputs. Layer 4 is updated by provisioning workflows.

## Consequences

### Positive
- Clear attribute ownership: each source writes only to its own `sources[]` entry
- Conflict resolution is explicit: `ReconciliationService` applies mastery rules to merge sources into the Golden Record
- Audit trail: each source entry carries `lastSync` and `rawData` for full traceability
- Admin overrides (Layer 3) have defined priority over computed values
- Provisioning state is isolated per target system, preventing cross-system interference

### Negative
- More complex queries: reading the "current state" requires understanding the layer hierarchy
- Larger document size: storing raw source data alongside computed profile duplicates some fields
- Reconciliation logic is a critical path: bugs in the merge algorithm affect all identities

### Risks
- Document size growth: identities linked to many sources/targets may approach MongoDB's 16MB document limit (mitigated by the 50-source validation limit)
- Reconciliation must be idempotent and re-runnable to recover from merge bugs

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| Flat JSON document | Simple queries, smaller documents | No ownership semantics, conflict resolution is ad-hoc, audit trail requires separate collection |
| Separate collections per HR source | Strong isolation between sources | Joins required for Golden Record computation, no atomic cross-source operations, complex indexing |
| Relational model (PostgreSQL) | Referential integrity, JOINs | Schema rigidity conflicts with varying HR source fields, migration overhead for schema evolution |
