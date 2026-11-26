# Graph Database for Entitlements

> **Status:** Partly implemented (2026-11): see Implemented below. The sections after it are the original blueprint.
> **Roadmap:** [ROADMAP.md](../roadmap/ROADMAP.md) | [Data Flows](../core/DATAFLOWS.md)

### Implemented (updated 2026-11-25)
- `backend/src/infrastructure/graph/` (`GraphService`; Neo4j is optional: `NEO4J_URL`, `NEO4J_USER`, `NEO4J_PASSWORD`) and `backend/src/modules/access-explorer/` (the four explorer queries, `POST /api/v1/access-explorer/resync` from MongoDB, the event sync); the page `/access-explorer` ([USER_FLOWS.md](../../USER_FLOWS.md) Flow 24). A process that could not reach Neo4j tries again with a later graph call, at most once per `NEO4J_RECONNECT_INTERVAL_MS` (30 s by default); the readiness probe reports `components.graph`.
- The graph holds `:Identity`, `:Entitlement` (keyed by system and native id, `<system>::<native id>` with the system as the catalog names it, `backend/src/modules/access-explorer/entitlement-node-id.ts`: the catalog is unique on tenant, system and native id, and a native id can repeat in another system; the node keeps `nativeId` and `system`) and `:Application` nodes with `HAS_ACCESS` and `BELONGS_TO` edges. A role-based rule's grant (resync and `provisioning.completed`) and an SoD policy's entitlement are keyed by the entitlement catalog entry of their target on its system, by native id, else by the one entry with a native id that has that name (`entitlement-catalog/catalog-target-lookup.ts`, shared with intelligence), so a group a rule names by display name is the catalog's node; a target the catalog does not know, or names more than once, is keyed by its system and its own id. The event sync listens to `identity.created`, `identity.updated`, `provisioning.completed`, `discovery.completed` (emitted once a discovery is written to the entitlement catalog), `identity.deleted` and `identity.offboarding_completed` (a deleted identity leaves the graph).
- Each connection to Neo4j (the API's and the worker's) creates a uniqueness constraint on `(tenantId, id)` for `:Identity`, `:Entitlement` and `:Application` (`infrastructure/graph/graph-constraints.ts`, `IF NOT EXISTS`): every MERGE finds its node through the constraint's index instead of scanning the label, and two MERGEs at once cannot write one node twice. A constraint that cannot be created because the graph already holds duplicates is logged with what to do: a resync of the tenant removes its duplicate nodes (one of each id stays) and then creates the missing constraints.
- **Group nesting is not modelled.** No group-in-group membership reaches the graph: Entra ID, AD, Okta and SCIM discovery read groups without their members, the catalog has no parent group, and nested (SCIM `indirect`) memberships are read live from the target only in access reviews and the mover, without the group they come through. A SCIM inbound group records a member's type as the IdP sends it (a group pushed as a member of another is a `Group`, `metadata.scimMemberTypes`), but nothing reads that into the graph. Nothing writes `MEMBER_OF`, so the explorer's traversals over it show direct access only. Phase 2's `:MEMBER_OF` edges and Phase 4's inherited SoD need such a source first.
- Not built: `:Role` nodes, `GRANTS`, `NESTED_IN`, accounts in the graph, a graph path in `SodService`.

