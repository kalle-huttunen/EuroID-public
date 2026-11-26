# Immutable Audit Ledger

> **Status:** Phases 1-4 COMPLETE, Phase 5 PARTIALLY COMPLETE
> **Roadmap:** [ROADMAP.md](../roadmap/ROADMAP.md) | [Data Flows](../core/DATAFLOWS.md)

### Current State (updated 2026-02-22) — Phases 1-4 COMPLETE, Phase 5 PARTIALLY COMPLETE
- Audit module fully implemented in `modules/audit/` (controller, service, schema, Merkle tree, S3 archive)
- **Phase 1 — SHA-256 hash chain**: each audit event stores `integrityHash`, `previousHash`, chained from `GENESIS_HASH` anchor. Since 2026-11-24 one chain per tenant: `audit-chain-writer.ts` gives every event its chain position `seq` through a per-tenant chain head (`audit_chain_heads`; the unique `{ tenantId, seq }` index keeps the API, the worker and concurrent writes on one chain), and hash version 2 (`audit-hash.ts`) covers every stored field, payload and `eventId` included. Events written before keep their hashes (version 1: no payload, links forked by each process's own last-hash cache)
- **Phase 2 — Merkle Tree aggregation**: `audit-merkle.service.ts` builds binary Merkle trees from event hashes, generates/verifies proofs. Schema: `audit_roots` collection
- **Phase 3 — WORM Storage Export**: `audit-archive.service.ts` exports checkpoints to S3 with Object Lock (COMPLIANCE mode). GDPR: hashes-only by default, optional PII inclusion. Daily CronWorkflow: `audit-archive.workflow.ts`
- **Phase 4 — Verification API**: `GET /audit/merkle-roots`, `POST /audit/verify-event/:eventId`, `POST /audit/verify` (date range)
- **Integrity verification endpoint**: `GET /api/v1/audit/verify-integrity` (super-admin, `audit-chain-verifier.ts`) re-hashes every event of the window by its own hash version, checks each chained event links to the position before it, and reports missing positions (`reason`: `hash_mismatch`, `broken_link`, `missing_events`); gaps a GDPR erasure recorded (`removedSeqs` on its `GDPR_ERASURE_EXECUTED` entry) come back in `erasureGaps`, and the answer counts the version 1 events it checked (`legacyEventsChecked`)
- **Known limitation**: GDPR erasures run before commit `47fa1cd7` (2026-11-24) recorded no `removedSeqs`, so `verify-integrity` over a window holding the event after an entry they deleted answers `valid: false` with `broken_link`. Nothing repairs that gap; it is accepted ([GDPR_COMPLIANCE.md](../../../backend/src/modules/compliance-reporting/docs/GDPR_COMPLIANCE.md), Known Limitations item 4)
- **Known limitation**: GDPR erasure does not reach the WORM export. With `AUDIT_ARCHIVE_INCLUDE_PAYLOAD=true` an exported checkpoint carries each event's actor, resource name, description and payload under Object Lock until `AUDIT_WORM_RETENTION_DAYS`, so an erased person's entries exported before the erasure stay there; with the default (hashes and metadata only) the object holds their resource ids and hashes. The same holds for the cold-storage archival of `audit_events` and `user_events` ([GDPR_COMPLIANCE.md](../../../backend/src/modules/compliance-reporting/docs/GDPR_COMPLIANCE.md), Known Limitations item 5)
- **Checkpoint creation**: `POST /api/v1/audit/merkle-roots` (super-admin, audited as `AUDIT_CHECKPOINT_CREATED`) and the daily audit archive run (its first activity, when `AUDIT_ARCHIVE_ENABLED=true`) checkpoint the chain positions after the last checkpoint, at most `AUDIT_CHECKPOINT_MAX_EVENTS` (default 10000) per checkpoint. Version 1 events (no chain position) up to the tenant's first chained event go once into legacy checkpoints the daily run makes (`legacy: true`, `legacyPart`), by their stored hashes in `(timestamp, _id)` order, so the archive exports them too
- **Checkpoint check**: `POST /api/v1/audit/verify` checks each checkpoint's root against its leaves and re-hashes the covered events still in the log (`root_mismatch`, `event_changed`; events gone by retention or erasure are counted in `eventsMissing`). A legacy checkpoint proves only that its events' stored hashes, and the fields they cover, have not changed since it was made: the version 1 hash does not cover the payload (`legacyCheckpointsChecked`, `legacyNote`)
- TTL index with configurable `AUDIT_RETENTION_DAYS` env var + 30-day archival buffer
- Text search index on actor (weight 3), resourceName (weight 2), description (weight 1)
- 20+ named audit action types including `GDPR_ERASURE_EXECUTED`
- PII reveal tracking: `POST /api/v1/identity/:id/pii/reveal` writes a `PII_REVEALED` audit entry (who revealed which field) before it answers
- **Compliance Reporting module** (`modules/compliance-reporting/`): SOX/ISO 27001 reports — partially fulfills Phase 5
- **Audit integrity page** (2026-11-24): `frontend/src/features/audit-integrity/AuditIntegrityPage.tsx` (`/audit/integrity`, super-admin): chain check over a time window, one event's Merkle proof, checkpoint list with create, checkpoint check and anchor proof. Not built: real-time chain status (last and next verification)

### Architecture

```
┌──────────────┐     ┌───────────────────┐     ┌──────────────────────┐
│ Domain Event │────►│ Audit Service     │────►│ MongoDB (Hot)        │
│ Emitter      │     │ (Hash Chain)      │     │ audit_events         │
│              │     │                   │     │ + hash, prevHash     │
│              │     │ Merkle Tree       │────►│                      │
│              │     │ Builder           │     │ WORM Storage (Cold)  │
│              │     │                   │────►│ S3 + Object Lock     │
└──────────────┘     └───────────────────┘     └──────────────────────┘
```

### Implementation Plan

**Phase 1: Hash Chain for Audit Events — ✅ COMPLETE (2026-02-17)**
- Implemented in `backend/src/modules/audit/`:
  - `audit.service.ts` — SHA-256 hash chain with `GENESIS_HASH` anchor, each event stores `integrityHash` + `previousHash` (and since 2026-11-24 `seq` and `hashVersion`, written by `audit-chain-writer.ts`)
  - `audit.controller.ts`: `GET /audit/verify-integrity` (`audit-chain-verifier.ts`) recomputes hashes, checks the links between events and the chain positions
  - `schemas/audit-event.schema.ts` — includes `integrityHash`, `previousHash`, `seq`, `hashVersion`; `schemas/audit-chain-head.schema.ts` holds each tenant's chain head
- **No further work needed on Phase 1.**

**Phase 2: Merkle Tree Aggregation**
- Every N events (e.g., 1000) or on a timer (e.g., hourly):
  - Build Merkle Tree from event hashes
  - Store Merkle Root in a separate `audit_roots` collection
  - `audit-merkle.service.ts` — tree builder, root calculator
- Merkle Roots are the "checkpoints" — proving tampering requires recomputing from root

**Phase 3: WORM Storage Export**
- Create `backend/src/modules/audit/audit-archive.service.ts`:
  - Periodically export completed Merkle trees + events to S3 with Object Lock (WORM)
  - S3 Object Lock: `COMPLIANCE` mode (even root account cannot delete)
  - Export format: gzipped JSON (built that way; see the Phase 3 checklist below)
- Temporal CronWorkflow: `audit-archive-workflow` runs daily

**Phase 4: Verification API (Extend Existing)**
- `GET /api/v1/audit/verify-integrity` already exists — extend it, do NOT create a separate controller
- Add to existing `audit.controller.ts`:
  - `POST /api/v1/audit/verify` — verify date range (more granular than full chain)
  - `GET /api/v1/audit/merkle-roots` — list Merkle roots with dates
  - `POST /api/v1/audit/verify-event/:id` — prove single event inclusion via Merkle proof
- Response: `{ valid: boolean, eventsChecked: number, firstInvalidAt?: number, merkleRoot: string }`

**Phase 5: Compliance Dashboard — ⚡ PARTIALLY COMPLETE (2026-02-19)**
- **Done:** `ComplianceReportingService` generates SOX/ISO 27001 reports that verify audit integrity (`auditTrailIntegrity.valid`), aggregate SoD violations, access certification stats, risk posture, and anomaly summaries. Frontend `ComplianceReports.tsx` allows report generation and download.
- **Done (2026-11-24):** `frontend/src/features/audit-integrity/AuditIntegrityPage.tsx` gives the one-click chain check, the Merkle checkpoint list with create and check; real-time chain status is still open. Originally planned as `frontend/src/features/audit/AuditIntegrity.tsx` for:
  - Real-time chain status (last verified, next verification)
  - One-click "Verify Integrity" button (separate from full report generation)
  - Visual timeline of Merkle roots (requires Phase 2)

### Files Changed
| Action | File | Status |
|--------|------|--------|
| ~~New~~ | ~~`backend/src/infrastructure/audit/`~~ | **N/A — implemented in `modules/audit/` instead** |
| ~~Modify~~ | ~~Audit event schema — add `hash`, `previousHash`~~ | **✅ DONE** |
| ~~New~~ | ~~`backend/src/modules/audit/audit-verification.controller.ts`~~ | **✅ DONE (in `audit.controller.ts`)** |
| New | `audit-merkle.service.ts` + `audit-merkle-root.schema.ts` + `audit-merkle.spec.ts` | **✅ DONE** |
| New | `audit-archive.service.ts` + `audit-archive-storage.factory.ts` | **✅ DONE** |
| New | `backend/src/workflows/audit-archive.workflow.ts` | **✅ DONE** |
| New | `backend/src/activities/audit-archive.activities.ts` + module + spec | **✅ DONE** |
| New | `frontend/src/features/audit-integrity/AuditIntegrityPage.tsx` (planned as `features/audit/AuditIntegrity.tsx`) | **✅ DONE (2026-11-24)**, real-time chain status still open |
| New | `backend/src/modules/compliance-reporting/` (service, controller, templates, schema) | **✅ DONE** |
| New | `frontend/src/features/compliance/ComplianceReports.tsx` | **✅ DONE** |

### GDPR Considerations
- `GDPR_ERASURE_EXECUTED` is already an audit action type — ensure the hash chain remains valid after erasure (erasure event is appended, NOT deleted from chain)
- WORM storage must be compatible with GDPR right to erasure: store only hashes and metadata in WORM, PII in soft-deletable hot storage
- DSAR export must include audit trail for the requesting identity

### Dependencies
- S3 with Object Lock (for WORM storage)
- Improvement 9 (KEDA) helps if audit archive workflow needs scaling

### Implementation Checklist

**Phase 2 — Merkle Tree Aggregation — ✅ COMPLETE (2026-02-22)**
- [x] Create `audit-merkle.service.ts` (tree builder, root calculator, checkpoint creation)
- [x] Create `audit_roots` collection schema (`audit-merkle-root.schema.ts`)
- [x] Unit tests: `audit-merkle.spec.ts` (empty, single, odd, large, proof generation/verification)

**Phase 3 — WORM Storage Export — ✅ COMPLETE (2026-02-22)**
- [x] Create `audit-archive.service.ts` (export to S3 with Object Lock COMPLIANCE mode)
- [x] Create `audit-archive.workflow.ts` Temporal CronWorkflow (daily at 3 AM)
- [x] Export format: gzipped JSON (hashes + metadata by default, PII optional via `AUDIT_ARCHIVE_INCLUDE_PAYLOAD`)
- [x] S3 Object Lock: `uploadWithLock()` method on `S3StorageAdapter`
- [x] Unit tests: `audit-archive.activities.spec.ts` (gzip, checksum, GDPR PII separation)

**Phase 4 — Verification API Extension — ✅ COMPLETE (2026-02-22)**
- [x] Add `POST /audit/verify` (verify date range) to existing `audit.controller.ts`
- [x] Add `GET /audit/merkle-roots` and `POST /audit/verify-event/:eventId` (Merkle proof for single event)

**Phase 5 — Audit Integrity UI**
- [x] Dedicated page `features/audit-integrity/AuditIntegrityPage.tsx`: one-click verify over a time window, Merkle checkpoint list, create and check (2026-11-24)
- [ ] Real-time chain status (last verified, next verification)

**GDPR**
- [x] WORM storage separates PII from hash metadata (default export: hashes + metadata only)
- [x] Ensure DSAR export includes audit trail for requesting identity (`compliance-reporting/dsar-export.service.ts` reads the identity's `audit_events` by `resourceId`)
- [x] Unit and integration tests for Merkle tree, archival, and verification endpoints

### Risks
- Hash chain is single-threaded per tenant: every audit write of a tenant passes its chain head (a read, the insert, a forward-only head update; a writer that loses a position retries, at most `AUDIT_CHAIN_WRITE_ATTEMPTS` times). Throughput per tenant is bounded by that round trip. Version 1 events (before 2026-11-24) forked: their check accepts a link to any earlier event
- The hash chain has no secret: whoever can write to MongoDB can rewrite events and recompute every later hash and head. Only checkpoints signed with a key held outside the database (and delivered to a witness) make such a rewrite detectable
- Performance: computing hash per event adds ~1ms latency (already accepted and live in production)
- Chain break recovery: if a single event is corrupted, chain from that point is invalid
- GDPR tension: WORM immutability vs right to erasure (mitigated by separating PII from hash metadata)
