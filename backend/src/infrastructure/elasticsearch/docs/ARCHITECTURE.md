# Elasticsearch Infrastructure — Architecture

## Overview

Global infrastructure module providing Elasticsearch connectivity for CQRS read-model queries. Follows the same **fail-open** pattern as `GraphModule` (Neo4j): all operations return empty/default results when ES is unavailable, ensuring the platform functions without ES as a hard dependency.

## Components

| File | Purpose |
|------|---------|
| `elasticsearch.service.ts` | Client lifecycle, index management, bulk indexing, search/aggregation executor |
| `elasticsearch.module.ts` | `@Global()` NestJS module — injectable everywhere without explicit import |
| `elasticsearch.constants.ts` | Index name registry and field mappings |
| `config/elasticsearch.config.ts` | Zod-validated env-var configuration |

## Configuration

All settings are env-var driven (see `backend/.env.example`):

| Env Var | Default | Description |
|---------|---------|-------------|
| `ELASTICSEARCH_NODE` | `http://localhost:9200` | ES cluster endpoint |
| `ELASTICSEARCH_USERNAME` | (empty) | Basic auth username (omit for no-auth) |
| `ELASTICSEARCH_PASSWORD` | (empty) | Basic auth password |
| `ELASTICSEARCH_INDEX_PREFIX` | `euroid` | Prefix for all index names (e.g., `euroid-audit-events`) |
| `ELASTICSEARCH_MAX_RETRIES` | `3` | Client retry count |
| `ELASTICSEARCH_REQUEST_TIMEOUT_MS` | `30000` | Per-request timeout |
| `ELASTICSEARCH_BULK_FLUSH_INTERVAL_MS` | `5000` | Timer-based bulk flush interval |
| `ELASTICSEARCH_BULK_FLUSH_SIZE` | `500` | Buffer size triggering immediate flush |

## Fail-Open Pattern

```
ES available?
  YES → execute query → return results
  NO  → return empty/default → caller proceeds normally
```

No exceptions are thrown to callers. All failures are logged as warnings. This means:
- Analytics v1 (MongoDB) continues working even without ES
- v2 endpoints check `isAvailable()` and either use ES or fall back to v1

## Index Strategy

All indices use the format `{prefix}-{suffix}`:
- `euroid-audit-events` — Audit event CQRS read model (indexed from domain events + backfill from MongoDB)
- `euroid-analytics-forecasts` — Reserved for future pre-computed forecast snapshots

## Bulk Indexing

Documents are buffered in memory and flushed when either:
1. Buffer reaches `ELASTICSEARCH_BULK_FLUSH_SIZE` (immediate flush)
2. Timer fires every `ELASTICSEARCH_BULK_FLUSH_INTERVAL_MS`

On module destroy, remaining buffer is flushed before client close.

## Analytics v2 Integration

Two new services in `modules/analytics/`:

| Service | Purpose |
|---------|---------|
| `AnalyticsIndexerService` | Listens to domain events, indexes audit events into ES. Provides `backfillFromMongo()` for historical data. |
| `AnalyticsSearchService` | ES-backed query methods: full-text audit search, date_histogram seasonal patterns, indexed event count. |

### v2 Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/analytics/v2/search` | viewer | Full-text audit event search with filters |
| GET | `/analytics/v2/seasonal-patterns` | viewer | ES-backed seasonal patterns (falls back to v1) |
| GET | `/analytics/v2/status` | viewer | ES availability + the tenant's indexed audit events |
| POST | `/analytics/v2/backfill` | super-admin | Backfill audit events from MongoDB into ES |

### Data Flow

```
Domain Event → DomainEventEmitter
                 ├─→ AuditService (MongoDB write — source of truth)
                 └─→ AnalyticsIndexerService (ES bulk index — read model)

GET /analytics/v2/search
  → AnalyticsSearchService.searchAuditEvents()
    → ElasticsearchService.search() (ES aggregation)
    → Return paginated results

POST /analytics/v2/backfill
  → AnalyticsIndexerService.backfillFromMongo()
    → Read MongoDB audit_events in batches of 500
    → Bulk index into ES
```