### Current State (updated 2026-02-19)
- Entitlements stored in MongoDB `entitlement_catalog` collection (flat documents) with governance tags (`PROTECTED`, `MANDATORY`, `FLAGGED`, `REVIEW_REQUIRED`)
- Relationships are implicit: User → Group membership tracked in Entra, not in EuroID
- Nested group resolution requires Entra API calls (expensive, recursive): `EntraService.getUserGroupMemberships()` at `entra.service.ts:572`
- SoD validation fully implemented: `SodService.validate()` (78 lines) detects toxic pairs, BLOCK/WARN modes, integrated with policy engine
- **Risk Scoring now exists** (`modules/risk-scoring/`): 6-factor composite score (0-100) per identity, including SoD violations (25% weight) and high-risk entitlements (25% weight) — computed nightly via Temporal CronWorkflow. Currently uses MongoDB aggregations for multi-hop queries that would benefit from graph traversal.
- **Orphan Detection now exists** (`modules/reconciliation/orphan-detection.service.ts`): detects target-system accounts with no Hub identity — another graph-native use case
- **Recertification Scheduler now exists**: recurring access review campaigns auto-cloned on schedule
- Access Reviews implemented: campaign lifecycle (DRAFT → ACTIVE → COMPLETED), reviewer chain (Manager → Entitlement Owner → Self → Admin), per-entitlement review items, revocation execution workflow
- No "Access Explorer" (who has access to what, access path visualization) capability
- Events available for graph sync: `ENTITLEMENT_UPDATED`, `DISCOVERY_COMPLETED`, `PROVISIONING_COMPLETED`, `ACCESS_REVIEW_ITEM_APPROVED/REVOKED`, `ORPHAN_DETECTED`, `RISK_SCORES_CALCULATED`

### Architecture

```
┌──────────────────┐     ┌─────────────────────┐     ┌──────────────────┐
│ MongoDB          │     │  Sync Service        │     │  Neo4j           │
│ (Entitlement     │────►│  (Event-Driven)      │────►│  (Graph DB)      │
│  Catalog)        │     │                      │     │                  │
│ (Identity Hub)   │────►│  Identity + Entitle- │────►│  (:User)-[:HAS]->│
│                  │     │  ment events         │     │  (:Group)-[:IN]->│
│                  │     │                      │     │  (:App)          │
└──────────────────┘     └─────────────────────┘     └──────────────────┘
                                                            │
                                                     ┌──────┴──────┐
                                                     │ Query API   │
                                                     │ Access Path │
                                                     │ SoD Check   │
                                                     └─────────────┘
```

### Implementation Plan

**Phase 1: Neo4j Integration**
- Add `neo4j-driver` to backend
- Create `backend/src/infrastructure/graph/`:
  - `graph.module.ts` — Neo4j connection (env: `NEO4J_URL`, `NEO4J_USER`, `NEO4J_PASSWORD`)
  - `graph.service.ts` — Cypher query executor
  - `graph.interface.ts` — node/edge types

**Phase 2: Graph Sync Service**
- Create `backend/src/modules/access-explorer/graph-sync.service.ts` (built there):
  - Listen to `ENTITLEMENT_DISCOVERED`, `IDENTITY_UPDATED`, `PROVISIONING_COMPLETED` events
  - On entitlement discovery: create/update `:Entitlement` nodes, `:MEMBER_OF` edges for nested groups
  - On provisioning: create `:Identity`→`:HAS_ACCESS`→`:Entitlement` edges
  - On reconciliation: sync actual group memberships from connector discovery
- Node types: `:Identity`, `:Entitlement`, `:Application`, `:Role`
- Edge types: `[:HAS_ACCESS]`, `[:MEMBER_OF]`, `[:GRANTS]`, `[:NESTED_IN]`

**Phase 3: Access Explorer API**
- Create `backend/src/modules/access-explorer/`:
  - `access-explorer.controller.ts`:
    - `GET /api/v1/access-explorer/identity/:id/graph`: the identity's access graph (direct, and inherited where `MEMBER_OF` edges exist)
    - `GET /api/v1/access-explorer/entitlement/:id/holders`: who has this entitlement
    - `GET /api/v1/access-explorer/path?fromIdentity=&toEntitlement=`: shortest access path
    - `GET /api/v1/access-explorer/identity/:id/sod-violations`: active SoD policies the identity's graph access breaks
    - `POST /api/v1/access-explorer/resync`: rebuild the tenant's graph from MongoDB
  - `access-explorer.service.ts` — Cypher queries for traversal
- Cypher example: `MATCH path = (u:Identity {id: $id})-[:HAS_ACCESS|MEMBER_OF*1..5]->(e:Entitlement) RETURN path`

