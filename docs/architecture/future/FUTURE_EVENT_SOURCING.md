# Event Sourcing for Identity State

> **Status:** Not implemented. No identity event store: no `backend/src/modules/identity/events/`, no
> `identity_events` collection, no history API, no `backend/src/scripts/replay-identity.ts`.
> `backend/src/modules/identity/user-event.service.ts` records the per-user timeline; it is not an event store.
> **Roadmap:** [ROADMAP.md](../roadmap/ROADMAP.md) | [Data Flows](../core/DATAFLOWS.md)

### Current State (updated 2026-02-17)
- Identity stored as current state in MongoDB Onion Model (`identity.schema.ts`)
- `IdentityService` (1,390 lines) emits 7 distinct domain event types: `IDENTITY_CREATED`, `IDENTITY_UPDATED`, `IDENTITY_DELETED`, `IDENTITY_CORRELATED`, `CORRELATION_CONFLICT`, `IDENTITY_STATUS_CHANGED`, `IDENTITY_SOURCES_CHANGED`
- **Transactional outbox implemented**: `create()` uses `eventEmitter.emitWithTransaction()` within MongoDB `session.withTransaction()` when replica set detected (`identity.service.ts:267-284`), ensuring at-least-once event delivery
- Falls back to fire-and-forget emit on standalone MongoDB (`identity.service.ts:291-292`)
- Optimistic concurrency control (OCC) with `VersionError` retry (up to 3 retries before 409)
- `UserEvents` collection exists for history but is not a true event source
- No event store — cannot replay to reconstruct past state
- 38+ total domain event types in `event-types.ts` across all modules (4 new: `RISK_SCORES_CALCULATED`, `ORPHAN_DETECTED`, `RECERTIFICATION_CAMPAIGN_CREATED`, `COMPLIANCE_REPORT_GENERATED`)

### Architecture

```
┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│ Command           │     │  Event Store     │     │  Projection      │
│ (saveToHub,       │────►│  (MongoDB)       │────►│  (Current State) │
│  linkAccount,     │     │                  │     │                  │
│  updateProfile)   │     │  identity_events │     │  identities      │
│                   │     │  [NameChanged,   │     │  (Onion Model)   │
│                   │     │   SourceLinked,  │     │                  │
│                   │     │   RoleAssigned]  │     │                  │
└──────────────────┘     └──────────────────┘     └──────────────────┘
                                │
                         ┌──────┴──────┐
                         │ Time Travel │
                         │ Replay to   │
                         │ any point   │
                         └─────────────┘
```

### Implementation Plan

**Phase 1: Event Store Schema**
- Create `backend/src/modules/identity/events/`:
  - `identity-event.schema.ts`:
    ```
    { identityId, tenantId, eventType, version, timestamp, payload, actor, correlationId }
    ```
  - Event types: `IdentityCreated`, `ProfileUpdated`, `SourceLinked`, `SourceUnlinked`,
    `ControlOverrideSet`, `ProvisioningStateChanged`, `StatusChanged`, `Deleted`, `Restored`
  - `identity-event.interface.ts` — discriminated union of all event types

**Phase 2: Command → Event Conversion**
- Modify `IdentityService`:
  - Each mutation method first appends event(s) to event store, then projects to current state
  - **Note:** `IdentityService` already emits events from every mutation. The change is to persist events to the event store BEFORE projecting state, and use the transactional outbox (already implemented) to guarantee atomicity.
  - `saveOrUpdate()` → emits `IdentityCreated` or `ProfileUpdated` + `SourceLinked` (currently at `identity.service.ts:201,271,291`)
  - `markAsDeleted()` → emits `IdentityDeleted` (currently at `identity.service.ts:534`)
  - `updateProvisioningState()` → emits `ProvisioningStateChanged` (needs adding)
  - `pushSourceAndReconcile()` → emits `IdentitySourcesChanged` (currently at `identity.service.ts:1348`)
- Create `backend/src/modules/identity/events/identity-event-store.service.ts`:
  - `append(identityId, events[])` — atomic append (leverage existing transactional outbox pattern)
  - `getEvents(identityId, fromVersion?)` — read stream
  - `getSnapshot(identityId, atTimestamp?)` — replay events to build state

