# Data Fabric Virtualization Layer

> **Status:** Not implemented. No phase of this design is in the code (see Current State).
> **Roadmap:** [ROADMAP.md](../roadmap/ROADMAP.md) | [Data Flows](../core/DATAFLOWS.md)

### Current State (updated 2026-11-25)
- Nothing of this design exists: no `backend/src/modules/data-fabric/`, no `attribute_definitions` collection, no virtual resolver, no `fetchAttributes()` on any connector, no `virtualAttributes` manifest capability, no `/api/v1/data-fabric` route and no `data_fabric.*` events
- Redis cache available (when `REDIS_URL` set): rate limiter, JWT admin cache, OAuth token cache, but NOT used for attribute caching (no attribute cache exists)

### Architecture

```
┌──────────────────┐     ┌──────────────────────┐     ┌──────────────────┐
│ Policy Engine    │     │  Data Fabric Layer   │     │  Target Systems  │
│                  │     │                      │     │                  │
│ evaluate(user)   │────►│  Attribute Router    │     │  Entra ID        │
│                  │     │  ┌────────────────┐  │     │  - lastSignIn    │
│                  │◄────│  │ Core (Hub)     │  │     │  - licenseUsage  │
│                  │     │  │ Volatile (JIT) │──┼────►│                  │
│                  │     │  └────────────────┘  │     │  Workday         │
│                  │     │                      │     │  - currentPTO    │
└──────────────────┘     └──────────────────────┘     └──────────────────┘
```

### Implementation Plan

Phases 1–3 were written up as complete in 2026-02, but none of that work is in the code. Read every phase below as a plan.

**Phase 1: Attribute Classification**
- Created `backend/src/modules/data-fabric/` module with Mongoose schema, Zod DTOs, classification service
- Categories: `MATERIALIZED` (stored in Hub), `VIRTUAL` (fetched JIT), `CACHED` (stored with TTL)
- 8 built-in attribute definitions seeded via `seedDefaults()` (4 Entra + 4 AD)

**Phase 2: Virtual Attribute Resolver**
- Created `virtual-resolver.service.ts` with resolution flow: classification lookup → cache → connector fetch → stale fallback
- `resolveAttribute()`, `resolveMultiple()`, `enrichUserForPolicy()` methods
- 2-second configurable timeout via `Promise.race` with stale-cache fallback
- Added `fetchAttributes()` to `IConnector` interface (optional method)

**Phase 3: Connector Attribute Endpoints**
- `EntraClient.fetchAttributes()` — Graph API `$select` with attribute-to-field mapping
- `AdClient.fetchAttributes()` — LDAP search with FILETIME/generalized-time → ISO conversion
- Both connectors declare `'virtualAttributes'` capability in manifest
- Connectors return `null` on error (graceful degradation, dumb pipe pattern)

**Phase 4: Policy Engine Integration**
- Modify `PolicyEngineService.evaluate()`:
  - Before condition evaluation, check if any referenced fields are `virtual`
  - If yes, call `VirtualResolver.enrich(user, requiredVirtualFields)`
  - Enriched user passed to condition evaluation
- Add timeout: if virtual fetch takes > 2s, fall back to last cached/stored value

**Phase 5: Caching Layer**
- Create `backend/src/infrastructure/data-fabric/attribute-cache.service.ts`:
  - Redis-backed cache: key = `attr:${tenantId}:${identityId}:${field}`
  - TTL per attribute (configurable in registry)
  - Cache warming: pre-fetch frequently-used virtual attributes during reconciliation
- Metrics: cache hit rate, virtual fetch latency, fallback rate

### Files Changed (Phases 1–3, planned)
| Action | File |
|--------|------|
| New | `backend/src/modules/data-fabric/` (schema, services, controller, cache, module, tests, docs) |
| New | `backend/src/infrastructure/config/data-fabric.config.ts` |
| Modify | `backend/src/modules/connectors/connector.interface.ts` — add optional `fetchAttributes` |
| Modify | `backend/src/modules/connectors/plugin/connector-manifest.interface.ts` — add `'virtualAttributes'` capability |
| Modify | `backend/src/modules/connectors/entra-connector/entra.client.ts` — add `fetchAttributes` |
| Modify | `backend/src/modules/connectors/entra-connector/entra.service.ts` — add facade delegation |
| Modify | `backend/src/modules/connectors/entra-connector/connector.manifest.ts` — add capability |
| Modify | `backend/src/modules/connectors/ad-connector/ad.client.ts` — add `fetchAttributes` |
| Modify | `backend/src/modules/connectors/ad-connector/ad.service.ts` — add facade delegation |
| Modify | `backend/src/modules/connectors/ad-connector/connector.manifest.ts` — add capability |
| Modify | `backend/src/infrastructure/events/event-types.ts` — 3 new events |
| Modify | `backend/src/app.module.ts` — register DataFabricModule |

### Dependencies
- In-memory `Map` cache (no Redis dependency for attribute caching — can be upgraded later in Phase 5)
- Connector APIs must support selective attribute queries

### Implementation Checklist

**Phase 1 — Attribute Classification**
- [ ] Create `backend/src/modules/data-fabric/` module (attribute-definition.schema.ts, data-fabric.module.ts)
- [ ] Classify all attributes as `MATERIALIZED`, `VIRTUAL`, or `CACHED` with per-field TTL configuration

**Phase 2 — Virtual Attribute Resolver**
- [ ] Create `virtual-resolver.service.ts` (cache check → connector fetch → cache store → return enriched user)
- [ ] Add `fetchAttributes(externalId, attributes[])` to connector interface (optional method)

**Phase 3 — Connector Endpoints**
- [ ] Implement `fetchAttributes()` in `EntraService` and `AdService` (Graph API `$select`, LDAP search)
- [ ] Ensure connectors that don't support JIT queries return `null` gracefully

**Phase 4 — Policy Engine Integration**
- [ ] Modify `PolicyEngineService.evaluate()` to detect virtual fields in conditions and call `VirtualResolver.enrich()`
- [ ] Add 2-second timeout with fallback to last cached/stored value

**Phase 5 — Caching Layer**
- [ ] Create `attribute-cache.service.ts` (Redis-backed with per-attribute TTL)
- [ ] Implement cache warming during reconciliation for frequently-used virtual attributes
- [ ] Add metrics: cache hit rate, virtual fetch latency, fallback rate
- [ ] Add unit and integration tests for resolver, cache, and policy engine enrichment

### Risks
- Latency: JIT queries add 100-500ms to policy evaluation
- Rate limiting: frequent virtual fetches may hit API limits (mitigate with caching)
- Availability: if target system is down, virtual attributes unavailable (fallback to stale data)
