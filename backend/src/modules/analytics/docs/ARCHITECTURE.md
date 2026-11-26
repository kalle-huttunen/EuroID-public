# Analytics v2 (Elasticsearch-backed) — Architecture

> **Module:** Analytics (Extended)
> **Cross-cutting:** [Elasticsearch Infrastructure](../../../infrastructure/elasticsearch/docs/ARCHITECTURE.md) | [Event Bus](../../../../../docs/architecture/core/EVENT_BUS_ARCHITECTURE.md)

## Overview

The Analytics module has two tiers:

| Tier | Backing Store | Services | Status |
|------|--------------|----------|--------|
| v1 | MongoDB aggregation | `PredictiveAnalyticsService` | Production — offboarding forecast, license forecast, seasonal patterns |
| v2 | Elasticsearch | `AnalyticsSearchService`, `AnalyticsIndexerService` | Production — full-text audit search, ES-backed seasonal patterns |

v2 supplements v1 — it does not replace it. When Elasticsearch is unavailable, v2 endpoints either return 400 or transparently fall back to v1 (seasonal patterns).

## Components

| File | Purpose |
|------|---------|
| `analytics.service.ts` | v1 — MongoDB-backed predictive analytics (offboarding, license, seasonal) |
| `analytics-search.service.ts` | v2 — ES-backed queries: audit search, seasonal patterns, indexed event count |
| `analytics-indexer.service.ts` | v2 — Domain event listener that indexes audit events into ES. Provides `backfillFromMongo()` |
| `analytics.controller.ts` | REST API — v1 endpoints + 4 new v2 endpoints |
| `analytics.module.ts` | NestJS module registering all services |

## v1: Upcoming Offboardings

`GET /analytics/upcoming-offboardings?daysAhead=30` (viewer, `PredictiveAnalyticsService.getUpcomingOffboardings`) reads the tenant's live identities whose `profile.endDate` falls within `daysAhead` on every call, so a leaver whose end date was set after an earlier compute is listed and one whose end date moved out is not; `daysRemaining` is counted at the time of the call. Each entry's blast radius (a policy evaluation) comes from the `upcoming_offboardings` cache when the cached entry is not stale (an `identity.updated` with `endDate` marks it stale, `analytics-event.handler.ts`) and has the same end date; otherwise it is computed and cached. `refresh=true` computes every entry again for a super-admin only (as `POST /analytics/refresh`, super-admin); other roles get the current list without it.

## v1: License Forecast

`GET /analytics/license-forecast` and `.../:system/:license` (viewer, `forecastLicenseConsumption`) start from the license's catalog entry: `licenseUnits`, the units in use (`consumed`) and enabled that Entra ID discovery last read from `subscribedSkus` (`consumedUnits`, `prepaidUnits.enabled`), and when (`countsObservedAt`). `currentCount` is the units in use and `capacity` the units enabled (else the `LICENSE_CAPS` entry); both are `null` until discovery has read the license, and so is `projectedCount`: the forecast says the consumption is unknown rather than counting from 0. The trend comes from the `provisioning.completed` audit entries of the last 6 months: the license's adds minus removes per calendar month, a month without changes included. `monthlyRate` is that net change divided by the 6 months, `projectedCount` adds the rate for `daysAhead` to `currentCount`, and `daysToCapacity` is `(capacity - currentCount) / monthlyRate * 30` for a growing license (0 when no unit is left). Fewer than 3 months with changes is `insufficientData` (rate 0).

## v2 API Endpoints

| Method | Path | Role | Description |
|--------|------|------|-------------|
| GET | `/analytics/v2/search` | viewer | Full-text audit event search with filters (action, actor, targetSystem, date range) |
| GET | `/analytics/v2/seasonal-patterns` | viewer | ES date_histogram aggregation (falls back to v1 if ES unavailable) |
| GET | `/analytics/v2/status` | viewer | ES availability + the tenant's indexed audit events |
| POST | `/analytics/v2/backfill` | super-admin | Backfill audit events from MongoDB into ES |

## Indexing Strategy

### Real-time Indexing

`AnalyticsIndexerService` listens to domain events via `@OnEvent` (`indexDomainEvent`, `analytics-indexer.service.ts`):

| Event | Indexed Fields |
|-------|---------------|
| `identity.created` | tenantId, action, actor, resourceType (`identity`), resourceId (the event's aggregate id), timestamp (when indexed), correlationId |
| `identity.updated` | the same |
| `provisioning.completed` | the same |

Each document also stores the event's `payload` (where `sourceSystem`, `changedFields`, `connector` and `operations` are), but the mapping does not index it (`payload: { enabled: false }`, `AUDIT_EVENTS_MAPPINGS` in `infrastructure/elasticsearch/elasticsearch.constants.ts`), so no search or aggregation reads those fields. The backfill (`indexAuditEvent`) writes the audit entry's own fields: resourceName, targetSystem, description, severity and outcome as well.

Events are bulk-indexed via `ElasticsearchService.bulkIndex()` (buffered, flushed by size or timer), each under its domain event's `eventId`, with the request's `correlationId` as a field. The document id used to be the correlation id, which every event of one request (an HR sync's `identity.created` events) and every event without a request context shares, so they overwrote one another and the index undercounted. The backfill indexes an audit entry of a domain event under the same `eventId` (its `_id` otherwise), so live indexing and a backfill write one document per event.

### Backfill

`POST /analytics/v2/backfill` reads MongoDB `audit_events` collection in batches of 500 and bulk-indexes into ES. Returns `{ indexed, errors }`.

## Data Flow

```
Domain Event → DomainEventEmitter
                 ├─→ AuditService (MongoDB — source of truth)
                 └─→ AnalyticsIndexerService (ES — read model)

v1 GET /analytics/seasonal-patterns
  → PredictiveAnalyticsService → MongoDB aggregation

v2 GET /analytics/v2/seasonal-patterns
  → ES available? → AnalyticsSearchService → ES date_histogram
  → ES unavailable? → PredictiveAnalyticsService → MongoDB fallback

v2 GET /analytics/v2/search
  → ES available? → AnalyticsSearchService.searchAuditEvents() → ES multi_match + filters
  → ES unavailable? → 400 Bad Request
```

## ES Index

Target index: `{prefix}-audit-events` (default: `euroid-audit-events`).

Field mappings defined in `elasticsearch.constants.ts` (`AUDIT_EVENTS_MAPPINGS`):
- keyword: `tenantId`, `action`, `actor`, `resourceType`, `resourceId`, `targetSystem`, `severity`, `outcome`, `correlationId`
- `resourceName` (text, with a `keyword` sub-field), `description` (text, full-text searchable)
- `timestamp` (date), `payload` (object, stored but not indexed: `enabled: false`)

`elasticsearch.constants.ts` also defines an `analytics-forecasts` index (`ES_INDEX.ANALYTICS_FORECASTS`, `ANALYTICS_FORECASTS_MAPPINGS`); no code creates or writes it.

## Fallback Behavior

| Endpoint | ES Available | ES Unavailable |
|----------|-------------|----------------|
| `v2/search` | ES query | 400 error |
| `v2/seasonal-patterns` | ES aggregation | Transparent fallback to v1 (MongoDB) |
| `v2/status` | `{ elasticsearch: true, indexedEvents: N }` | `{ elasticsearch: false, indexedEvents: 0 }` |
| `v2/backfill` | Executes backfill | 400 error |
