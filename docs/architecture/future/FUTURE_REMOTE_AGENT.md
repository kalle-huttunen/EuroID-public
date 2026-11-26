# Remote Agent Topology (Hybrid Cloud Support)

> **Status:** Partially implemented: the control plane only. `backend/src/modules/agent-management/` registers agents,
> takes heartbeats and marks stale agents offline (`/api/v1/agents`, see its `docs/ARCHITECTURE.md`). The agent itself, the
> task routing to it and mTLS are not built: there is no `packages/` directory and every connector runs in `backend/src/worker.ts`.
> **Roadmap:** [ROADMAP.md](../roadmap/ROADMAP.md) | [Data Flows](../core/DATAFLOWS.md)

### Current State
- Connectors run in-process in `worker.ts` (lines 183-211)
- Direct outbound HTTP to target systems via `EntraClient`
- Customers must open inbound firewall ports for on-prem AD/LDAP

### Architecture

```
┌─────────────────────────────┐          ┌──────────────────────────────────┐
│  EuroID Cloud (Control)     │          │  Customer Network (Execution)    │
│                             │          │                                  │
│  NestJS API ──► Temporal ◄──┼── gRPC ──┼──► Remote Agent Binary           │
│                  Server     │ outbound │    ├─ Entra Client               │
│                             │  only    │    ├─ AD/LDAP Client             │
│                             │          │    └─ Local Connector Sandbox    │
└─────────────────────────────┘          └──────────────────────────────────┘
```

### Implementation Plan

**Phase 1: Agent Protocol Definition**
- Create `backend/src/remote-agent/agent.proto` — gRPC service definition
  - `RegisterAgent(AgentInfo) → AgentRegistration`
  - `PollTasks(AgentId) → stream TaskEnvelope`
  - `ReportResult(TaskResult) → Ack`
- Create `backend/src/remote-agent/agent-protocol.interface.ts` — TypeScript types for task envelopes
- Task envelope wraps: `{ taskId, activityName, payload, tenantId, correlationId }`

**Phase 2: Agent Binary (Execution Plane)**
- Create `packages/remote-agent/` — standalone Node.js binary (or Rust for size)
  - `packages/remote-agent/src/agent.ts` — main loop: gRPC connect → poll → execute → report
  - `packages/remote-agent/src/connector-loader.ts` — loads connector modules from local `plugins/` dir
  - `packages/remote-agent/src/heartbeat.ts` — periodic health reporting to control plane
- Agent connects **outbound** to Temporal directly as a remote worker (Temporal natively supports this)
- Alternative: Agent connects via gRPC to a custom relay that routes Temporal activities

**Phase 3: Temporal Remote Worker Pattern (Preferred)**
- Temporal already supports remote workers natively — the agent IS a Temporal worker
- Create `packages/remote-agent/src/worker.ts`:
  ```
  Worker.create({
    connection: NativeConnection.connect({ address: TEMPORAL_CLOUD_ADDRESS }),
    taskQueue: `agent-${agentId}-${connectorType}`,
    activities: loadConnectorActivities(connectorType),
  })
  ```
- Modify `backend/src/workflows/onboarding.workflow.ts` to route activities to agent-specific task queues based on Blueprint connector config
- Add `executionMode: 'cloud' | 'remote-agent'` to connector manifest

**Phase 4: Agent Management API**
- Create `backend/src/modules/agent-management/`:
  - `agent-management.controller.ts` — CRUD for agents, status dashboard
  - `agent-management.service.ts` — agent registration, heartbeat tracking, health checks
  - `schemas/agent.schema.ts` — `{ agentId, tenantId, connectorTypes[], lastHeartbeat, status, version }`
- Add agent status to frontend: `frontend/src/features/settings/AgentManagement.tsx`

**Phase 5: Security**
- Mutual TLS (mTLS) between agent and Temporal cloud
- Agent bootstrap: generate keypair, CSR → control plane signs → certificate returned
- Agent config encrypted at rest (connector credentials stored locally, never in cloud DB)
- Create `packages/remote-agent/src/crypto/` — certificate management, credential vault

### Files Changed
| Action | File |
|--------|------|
| New | `packages/remote-agent/` (entire package) |
| New | `backend/src/modules/agent-management/` (module) |
| Modify | `backend/src/worker.ts` — add remote task queue routing |
| Modify | Connector manifests — add `executionMode` field |
| Modify | Workflows — route to agent queues when `executionMode === 'remote-agent'` |
| New | `frontend/src/features/settings/AgentManagement.tsx` |

### Dependencies
- None (can be built independently)

### Implementation Checklist

**Phase 1 — Agent Protocol**
- [ ] Create `backend/src/remote-agent/agent.proto` (gRPC service: RegisterAgent, PollTasks, ReportResult)
- [ ] Create `agent-protocol.interface.ts` (TypeScript types for task envelopes)

**Phase 2 — Agent Binary**
- [ ] Create `packages/remote-agent/` package (agent.ts main loop, connector-loader.ts, heartbeat.ts)

**Phase 3 — Temporal Remote Worker**
- [ ] Create `packages/remote-agent/src/worker.ts` (Temporal worker connecting to cloud, agent-specific task queue)
- [ ] Modify workflows to route activities to agent-specific queues based on `executionMode`
- [ ] Add `executionMode: 'cloud' | 'remote-agent'` to connector manifest

**Phase 4 — Agent Management API**
- [x] Create `agent-management` module (controller, service, agent.schema.ts)
- [ ] Create `frontend/src/features/settings/AgentManagement.tsx` (agent status dashboard)

**Phase 5 — Security**
- [ ] Implement mTLS between agent and Temporal cloud (keypair generation, CSR signing)
- [ ] Create `packages/remote-agent/src/crypto/` (certificate management, local credential vault)
- [ ] Add unit and integration tests for agent registration, heartbeat, task routing, and mTLS
- [ ] Update backend README inventory and connector docs

### Risks
- Temporal Cloud connectivity requirements for remote agents
- Agent version management (control plane must handle mixed versions)
