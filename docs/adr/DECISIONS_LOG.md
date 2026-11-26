# Architecture Decision Records — Log

This table indexes all ADRs for the EuroID platform. Each ADR documents a significant architectural decision, its context, and alternatives considered.

| ADR | Title | Status | Date | Summary |
|-----|-------|--------|------|---------|
| [ADR-001](ADR-001-onion-model.md) | Onion Model Identity Schema | Accepted | 2026-02-23 | 5-layer document model (profile → sources → controls → provisioning → metadata) for multi-HR conflict resolution and attribute ownership |
| [ADR-002](ADR-002-temporal-orchestration.md) | Temporal for Workflow Orchestration | Accepted | 2026-02-23 | Temporal.io for all multi-step workflows — pure workflow code, activities for I/O, saga compensation |
| [ADR-003](ADR-003-mongodb-document-model.md) | MongoDB Document Model | Accepted | 2026-02-23 | MongoDB with Mongoose, document-per-identity, tenant scoping via plugin, optimistic concurrency |
| [ADR-004](ADR-004-dumb-pipe-connectors.md) | Dumb Pipe Connectors | Accepted | 2026-02-23 | Connectors handle field mapping and protocol execution only — all business logic in Policy Engine |
| [ADR-005](ADR-005-domain-events.md) | Domain Event Bus | Accepted | 2026-02-23 | `DomainEventEmitterService` with Zod-validated payloads, outbox pattern, DLQ, and chain depth limit |
| [ADR-006](ADR-006-event-sourcing-identity.md) | Event Sourcing for Identity | Accepted, not implemented | 2026-02-23 | Append-only event store as non-blocking side-channel, snapshots every 100 events, time-travel API |
| [ADR-007](ADR-007-cell-architecture.md) | Cell-Based Tenant Isolation | Accepted, not implemented | 2026-02-23 | Per-cell MongoDB/Temporal/ES with shared control plane, middleware routing via AsyncLocalStorage |
