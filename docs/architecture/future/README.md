# Future Architecture Designs

> Architecture designs for features that are not built, or built only in part. The Status column says where each
> stands; each file's own Status line has the detail.
> Prioritized in the [Roadmap](../roadmap/ROADMAP.md).

## Status Legend

| Status | Meaning |
|--------|---------|
| Not implemented (older files: Architecture Blueprint) | Design only, no code |
| Partially implemented | Some phases or parts are built; the file's Status line names them (a phase marked COMPLETE is built) |

## Feature Index

### Evolution Blueprints (from Architecture Evolution Plan)

| File | Feature | Wave | Key Infrastructure | Status |
|------|---------|------|--------------------|--------|
| [FUTURE_EVENT_SOURCING.md](FUTURE_EVENT_SOURCING.md) | Identity event store & time-travel | Wave 1 | MongoDB | Not implemented |
| [FUTURE_CQRS.md](FUTURE_CQRS.md) | CQRS with ElasticSearch read model | Wave 1 | ElasticSearch | Partially implemented (Elasticsearch, audit read model) |
| [FUTURE_IMMUTABLE_AUDIT.md](FUTURE_IMMUTABLE_AUDIT.md) | Merkle trees & WORM audit storage | Wave 1 | S3 Object Lock | Partially implemented (Phases 1-4, most of 5) |
| [FUTURE_GRAPH_DATABASE.md](FUTURE_GRAPH_DATABASE.md) | Neo4j entitlement graph & Access Explorer | Wave 2 | Neo4j | Partially implemented (Access Explorer) |
| [FUTURE_OPA_POLICY.md](FUTURE_OPA_POLICY.md) | Policy-as-Code with OPA/Rego | Wave 2 | OPA | Partially implemented (Phases 1-2, not wired) |
| [FUTURE_DATA_FABRIC.md](FUTURE_DATA_FABRIC.md) | Virtual attribute resolution layer | Wave 2 | Redis | Not implemented |
| [FUTURE_CELL_ARCHITECTURE.md](FUTURE_CELL_ARCHITECTURE.md) | Cell-based physical tenant isolation | Wave 3 | Kubernetes | Not implemented |
| [FUTURE_KEDA_SCALING.md](FUTURE_KEDA_SCALING.md) | Dynamic worker scaling with KEDA | Wave 3 | KEDA + K8s | Not implemented |
| [FUTURE_CONNECTOR_SANDBOX.md](FUTURE_CONNECTOR_SANDBOX.md) | Sandboxed connector execution | Wave 3 | None | Not implemented |
| [FUTURE_REMOTE_AGENT.md](FUTURE_REMOTE_AGENT.md) | Hybrid cloud remote agent topology | Wave 4 | gRPC / Temporal Cloud | Partially implemented (control plane) |
| [FUTURE_SHARED_HOSTING.md](FUTURE_SHARED_HOSTING.md) | Several customers in one installation | Wave 4 | Remote agent, Cells | Partially implemented (logical tenant isolation) |

### Capability Gap Designs

| File | Feature | Priority | Status |
|------|---------|----------|--------|
| [FUTURE_SIEM_INTEGRATION.md](FUTURE_SIEM_INTEGRATION.md) | SIEM webhook event delivery (OCSF) | P0 | Partially implemented (webhooks) |
| [FUTURE_SHARED_SIGNALS.md](FUTURE_SHARED_SIGNALS.md) | OpenID SSF/CAEP signal exchange | P1 | Not implemented |
| [FUTURE_CREDENTIAL_LIFECYCLE.md](FUTURE_CREDENTIAL_LIFECYCLE.md) | Credential rotation & vault integration | P1 | Partially implemented (inventory, no reset) |
| [FUTURE_AI_ACCESS_INTELLIGENCE.md](FUTURE_AI_ACCESS_INTELLIGENCE.md) | ML-based access intelligence | P1 | Partially implemented (Phase 1) |
| [FUTURE_CIEM.md](FUTURE_CIEM.md) | Cloud infrastructure entitlement management | P2 | Not implemented |
| [FUTURE_SESSION_JIT_ACCESS.md](FUTURE_SESSION_JIT_ACCESS.md) | Session-based just-in-time access | P2 | Not implemented |
| [FUTURE_IDENTITY_VERIFICATION.md](FUTURE_IDENTITY_VERIFICATION.md) | Out-of-band identity proofing | P2 | Not implemented |
| [FUTURE_IDENTITY_ENTITLEMENT_MAP.md](FUTURE_IDENTITY_ENTITLEMENT_MAP.md) | Identity-entitlement graph visualization | P2 | Partially implemented (Phase 1, drift actions) |

## Dependencies Between Features

```
Event Sourcing ──> CQRS ──> Cell Architecture
               ──> Immutable Audit (Phases 2-5)
               ──> Graph DB ──> OPA Policy
                            ──> Data Fabric

KEDA Scaling ──> (independent)
Connector Sandbox ──> Remote Agent
SIEM Integration ──> Shared Signals
Credential Lifecycle ──> Session JIT Access
```

## Lifecycle

When a future doc becomes implemented:
1. Move from `future/` to the new module's `docs/` folder
2. Rename from `FUTURE_*.md` to `ARCHITECTURE.md` (or topic-specific name)
3. Update this index and `docs/DOCUMENTATION_STRATEGY.md`

See `docs/DOCUMENTATION_STRATEGY.md` for full lifecycle rules.
