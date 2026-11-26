# Dynamic Worker Scaling (KEDA)

> **Status:** Architecture Blueprint (not yet implemented)
> **Roadmap:** [ROADMAP.md](../roadmap/ROADMAP.md) | [Data Flows](../core/DATAFLOWS.md)

### Current State (updated 2026-02-19)
- Single worker process (`worker.ts`) creates all workers at startup
- Default queue worker + per-connector bulkhead workers dynamically created from `PluginRegistryService.getAll()`
- **3 new Temporal scheduled workflows added since last review:**
  - `riskScoreCalculationWorkflow` — nightly batch (cron: `RISK_SCORE_CRON`, default 2 AM)
  - `recertificationSchedulerWorkflow` — daily campaign cloning (cron: `RECERTIFICATION_CRON`, default 2 AM)
  - `orphanCleanupWorkflow` — signal-driven per-orphan lifecycle (spawned on `ORPHAN_DETECTED`)
- **3 new activity modules:** `RiskScoreActivities`, `RecertificationActivities`, `OrphanActivities`
- Workers run `Promise.all(workers.map(w => w.run()))` — no dynamic scaling
- Activity interceptors: `RateLimitActivityInterceptor` + optional OpenTelemetry inbound/outbound interceptors
- TLS/mTLS support for Temporal connection
- Workflow bundle pre-built for production via `bundleWorkflowCode()`
- No queue depth monitoring, no KEDA
- Manual scaling: restart with more processes

### Architecture

```
┌──────────────────┐     ┌───────────────┐     ┌──────────────────┐
│ Temporal Server   │     │  KEDA         │     │  Kubernetes      │
│                   │     │  ScaledObject │     │  Deployment      │
│ Task Queue Depth ─┼────►│               │────►│                  │
│ provisioning-entra│     │  If depth > 5 │     │  worker-entra    │
│ = 150 pending     │     │  scale to 50  │     │  replicas: 50    │
│                   │     │               │     │                  │
│ reconciliation    │     │  If depth = 0 │     │  worker-recon    │
│ = 0 pending       │     │  scale to 0   │     │  replicas: 0     │
└──────────────────┘     └───────────────┘     └──────────────────┘
```

### Implementation Plan

**Phase 1: Worker Decomposition**
- Split `worker.ts` into per-queue worker entrypoints:
  - `backend/src/workers/worker-default.ts` — default queue (workflows + generic activities)
  - `backend/src/workers/worker-entra.ts` — Entra connector activities
  - `backend/src/workers/worker-reconciliation.ts` — reconciliation + orphan detection activities
  - `backend/src/workers/worker-risk-scoring.ts` — nightly risk score batch (can scale to 0 outside schedule)
  - `backend/src/workers/worker-recertification.ts` — recertification scheduler (lightweight, can share with default)
- Each worker file is a standalone process that can be scaled independently
- Shared: `backend/src/workers/worker-base.ts` — common setup (OTel, connection, bundle)
- **Note:** `worker.ts` already has the bulkhead pattern (per-connector workers on separate queues) — decomposition extracts these into standalone entrypoints. 3 new activity modules (risk-score, recertification, orphan) add to the decomposition surface.
- **Scheduling note:** Risk scoring and recertification workflows are CronWorkflow-based (nightly/daily). KEDA `minReplicaCount: 0` is ideal for these — scale up when cron fires, scale to zero between runs.

**Phase 2: Kubernetes Deployments**
- Create `infra/k8s/workers/`:
  - `worker-default.deployment.yaml`
  - `worker-entra.deployment.yaml`
  - `worker-reconciliation.deployment.yaml`
- Each deployment: separate resource limits, separate HPA baseline

**Phase 3: KEDA ScaledObject Definitions**
- Create `infra/k8s/keda/`:
  - `scaledobject-entra.yaml`:
    ```yaml
    triggers:
      - type: temporal
        metadata:
          queue: provisioning-entra
          targetQueueDepth: "5"
    minReplicaCount: 0
    maxReplicaCount: 100
    ```
  - Similar for each task queue
- KEDA Temporal scaler: polls Temporal API for pending task count

**Phase 4: Custom KEDA Scaler (if needed)**
- If no official KEDA Temporal scaler exists:
  - Create `infra/keda-scaler/temporal-scaler/`:
    - gRPC external scaler that queries Temporal `DescribeTaskQueue` API
    - Returns `{ isActive, metricValue: pendingTaskCount }`
- Alternative: expose task queue metrics via Prometheus → use KEDA Prometheus scaler

**Phase 5: Observability**
- Add Prometheus metrics: `temporal_task_queue_depth{queue, namespace}`
- Grafana dashboard: queue depth over time, worker count, scaling events
- Alerting: if queue depth > threshold for > 5 minutes despite scaling

### Files Changed
| Action | File |
|--------|------|
| New | `backend/src/workers/` (per-queue worker entrypoints) |
| New | `backend/src/workers/worker-base.ts` (shared setup) |
| Modify | `backend/src/worker.ts` — refactor to use worker-base |
| New | `infra/k8s/workers/` (Kubernetes deployments) |
| New | `infra/k8s/keda/` (ScaledObject definitions) |
| New | `infra/keda-scaler/` (custom scaler if needed) |
| Modify | `backend/package.json` — add worker scripts |

### Dependencies
- Kubernetes cluster
- KEDA installed in cluster
- Temporal metrics endpoint accessible

### Implementation Checklist

**Phase 1 — Worker Decomposition**
- [ ] Create `backend/src/workers/worker-base.ts` (shared setup: OTel, connection, bundle)
- [ ] Create per-queue worker entrypoints (worker-default, worker-entra, worker-reconciliation, worker-risk-scoring, worker-recertification)
- [ ] Refactor `worker.ts` to use `worker-base` and update `package.json` with worker scripts

**Phase 2 — Kubernetes Deployments**
- [ ] Create `infra/k8s/workers/` deployment manifests (one per worker type with separate resource limits)

**Phase 3 — KEDA ScaledObject Definitions**
- [ ] Create `infra/k8s/keda/` ScaledObject YAMLs for each task queue (with `targetQueueDepth`, `minReplicaCount`, `maxReplicaCount`)
- [ ] Configure `minReplicaCount: 0` for scheduled-only workers (risk-scoring, recertification)

**Phase 4 — Custom KEDA Scaler (if needed)**
- [ ] Create custom gRPC external scaler for Temporal `DescribeTaskQueue` API (or use Prometheus-based scaler)

**Phase 5 — Observability**
- [ ] Add Prometheus metrics: `temporal_task_queue_depth{queue, namespace}`
- [ ] Create Grafana dashboard: queue depth, worker count, scaling events
- [ ] Add alerting for queue depth exceeding threshold despite scaling
- [ ] Add integration tests for worker decomposition and task routing

### Risks
- Cold start latency: scaling from 0 → N takes time (mitigate with `minReplicaCount: 1` for critical queues)
- Temporal worker registration lag when new workers join
- Workflow bundle must be pre-built for fast startup (already handled for production via `bundleWorkflowCode()` at `worker.ts:178-192`)
- Rate limiter state: `RateLimitActivityInterceptor` uses Redis when available — scaled workers share rate limit state correctly. In-memory fallback would not share state across pods.
