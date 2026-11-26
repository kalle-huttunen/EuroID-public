# Agent Management — Architecture

> **Module:** Agent Management (Extended Pillar — Remote Topology)
> **Cross-cutting:** [Temporal Workflows](../../../../../docs/architecture/infrastructure/TEMPORAL_WORKFLOWS.md) | [Task Queues](../../../infrastructure/temporal/docs/TASK_QUEUES.md)

## Overview

Manages remote agent lifecycle for hybrid-cloud deployments where connectors run on-premises behind customer firewalls. This module is the control plane only: an agent registers through it, sends periodic heartbeats, and is automatically marked offline when heartbeats go stale.
The agent itself (a standalone Temporal worker, planned as `@euroid/remote-agent`) is not built: the repository has no such package and no agent binary, and every connector runs in `backend/src/worker.ts`.

## Components

| File | Purpose |
|------|---------|
| `agent.schema.ts` | Mongoose schema — `agents` collection with compound index on `(tenantId, agentId)` |
| `agent.dto.ts` | Zod DTOs: `RegisterAgentDto`, `HeartbeatDto` |
| `agent-management.config.ts` | Env-var driven config (`AGENT_HEARTBEAT_INTERVAL_SECONDS`, etc.) |
| `agent-management.service.ts` | Core service — register, heartbeat, list, status summary, decommission, stale detection |
| `agent-management.controller.ts` | REST API (6 endpoints under `/api/v1/agents`) |
| `agent-management.module.ts` | NestJS module |

## API Endpoints

| Method | Path | Role | Description |
|--------|------|------|-------------|
| POST | `/agents/register` | super-admin | Register a new remote agent |
| POST | `/agents/:agentId/heartbeat` | operator | Agent heartbeat ping |
| GET | `/agents` | super-admin | List agents for tenant |
| GET | `/agents/status` | super-admin | Status summary (online/offline/degraded counts) |
| GET | `/agents/:agentId` | super-admin | Agent details |
| DELETE | `/agents/:agentId` | super-admin | Decommission agent |

## Data Model

```
agents collection
├── agentId          (unique per tenant, format: agent-{uuid})
├── tenantId         (indexed)
├── name             (human-readable label)
├── status           (online | offline | degraded | decommissioned)
├── connectorTypes   (string[] — which connectors this agent can run)
├── taskQueue        (Temporal task queue name for routing)
├── lastHeartbeat    (Date — updated on each heartbeat)
├── version          (agent binary version)
├── metadata         (Record<string, unknown> — custom labels)
├── certificate      (mTLS certificate for secure comms)
├── registeredAt     (Date)
└── decommissionedAt (Date — set on decommission)
```

Indexes: `(tenantId, agentId)` unique, `(tenantId, status)` for filtered queries. `agentId` is not unique across tenants: two tenants may use the same id, and migration `20261122000000-agent-id-per-tenant-unique` drops the global `agentId_1` index older deployments have.

## Heartbeat Protocol

1. Agent sends `POST /agents/:agentId/heartbeat` every `AGENT_HEARTBEAT_INTERVAL_SECONDS` (default 30s)
2. Heartbeat payload optionally updates `status`, `version`, and `metadata`
3. Service records `lastHeartbeat = now()` and returns updated agent document

## Stale Detection

A background poller runs every `AGENT_STALE_CHECK_INTERVAL_MS` (default 15s):

```
threshold = now - (HEARTBEAT_INTERVAL_SECONDS × STALE_THRESHOLD_MULTIPLIER)

UPDATE agents
  SET status = 'offline'
  WHERE status IN ('online', 'degraded')
    AND lastHeartbeat < threshold
```

Default: agents missing heartbeats for 90s (30s × 3) are marked offline.

A check that fails (MongoDB unreachable) is logged as an error and the next interval tries again; it never ends the API process.

## Configuration

| Env Var | Default | Description |
|---------|---------|-------------|
| `AGENT_HEARTBEAT_INTERVAL_SECONDS` | `30` | Expected heartbeat interval |
| `AGENT_STALE_THRESHOLD_MULTIPLIER` | `3` | Multiplier before marking stale |
| `AGENT_STALE_CHECK_INTERVAL_MS` | `15000` | Poller interval |
| `AGENT_MAX_PER_TENANT` | `50` | Max agents per tenant |

## Domain Events

| Event | Emitted When |
|-------|-------------|
| `connector.health_changed` | Agent registered (status: online) |
| `connector.health_changed` | Agent decommissioned |

## Guard Rails

- **Max per tenant**: Registration fails with 400 if tenant already has `AGENT_MAX_PER_TENANT` non-decommissioned agents
- **Duplicate protection**: MongoDB unique index on `(tenantId, agentId)` — duplicate registration returns 409
- **Decommission is soft-delete**: Status set to `decommissioned`, document retained for audit. Decommissioned agents cannot receive heartbeats (returns 404)
