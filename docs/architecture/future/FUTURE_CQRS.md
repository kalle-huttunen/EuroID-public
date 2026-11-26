# CQRS (Command Query Responsibility Segregation)

> **Status:** Partially implemented. Built: the Elasticsearch infrastructure
> (`backend/src/infrastructure/elasticsearch/`, fail-open when Elasticsearch cannot be reached) and an
> audit-event read model for analytics v2 (`modules/analytics/analytics-indexer.service.ts`,
> `analytics-search.service.ts`, `GET /api/v1/analytics/v2/*`). Not built: the identity read model, its
> projection, search API and backfill, and the GDPR cascade (see the checklist).
> **Roadmap:** [ROADMAP.md](../roadmap/ROADMAP.md) | [Data Flows](../core/DATAFLOWS.md)

### Current State (updated 2026-02-17)
- Single MongoDB `identities` collection for both reads and writes
- `IdentityService.findAll()` used by both API reads and policy simulation (`policy-engine.service.ts:251`)
- Complex nested Onion Model makes filtering expensive (e.g., `profile.departmentName`, `sources[].rawData`)
- Paginated reconciliation exists (`findUsersPageForReconciliation()` at `identity.service.ts:344`, 100/page streaming)
- Text search index exists on `audit_events` (actor, resourceName, description) but not on identities
- Index verification script (`src/scripts/verify-indexes.ts`) covers policies, campaigns, items, connectors, user_events
- No dedicated search/filter infrastructure (ElasticSearch) beyond basic MongoDB queries

### Architecture

```
┌──────────────┐     ┌───────────────────┐     ┌──────────────────┐
│ Write Path   │     │  Domain Events    │     │  Read Path       │
│              │     │                   │     │                  │
│ Identity     │────►│ IDENTITY_UPDATED  │────►│ ElasticSearch    │
│ Service      │     │ IDENTITY_CREATED  │     │ (Flat Projection)│
│ (MongoDB)    │     │ IDENTITY_DELETED  │     │                  │
│ Onion Model  │     │                   │     │ Dashboard API    │
└──────────────┘     └───────────────────┘     └──────────────────┘
```

### Implementation Plan

**Phase 1: Event Infrastructure**
- The event system already exists: `DomainEventEmitterService` + `DomainEventType`
- Add new events if missing: `IDENTITY_CREATED`, `IDENTITY_UPDATED`, `IDENTITY_DELETED`
- Ensure `IdentityService.saveToHub()` emits events with full identity payload

**Phase 2: Read Model Projection Service**
- Create `backend/src/modules/identity/projections/`:
  - `identity-projection.service.ts` — listens to domain events, builds flat read model
  - `identity-read.dto.ts` — flattened DTO: `{ id, email, firstName, lastName, department, jobTitle, status, location, managerEmail, entitlements[], sourcesSummary, provisioningStatus, ... }`
  - `identity-search.service.ts` — wraps ElasticSearch queries
- Projection flattens the Onion: `identity.profile.departmentName` → `department`
- Include computed fields: `entitlementCount`, `sourceCount`, `lastSyncDate`
- **Note:** `IdentityService` already emits 7 event types (CREATED, UPDATED, DELETED, CORRELATED, CORRELATION_CONFLICT, STATUS_CHANGED, SOURCES_CHANGED) — projection can subscribe to these directly via `DomainEventEmitterService`

**Phase 3: ElasticSearch Integration**
- Built with `@elastic/elasticsearch` in `backend/src/infrastructure/elasticsearch/`:
  - `elasticsearch.module.ts` (global), `elasticsearch.service.ts`; connection config in `infrastructure/config/elasticsearch.config.ts` (env `ELASTICSEARCH_NODE`, default `http://localhost:9200`)
  - `elasticsearch.constants.ts`: indices `audit-events` and `analytics-forecasts` and their mappings; an `identities-read` index is not built
- Index mapping: keyword fields for filtering, text fields for search, date fields for range queries
- Initial backfill: migration script to project all existing identities

**Phase 4: Read API Endpoints**
- Create `backend/src/modules/identity/identity-read.controller.ts`:
  - `GET /api/v1/identities/search?q=...&department=...&status=...` — full-text + filtered search
  - `GET /api/v1/identities/facets` — aggregation counts (by department, status, location)
  - `GET /api/v1/identities/export` — CSV export from read model
- Keep existing `IdentityController` for write operations (create, update, link)
- Modify `PolicyEngineService.simulate()` to query read model instead of `findAll()`

**Phase 5: Frontend Dashboard**
- Update `frontend/src/features/users/` to use search API
- Add faceted filtering sidebar (department, status, location dropdowns)
- Add full-text search bar with debounced ES queries

### Files Changed
| Action | File |
|--------|------|
| New | `backend/src/modules/identity/projections/` (service + DTO) |
| New | `backend/src/infrastructure/elasticsearch/` (module + config) |
| New | `backend/src/modules/identity/identity-read.controller.ts` |
| Modify | `backend/src/modules/identity/identity.service.ts` — ensure all mutations emit events |
| Modify | `backend/src/modules/identity/identity.module.ts` — register projection service |
| Modify | `backend/src/modules/policy/policy-engine.service.ts` — use read model for simulation |
| Modify | `frontend/src/features/users/` — search UI |
| New | `backend/src/scripts/backfill-read-model.ts` — initial migration |

### Dependencies
- ElasticSearch instance (new infrastructure)

### GDPR Considerations
- Read model must support GDPR erasure cascades: when `DELETE /identity/:id/gdpr-erase` fires, the ES projection must be purged synchronously
- DSAR export (`GET /identity/:id/dsar-export`) should query from the read model for performance, but fall back to MongoDB for completeness
- PII fields in ES must respect the same blur/reveal audit pattern (`POST /identity/:id/pii/reveal`)

### Implementation Checklist

**Phase 1 — Event Infrastructure**
- [ ] Ensure `IdentityService.saveToHub()` emits `IDENTITY_CREATED`, `IDENTITY_UPDATED`, `IDENTITY_DELETED` events with full payload (today `saveToHub` emits `identity.created` only when it mints an identity, with id, source system and status)

**Phase 2 — Read Model Projection**
- [ ] Create `identity-read.dto.ts` (flattened DTO: id, email, department, jobTitle, status, entitlementCount, etc.)
- [ ] Create `identity-projection.service.ts` (subscribe to domain events, build flat read model in ElasticSearch)
- [ ] Create `identity-search.service.ts` (wraps ElasticSearch queries for filtering and full-text search)

**Phase 3 — ElasticSearch Integration**
- [x] Add `@elastic/elasticsearch` and create `backend/src/infrastructure/elasticsearch/` module
- [ ] Define index mappings for `identities-read` (keyword, text, date fields)
- [ ] Create backfill migration script (`backfill-read-model.ts`) for existing identities

**Phase 4 — Read API & Frontend**
- [ ] Create `identity-read.controller.ts` with search, facets, and CSV export endpoints
- [ ] Modify `PolicyEngineService.simulate()` to query read model instead of `findAll()`
- [ ] Update `frontend/src/features/users/` with faceted filtering and full-text search

**GDPR**
- [ ] Implement GDPR erasure cascade to ES projection (purge on `gdpr-erase`)
- [ ] Ensure PII fields in ES respect blur/reveal audit pattern
- [ ] Add unit and integration tests for projection, search, and GDPR erasure

### Risks
- Eventual consistency: read model lags behind writes (acceptable for dashboard, not for provisioning)
- Must never use read model for write-path decisions (policy evaluation at provisioning time still uses MongoDB)
