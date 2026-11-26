# ADR-005: Domain Event Bus for Cross-Module Communication

**Status:** Accepted
**Date:** 2026-02-23
**Author:** EuroID Team

## Context

EuroID is organized into independent modules (Identity, Policy, Connectors, Reconciliation, Risk Scoring, Intelligence, etc.). These modules need to communicate: when an identity is created, the risk scoring module needs to compute an initial score; when provisioning completes, audit logging needs to record the event; when a policy changes, affected identities need re-evaluation.

Direct service imports between modules create tight coupling:
- Module A imports Module B's service → Module A cannot be deployed/tested without Module B.
- Adding a new consumer (e.g., analytics) requires modifying the emitting module.
- Circular dependencies emerge quickly in a system with 15+ modules.

## Decision

Use a **domain event bus** implemented as `DomainEventEmitterService` (wrapping `@nestjs/event-emitter` / `EventEmitter2`) for all cross-module communication. Key design elements:

1. **Typed event envelope:** Every event carries `eventId`, `type` (from `DomainEventType` enum), `aggregateId`, `timestamp`, and `metadata` (correlationId, causedBy, depth, emittedBy, actor, tenantId).
2. **Zod-validated payloads:** Each event type has a registered Zod schema. Invalid payloads are routed to the Dead Letter Queue (DLQ) in production; in development, they throw for fast feedback.
3. **Outbox pattern:** Events are persisted to a MongoDB `OutboxEvent` collection before handler execution, ensuring at-least-once delivery even if the process crashes mid-handling.
4. **Dead Letter Queue:** Failed handlers, validation failures, and depth-exceeded events are captured by `DeadLetterService` with structured metadata for investigation and replay.
5. **Chain depth limit:** `MAX_EVENT_DEPTH = 20`. Events exceeding this depth are dropped to the DLQ to prevent infinite event loops (e.g., A → B → A → B...).
6. **Decoupled consumers:** Consumers use `@OnEvent(DomainEventType.X)` decorators. The emitting service never knows about its consumers.

## Consequences

### Positive
- Clean module boundaries: modules communicate only through events, no direct imports
- Adding new consumers requires zero changes to the emitting module
- Outbox pattern ensures events survive process crashes
- DLQ captures all failure modes for investigation and replay
- Chain depth limit prevents runaway event cascades

### Negative
- Eventual consistency: consumers process events asynchronously — no guaranteed ordering or immediate effect
- Debugging event chains requires correlationId/causedBy tracing across multiple handlers
- Outbox table grows continuously (requires periodic cleanup/archival)

### Risks
- Event schema evolution: adding/removing fields from event payloads requires coordinating emitters and consumers
- DLQ depth growing unnoticed (mitigated by alerting on DLQ depth — see ops runbook)
- Security: events with empty `tenantId` are logged as warnings but not blocked

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| Direct service injection | Simple, synchronous, easy to debug | Tight coupling, circular dependencies, no failure isolation, adding consumers requires modifying emitter |
| gRPC between modules | Typed contracts, language-agnostic | Operational overhead of service mesh, synchronous by default, overkill for in-process communication |
| Shared database triggers | No application-level event bus needed | Database-specific, hard to test, limited to DB change events, no business event semantics |
| External message broker (RabbitMQ/Kafka) | True decoupling, cross-service communication, replay support | Operational complexity, added infrastructure dependency, latency overhead for in-process events |