**Phase 4: Enhanced SoD Validation (Graph-Aware)**
- `SodService.validate()` already handles direct toxic pair detection in MongoDB — Neo4j adds **inherited** group awareness
- Extend `SodService` with a Neo4j query path for transitive SoD:
  - `MATCH (u:Identity)-[:HAS_ACCESS|MEMBER_OF*1..5]->(e1:Entitlement), (u)-[:HAS_ACCESS|MEMBER_OF*1..5]->(e2:Entitlement) WHERE e1.id IN $toxicSetA AND e2.id IN $toxicSetB RETURN u`
- SoD on access review decide (self-approval blocked) already exists — Neo4j enriches this with nested group awareness
- **Note:** Access Review campaigns already track per-entitlement review items; graph queries can power reviewer assignment by entitlement ownership

**Phase 5: Frontend Access Explorer**
- Create `frontend/src/features/access-explorer/`:
  - Graph visualization using React Flow or vis.js
  - Search by identity or entitlement
  - Highlight toxic access paths in red

### Files Changed
| Action | File |
|--------|------|
| New | `backend/src/infrastructure/graph/` (module, service, interfaces) |
| New | `backend/src/modules/access-explorer/graph-sync.service.ts` |
| New | `backend/src/modules/access-explorer/` (controller, service) |
| Modify | `backend/src/modules/policy/sod.service.ts` — Neo4j queries for SoD |
| Modify | `backend/src/modules/access-explorer/access-explorer.module.ts`: register sync |
| New | `frontend/src/features/access-explorer/` |

### Scope Adjustment (2026-02-19)
- **Risk Scoring handles basic SoD counting without Neo4j** — `RiskScoringService` evaluates SoD violations via `PolicyEngineService.evaluateForRiskScoring()` in MongoDB. Graph DB value for SoD shifts to **transitive/inherited** group violations (nested group awareness), not direct pair detection.
- **Orphan Detection works without graph** — `OrphanDetectionService` matches target-system accounts to Hub identities via email/externalId lookup. Graph DB would optimize this with `(:Identity)-[:HAS_ACCOUNT]->(:Account)` traversals and enable orphan discovery across nested group memberships.
- **Primary value of Neo4j is now Access Explorer** — the "who has access to what" visualization and access path queries are the main differentiator over existing MongoDB-based capabilities.

### Dependencies
- Neo4j instance (new infrastructure)
- Event system must emit entitlement/provisioning events

### Implementation Checklist

**Phase 1 — Neo4j Integration**
- [x] Add `neo4j-driver` and create `backend/src/infrastructure/graph/` module (graph.module.ts, graph.service.ts, graph.interface.ts)
- [x] Configure connection via env vars (`NEO4J_URL`, `NEO4J_USER`, `NEO4J_PASSWORD`)

**Phase 2 — Graph Sync**
- [x] Create `graph-sync.service.ts` (in `modules/access-explorer/`; listens to `identity.created`, `identity.updated`, `identity.deleted`, `identity.offboarding_completed`, `discovery.completed`, `provisioning.completed`)
- [ ] Define node types (:Identity, :Entitlement, :Application, :Role) and edge types ([:HAS_ACCESS], [:MEMBER_OF], [:GRANTS], [:NESTED_IN]) (built: `:Identity`, `:Entitlement`, `:Application`, `HAS_ACCESS`, `BELONGS_TO`)

**Phase 3 — Access Explorer API**
- [x] Create `access-explorer` module (controller + service) with Cypher traversal queries
- [x] Implement endpoints: identity access, entitlement holders, access path visualization

**Phase 4 — Enhanced SoD**
- [ ] Extend `SodService` with Neo4j query path for transitive/inherited group SoD detection

**Phase 5 — Frontend**
- [x] Create `frontend/src/features/access-explorer/` with React Flow or vis.js graph visualization
- [ ] Implement search by identity/entitlement and toxic access path highlighting (search is built; the SoD tab lists each violation with its path, the graph view marks no toxic path)
- [x] Add unit and integration tests for graph sync, Cypher queries, and SoD validation
- [x] Update API_CHANGELOG.md and backend README inventory

### Risks
- Data consistency between MongoDB and Neo4j (eventual consistency)
- Neo4j operational overhead
- Graph query performance with very large tenants (millions of edges)