**Phase 3: Projection (Current State Builder)**
- Create `backend/src/modules/identity/events/identity-projector.service.ts`:
  - `project(events[]) → Identity` — applies events sequentially to build Onion Model
  - Handles all event types: create, update, link, unlink, override, delete
- Snapshot strategy: store snapshot every 100 events to avoid full replay
- `identity-snapshot.schema.ts` — `{ identityId, version, snapshot: Identity, createdAt }`

**Phase 4: Time-Travel API**
- Create `backend/src/modules/identity/identity-history.controller.ts`:
  - `GET /api/v1/identities/:id/history` — event stream for an identity
  - `GET /api/v1/identities/:id/at?timestamp=2025-02-01` — state at a point in time
  - `GET /api/v1/identities/:id/diff?from=v5&to=v10` — diff between two versions
- Used by compliance: "What did this user's access look like on Feb 1st?"

**Phase 5: Replay for Debugging**
- Create `backend/src/scripts/replay-identity.ts`:
  - Replay all events for an identity, logging each state transition
  - Compare with current snapshot to detect projection drift
- Useful for debugging reconciliation issues: "Why does this user have access X?"

### Files Changed
| Action | File |
|--------|------|
| New | `backend/src/modules/identity/events/` (schema, store, projector, interfaces) |
| Modify | `backend/src/modules/identity/identity.service.ts` — event-first mutation pattern |
| New | `backend/src/modules/identity/identity-history.controller.ts` |
| New | `backend/src/modules/identity/events/identity-snapshot.schema.ts` |
| New | `backend/src/scripts/replay-identity.ts` |
| Modify | `backend/src/modules/identity/identity.module.ts` — register event services |

### Scope Adjustment (2026-02-17)
- Transactional outbox is already implemented — Phase 2 can leverage this directly instead of building from scratch.
- 7 identity event types are already emitted; the work is routing them through an event store before the existing `DomainEventEmitterService`.
- OCC with retry is in place — event store append can use the same pattern.

### GDPR Considerations
- GDPR erasure (`DELETE /identity/:id/gdpr-erase`) must cascade to the event store: either hard-delete all events for an identity, or redact PII fields in events while preserving the event structure for audit
- Recommended: separate PII payload from event metadata — event store keeps `{ eventType, identityId, version, timestamp, actor }`, PII stored in a soft-deletable sidecar document
- Time-travel API (`GET /identities/:id/at?timestamp=...`) must respect GDPR: if identity is erased, return 410 Gone

### Dependencies
- None (uses existing MongoDB)
- Benefits from Improvement 2 (CQRS) — event store feeds both MongoDB projection and ES read model

### Implementation Checklist

**Phase 1 — Event Store Schema**
- [ ] Create `identity-event.schema.ts` (identityId, tenantId, eventType, version, timestamp, payload, actor, correlationId)
- [ ] Create `identity-event.interface.ts` with discriminated union for all event types

**Phase 2 — Command to Event Conversion**
- [ ] Create `identity-event-store.service.ts` (append, getEvents, getSnapshot)
- [ ] Modify `IdentityService` mutation methods to persist events to event store BEFORE projecting state
- [ ] Leverage existing transactional outbox pattern for atomic event append

**Phase 3 — Projection (Current State Builder)**
- [ ] Create `identity-projector.service.ts` (project events[] to Identity Onion Model)
- [ ] Create `identity-snapshot.schema.ts` (snapshot every 100 events)

**Phase 4 — Time-Travel API**
- [ ] Create `identity-history.controller.ts` (GET /history, GET /at?timestamp=, GET /diff?from=&to=)
- [ ] Add unit and integration tests for event store, projector, and time-travel queries

**Phase 5 — Replay & Migration**
- [ ] Create `replay-identity.ts` script (replay events, log transitions, detect projection drift)
- [ ] Create migration script: generate synthetic `IdentityCreated` events for existing identities

**GDPR**
- [ ] Implement PII/metadata separation (event metadata in event store, PII in soft-deletable sidecar)
- [ ] Ensure time-travel API returns 410 Gone for GDPR-erased identities

### Risks
- Migration: existing identities have no event history (create synthetic `IdentityCreated` events)
- Event schema evolution: adding new event types requires backward-compatible projectors
- Storage: event store grows indefinitely (mitigate with snapshots + cold storage archival)
- GDPR erasure vs event immutability tension (mitigate with PII/metadata separation)
