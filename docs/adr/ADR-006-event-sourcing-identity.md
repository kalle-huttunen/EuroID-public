# ADR-006: Event Sourcing for Identity Aggregate

**Status:** Accepted, not implemented (the code has no `identity_events`, `identity_snapshots` or `gdpr_erasure_markers` collection and no `/identity/:id/history`, `/at` or `/diff` route)
**Date:** 2026-02-23
**Author:** EuroID Team

## Context

Identity data in an IGA platform requires a complete audit trail: regulators, compliance teams, and security auditors need to know exactly what changed, when, by whom, and why. Additionally, the ability to reconstruct an identity's state at any historical point ("time travel") is essential for:

- **Compliance audits:** "What was this user's access level on March 15th?"
- **Incident investigation:** "When did this identity's department change, and which HR source triggered it?"
- **Rollback analysis:** "Can we reverse this batch of changes?"

Traditional approaches (storing only current state with an audit log of diffs) make point-in-time reconstruction expensive and error-prone.

## Decision

Implement **event sourcing** for the identity aggregate as a **non-blocking side-channel** alongside the existing Onion Model document. Key design choices:

1. **Append-only event store:** All identity mutations append an event to the `identity_events` collection. Nine event types: `IdentityCreated`, `ProfileUpdated`, `SourceLinked`, `SourceUnlinked`, `ControlOverrideSet`, `ProvisioningStateChanged`, `StatusChanged`, `IdentityDeleted`, `IdentityRestored`.
2. **Non-blocking writes:** Event store appends use fire-and-forget (`.catch()` with logger). The mutation succeeds even if the event append fails. The event store is a side-channel, not in the critical write path.
3. **Optimistic concurrency:** `(identityId, version)` unique compound index on `identity_events`. Version conflicts retry up to 3 times.
4. **Periodic snapshots:** Every `EVENT_STORE_SNAPSHOT_INTERVAL` (default: 100) events, a snapshot of the projected identity state is saved to `identity_snapshots`. Snapshots are created asynchronously after the event append.
5. **Time-travel API:**
   - `GET /identity/:id/history` — paginated event stream
   - `GET /identity/:id/at?timestamp=ISO` — state reconstruction at a point in time
   - `GET /identity/:id/diff?from=5&to=10` — diff between two versions
6. **GDPR compliance:** On erasure, all events and snapshots are hard-deleted, and a `gdpr_erasure_markers` record is inserted. Time-travel endpoints return `410 Gone` for erased identities.

### Collections

| Collection | Purpose | Key Indexes |
|------------|---------|-------------|
| `identity_events` | Append-only event log | `(identityId, version)` unique, `(identityId, timestamp)`, `(tenantId, timestamp)` |
| `identity_snapshots` | Periodic state snapshots | `(identityId, version)` descending |
| `gdpr_erasure_markers` | GDPR erasure tracking | `identityId` unique |

## Consequences

### Positive
- Complete audit trail: every mutation is recorded as an immutable event
- Point-in-time reconstruction: replay events (or start from nearest snapshot) to compute historical state
- Diff support: compare any two versions of an identity
- GDPR-compliant: hard deletion with erasure markers prevents accidental reconstruction
- Non-blocking: event store failures don't degrade the primary mutation path

### Negative
- Storage growth: append-only event log grows indefinitely (mitigated by data retention policies and snapshot-based pruning)
- Complexity: two write paths (Onion Model document + event store) must be kept conceptually consistent
- Replay logic: `applyEvent()` projector must correctly handle all 9 event types for reconstruction

### Risks
- Event store divergence: if fire-and-forget appends fail silently, the event store may have gaps (mitigated by monitoring append failure rates)
- Snapshot corruption: a bug in the projector produces an incorrect snapshot, poisoning all future reconstructions from that snapshot (mitigated by snapshot validation and ability to rebuild from events)

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| CDC from MongoDB oplog | Zero application code for event capture, captures all changes | Oplog is infrastructure-level (no business semantics), oplog retention is time-limited, requires parsing raw BSON diffs |
| Audit table with diffs | Simple to implement, stores only changed fields | Cannot reconstruct full state without replaying all diffs from creation, no snapshot optimization, diff computation is error-prone for nested documents |
| Full event sourcing as primary store | Single source of truth, no dual-write | Too high risk for critical write path — event store failure would block all identity mutations |
