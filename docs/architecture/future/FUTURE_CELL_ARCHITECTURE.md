# Cell-Based Architecture (Physical Isolation)

> **Status:** Architecture Blueprint (not yet implemented)
> **Roadmap:** [ROADMAP.md](../roadmap/ROADMAP.md) | [Data Flows](../core/DATAFLOWS.md)

### Current State (updated 2026-02-17)
- Logical multi-tenancy via Mongoose `TenantPlugin` (AsyncLocalStorage), JWT `tenantId` claim, Temporal workflow prefix `t-{tenantId}-`
- Shared MongoDB with configurable pool: `MONGO_MAX_POOL_SIZE` (default 20), `MONGO_MIN_POOL_SIZE` (default 5), write concern `majority`
- Redis distributed cache (optional, via `REDIS_URL`): rate limiter, JWT admin cache (30s TTL), OAuth token cache for Entra/SCIM
- Circuit breakers (cockatiel): per tenant, connector and target, trips after 5 consecutive 5xx or network failures, half-open after 30s, emits `connector.circuit_breaker_tripped`
- Prometheus metrics: `euroid_circuit_breaker_trips_total`, `euroid_circuit_breaker_state`
- Single worker process with bulkhead isolation: default queue + per-connector dynamic queues via `PluginRegistryService` (`worker.ts:227-247`)
- `INFRASTRUCTURE_SCALING.md` describes Cell concept as ROADMAP

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Ingress Gateway (Nginx / Envoy)                                │
│  Route: tenantId → Cell endpoint                                │
├─────────────────────┬───────────────────┬───────────────────────┤
│  Shared Cell        │  Premium Cell A   │  Premium Cell B       │
│  (Standard tenants) │  (Acme Corp)      │  (BigBank Inc)        │
│                     │                   │                       │
│  NestJS API         │  NestJS API       │  NestJS API           │
│  MongoDB (shared)   │  MongoDB (ded.)   │  MongoDB (ded.)       │
│  Temporal Workers   │  Temporal Workers │  Temporal Workers     │
│  ElasticSearch      │  ElasticSearch    │  ElasticSearch        │
└─────────────────────┴───────────────────┴───────────────────────┘
```

### Implementation Plan

**Phase 1: Cell Configuration Schema**
- Create `backend/src/infrastructure/cell/`:
  - `cell.config.ts` — Cell definition: `{ cellId, mongoUri, temporalAddress, temporalNamespace, esUrl }`
  - `cell-registry.service.ts` — maps tenantId → Cell config
  - `cell.module.ts` — provides cell-aware connection factories
- Add to tenant schema: `cellId` field (default: `shared`)

**Phase 2: Dynamic Connection Factories**
- Modify Mongoose connection to be cell-aware:
  - `backend/src/infrastructure/cell/cell-mongoose.provider.ts` — returns connection for tenant's cell
  - Use Mongoose `createConnection()` per unique `mongoUri` (connection pooled)
- Modify Temporal worker creation in `worker.ts`:
  - Read cell configs → create one worker set per cell
  - Each cell gets its own `NativeConnection` + `Worker` instances

**Phase 3: Ingress Routing**
- Create `infra/nginx/cell-router.conf` — route by `X-Tenant-Id` header or JWT claim
- Alternative: NestJS middleware that resolves cell and sets connection context
- Create `backend/src/infrastructure/cell/cell-routing.middleware.ts`

**Phase 4: Cell Lifecycle Management**
- Create `backend/src/modules/cell-management/`:
  - `cell-management.controller.ts` — create/update/delete cells (super-admin)
  - `cell-management.service.ts` — provision new cells (create MongoDB, configure Temporal namespace)
  - `cell-migration.service.ts` — migrate tenant from shared → dedicated cell
- Migration process: snapshot tenant data → restore to new cell → update routing → verify → cutover

**Phase 5: Monitoring Per Cell**
- Prometheus metrics with `cell_id` label
- Per-cell dashboards in Grafana
- Cell health checks: `GET /api/v1/cells/:cellId/health`

### Files Changed
| Action | File |
|--------|------|
| New | `backend/src/infrastructure/cell/` (config, registry, module, providers) |
| New | `backend/src/modules/cell-management/` (controller, service, migration) |
| Modify | `backend/src/worker.ts` — cell-aware worker creation |
| Modify | `backend/src/app.module.ts` — cell-aware Mongoose provider |
| New | `infra/nginx/cell-router.conf` |
| Modify | Tenant schema — add `cellId` field |

### Dependencies
- Infrastructure automation (Terraform/Pulumi) for provisioning new cells
- Improvement 2 (CQRS) — ElasticSearch per cell

### Implementation Checklist

**Phase 1 — Cell Configuration**
- [ ] Create `backend/src/infrastructure/cell/` module (cell.config.ts, cell-registry.service.ts, cell.module.ts)
- [ ] Add `cellId` field to tenant schema (default: `shared`)

**Phase 2 — Dynamic Connection Factories**
- [ ] Implement `cell-mongoose.provider.ts` (cell-aware Mongoose connection via `createConnection()`)
- [ ] Modify `worker.ts` to create per-cell Temporal worker sets with separate `NativeConnection` instances

**Phase 3 — Ingress Routing**
- [ ] Create `infra/nginx/cell-router.conf` (route by `X-Tenant-Id` or JWT claim)
- [ ] Create `cell-routing.middleware.ts` (NestJS middleware for cell resolution)

**Phase 4 — Cell Lifecycle Management**
- [ ] Create `cell-management` module (controller, service, migration service)
- [ ] Implement tenant migration flow: snapshot, restore, update routing, verify, cutover

**Phase 5 — Monitoring**
- [ ] Add `cell_id` label to Prometheus metrics and create per-cell Grafana dashboards
- [ ] Implement cell health check endpoint (`GET /api/v1/cells/:cellId/health`)
- [ ] Add unit and integration tests for cell registry, routing, and migration

### Risks
- Operational complexity: N cells = N sets of infrastructure to monitor
- Connection pool explosion if too many cells with individual MongoDB connections
- Cross-cell queries (global admin dashboard) require aggregation across cells
