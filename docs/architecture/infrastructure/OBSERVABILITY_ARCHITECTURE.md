---
Last updated: 2026-02-23
---

# Observability Architecture - The 2026 Standard

## The Core Problem

**"You cannot fix what you cannot see."**

* **Scenario:** A batch onboarding of 200 users fails at 3 AM. The Entra connector timed out, Temporal retried 50 times, and 30 users are in a half-provisioned state. You have no idea which users, which step, or why.
* **Today:** You grep NestJS console logs across two terminal windows.
* **The Fix:** **Structured Logging + Distributed Tracing + Metrics.** Every request gets a trace ID. Every log line is JSON. Every operation is measured.

---

## Observability Landmines (Critical Safety Protocol)

### Landmine 1: The "Log Everything" Performance Killer

* **The Trap:** You log the full `StandardUserDto` (including PII) on every identity operation at DEBUG level.
* **The Explosion:** Logs grow 50GB/day. MongoDB queries slow down because every request triggers 10 log writes. Worse: PII leaks into your logging platform.
* **The 2026 Fix: Log Levels + PII Redaction.**
  * **Production default:** `info` level. `debug` only in dev or per-request via header.
  * **PII fields** (`email`, `firstName`, `lastName`, `socialSecurityNumber`) are automatically redacted in log output. Only the `identityId` (UUID) appears in logs.

### Landmine 2: The "Missing Correlation" Debugging Nightmare

* **The Trap:** The API logs say "Policy evaluated." The worker logs say "Provisioning failed." But you cannot connect the two because they have no shared identifier.
* **The Explosion:** Debugging takes hours instead of seconds. You resort to timestamp correlation (unreliable across time zones and clock skew).
* **The 2026 Fix: Correlation ID Propagation.**
  * Every inbound HTTP request gets a `correlationId` (from header `X-Correlation-ID` or auto-generated UUID).
  * The ID propagates through: NestJS → Temporal workflow → Activities → Connector API calls → Audit log entries.
  * Every log line includes `correlationId`.

### Landmine 3: The "Metric Explosion" (Cardinality Bomb)

* **The Trap:** You add a metric label `userId` to every counter. With 50,000 users, Prometheus stores 50,000 time series per metric.
* **The Explosion:** Prometheus OOMs. Grafana dashboards take 30 seconds to load.
* **The 2026 Fix: Bounded Labels Only.**
  * Labels must be low-cardinality: `connector` (5-10 values), `status` (success/failure), `severity` (low/medium/high/critical).
  * **Never** use `userId`, `email`, or `workflowId` as a metric label. Those belong in traces and logs.

---

## Architecture Overview

```
    ┌─────────────── Application Layer ───────────────────────────────┐
    │                                                                  │
    │  NestJS API ──▶ Structured Logger (Winston/Pino) ──▶ stdout     │
    │       │              │                                           │
    │       │         correlationId in every line                      │
    │       │                                                          │
    │  Temporal Worker ──▶ Activity Logger ──▶ stdout                  │
    │       │              │                                           │
    │       │         workflowId + correlationId                       │
    │       │                                                          │
    │  Connectors ──▶ HTTP Client Logger ──▶ stdout                   │
    │                  │                                               │
    │             latency + status code + connector name               │
    └──────────────────────────┬───────────────────────────────────────┘
                               │ JSON lines to stdout
                               ▼
    ┌─────────────── Collection Layer ────────────────────────────────┐
    │                                                                  │
    │  Option A (Simple): Docker logs → file rotation                  │
    │  Option B (Prod):   Fluentd/Vector → Loki / Elasticsearch       │
    │                                                                  │
    └──────────────────────────┬───────────────────────────────────────┘
                               │
    ┌─────────────── Visualization Layer ─────────────────────────────┐
    │                                                                  │
    │  Grafana:  Dashboards (metrics) + Log explorer + Trace viewer    │
    │  OR: Datadog / New Relic (managed alternative)                   │
    │                                                                  │
    └─────────────────────────────────────────────────────────────────┘
```

---

## The Three Pillars

### Pillar 1: Structured Logging

Replace all `console.log` and default NestJS `Logger` usage with a structured JSON logger. The project already has `winston` and `nest-winston` in `package.json` — they just need to be wired up.

#### Log Format (Every Line)

```json
{
  "timestamp": "2026-02-12T14:30:00.123Z",
  "level": "info",
  "message": "Policy evaluated for identity",
  "service": "PolicyEngineService",
  "correlationId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "identityId": "550e8400-e29b-41d4-a716-446655440000",
  "context": {
    "matchedPolicies": 3,
    "generatedOperations": 5,
    "durationMs": 42
  }
}
```

#### Standard Fields (Required in Every Log Line)

| Field | Source | Purpose |
|-------|--------|---------|
| `timestamp` | Auto (Winston) | When |
| `level` | Code (`info`, `warn`, `error`, `debug`) | Severity |
| `message` | Code | Human-readable summary |
| `service` | Class name | Which component |
| `correlationId` | Request context (see below) | Cross-service tracing |

#### Optional Fields (Include When Available)

| Field | When to Include |
|-------|----------------|
| `identityId` | Any operation on an identity |
| `connectorName` | Connector operations (`entra-id`, `ad`, `okta`) |
| `workflowId` | Inside Temporal activities |
| `workflowRunId` | Inside Temporal activities |
| `durationMs` | Any timed operation |
| `error` | Error log lines (structured: `{ message, stack, code }`) |

#### PII Redaction

`piiRedactFormat` (`backend/src/infrastructure/observability/pii-redact.format.ts`, a Winston format) walks the log object and replaces the value of every PII key with `[REDACTED]`, at any depth; `safeLog()` does the same before it stringifies an object for a message. The keys are the names, contact data, identifiers and secrets in `PII_FIELDS` there (`firstName`, `lastName`, `name`, `displayName`, `email`, `personalEmail`, `managerEmail`, `phone`, `mobilePhone`, `workPhone`, `sourceUserId`, `employeeId`, `empId`, `userPrincipalName`, `password`, `token` and more). A key is compared normalized, lowercase with letters and digits only, so `First Name`, `E-mail`, `EmpID` and `FIRST_NAME` in an HR row match too.

The redaction works on keys only: the text of a message is not scanned. A log line that names a person puts the address through `maskEmail` or `maskEmails` (`modules/identity/identity-pii.ts`, `activities/deprovision-failure.ts`) itself; `infrastructure/observability/log-pii.spec.ts` fails on a logger template that interpolates an email-named value (or an orphan's `accountIdentifier`) in clear. It also reads workflow code, whose `log` from `@temporalio/workflow` goes to Temporal's runtime logger, which nothing redacts: workflow log lines name the person by identity id (an orphan by its drift id), never by email or phone number. It reads template text only, not the attributes object of a log call.

The API (`main.ts`) and the Temporal worker (`worker.ts` through `worker-context.ts`) both log through `createLoggerConfig()`, so the redaction applies to activity and service logs in the worker as well. Temporal's own worker and workflow logs (`log` from `@temporalio/workflow`) go through Temporal's default runtime logger to stderr and are not redacted. `LOG_PII_REDACT=false` turns the redaction off for local development.

#### Logger Setup

```typescript
// backend/src/infrastructure/observability/logger.config.ts

import { WinstonModule, utilities } from 'nest-winston';
import * as winston from 'winston';
import { piiRedactFormat } from './pii-redact.format';

export function createLoggerConfig() {
  const isProduction = process.env.NODE_ENV === 'production';

  return WinstonModule.createLogger({
    transports: [
      new winston.transports.Console({
        level: isProduction ? 'info' : 'debug',
        format: isProduction
          ? winston.format.combine(
              winston.format.timestamp(),
              piiRedactFormat(),       // Redact PII
              winston.format.json(),   // JSON for production
            )
          : winston.format.combine(
              winston.format.timestamp(),
              utilities.format.nestLike('EuroID', { prettyPrint: true }),
            ),
      }),
    ],
  });
}
```

Wire into `main.ts`:

```typescript
// backend/src/main.ts (change)
const app = await NestFactory.create(AppModule, {
  logger: createLoggerConfig(),
});
```

---

### Pillar 2: Correlation ID Propagation

Every request needs a correlation ID that flows through the entire processing chain.

#### HTTP Layer (NestJS Middleware)

```typescript
// backend/src/infrastructure/middleware/correlation.middleware.ts

import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';

// Shared context for the entire request lifecycle
export const requestContext = new AsyncLocalStorage<RequestContext>();

export interface RequestContext {
  correlationId: string;
  identityId?: string;    // Set when the request targets a specific identity
  startTime: number;
}

@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    const correlationId =
      (req.headers['x-correlation-id'] as string) || randomUUID();

    // Echo back to the caller
    res.setHeader('X-Correlation-ID', correlationId);

    const ctx: RequestContext = {
      correlationId,
      startTime: Date.now(),
    };

    requestContext.run(ctx, () => next());
  }
}
```

#### Temporal Layer (Activity Context)

When a Temporal workflow starts (triggered by an API call), the correlation ID is passed as a workflow argument or search attribute. Activities read it from the workflow context.

```typescript
// In the workflow (deterministic — reads from input, not generated)
export async function onboardingWorkflow(
  input: OnboardingInput & { correlationId: string }
) {
  // Pass correlationId to every activity call
  await identityActivities.createIdentity({
    ...input,
    correlationId: input.correlationId,
  });
}

// In the activity (side-effect — can use the logger)
async createIdentity(input: CreateIdentityInput) {
  const logger = this.logger;
  logger.log({
    message: 'Creating identity in Hub',
    correlationId: input.correlationId,
    identityId: input.identityId,
  });
  // ...
}
```

#### Outbound HTTP (Connector Clients)

Connector clients (e.g., `entra.client.ts`) include the correlation ID as a header on outbound API calls. This allows target system logs to be correlated with EuroID operations.

```typescript
// Inside EntraClient.getHeaders()
private async getHeaders(): Promise<Record<string, string>> {
  const ctx = requestContext.getStore();
  return {
    Authorization: `Bearer ${await this.getToken()}`,
    'Content-Type': 'application/json',
    ...(ctx?.correlationId && { 'X-Correlation-ID': ctx.correlationId }),
  };
}
```

---

### Pillar 3: Metrics

Key operational metrics exported via Prometheus-compatible endpoint or OpenTelemetry Collector.

#### Metric Definitions

| Metric Name | Type | Labels | What It Tells You |
|-------------|------|--------|-------------------|
| `euroid_http_requests_total` | Counter | `method`, `route`, `status_code` | API traffic patterns and error rates: `status_code` is the status the response got (an exception's 4xx or 5xx included), recorded when the response is sent (`HttpMetricsInterceptor`) |
| `euroid_http_request_duration_ms` | Histogram | `method`, `route`, `status_code` | API latency (P50, P95, P99) until the response is sent |
| `euroid_provisioning_total` | Counter | `connector`, `status` | Provisioning success/failure rates per connector |
| `euroid_provisioning_duration_ms` | Histogram | `connector` | How long provisioning takes per connector |
| `euroid_drift_detected_total` | Counter | `system`, `severity` | Drift frequency and severity distribution |
| `euroid_policy_evaluation_duration_ms` | Histogram | — | Policy engine performance |
| `euroid_policy_evaluation_total` | Counter | `matched_policies` (bucketed: 0, 1-5, 5+) | How many policies fire per evaluation |
| `euroid_connector_api_calls_total` | Counter | `connector`, `endpoint`, `status` | External API call patterns |
| `euroid_connector_api_latency_ms` | Histogram | `connector` | External API response times |
| `euroid_circuit_breaker_trips_total` | Counter | `breaker_name` | When safety mechanisms activate |
| `euroid_identities_total` | Gauge | `status` | Identities per profile status in all tenants (soft-deleted as `DELETED`), counted in MongoDB at each scrape |
| `euroid_access_requests_pending` | Gauge | — | Access requests waiting for approval in all tenants, counted in MongoDB at each scrape |
| `euroid_access_review_campaigns_active` | Gauge | — | Access review campaigns in status `ACTIVE` in all tenants, counted in MongoDB at each scrape |

#### Implementation Approach

**Phase 1 (Simple):** Use `prom-client` (the standard Prometheus client for Node.js). Expose metrics at `GET /metrics` (outside the `/api/v1` prefix — Prometheus scrapes this directly).

```typescript
// backend/src/infrastructure/observability/metrics.service.ts

import { Injectable } from '@nestjs/common';
import { Counter, Histogram, Gauge, Registry } from 'prom-client';

@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  readonly provisioningTotal: Counter;
  readonly provisioningDuration: Histogram;
  readonly driftDetected: Counter;
  readonly connectorApiLatency: Histogram;

  constructor() {
    this.provisioningTotal = new Counter({
      name: 'euroid_provisioning_total',
      help: 'Total provisioning operations',
      labelNames: ['connector', 'status'],
      registers: [this.registry],
    });

    this.provisioningDuration = new Histogram({
      name: 'euroid_provisioning_duration_ms',
      help: 'Provisioning duration in milliseconds',
      labelNames: ['connector'],
      buckets: [100, 500, 1000, 2000, 5000, 10000, 30000],
      registers: [this.registry],
    });

    // ... other metrics
  }
}
```

**Phase 2 (OpenTelemetry):** The project now uses OTel for distributed tracing. Prometheus metrics remain via `prom-client`; OTel handles traces (HTTP, MongoDB, Temporal activities). See Phase 3: Distributed Tracing below.

---

## Reliability Patterns

### Transactional Outbox

To prevent "Ghost Events" (DB committed but Event Bus failed):

1. **Transaction:** Save `Identity` AND save `OutboxEvent` in the same MongoDB transaction.
2. **Relay:** `OutboxPollerService` (`infrastructure/events/outbox-poller.service.ts`) reads `event_outbox` (change streams on a replica set, else polling) and re-emits each event on the in-process event bus.

### Event-Driven Autoscaling (KEDA)

Temporal Workers scale based on **Task Queue Depth**, not CPU.

* **Metric:** `temporal_activity_schedule_to_start_latency`.
* **Action:** If latency > 1s, KEDA spawns more Pods for that specific connector queue.

---

## Dashboards

### Dashboard 1: System Health (The "Wall Monitor")

```
┌─────────────────────────────────────────────────────────────────┐
│  EuroID System Health                                            │
├─────────────┬───────────────┬───────────────┬───────────────────┤
│  API        │  Temporal     │  MongoDB      │  Connectors       │
│  ✅ Healthy  │  ✅ Healthy    │  ✅ Healthy    │  ⚠️ Entra: Slow   │
├─────────────┴───────────────┴───────────────┴───────────────────┤
│  Request Rate: 120 req/min   │  Error Rate: 0.3%                │
│  P95 Latency: 210ms          │  Active Workflows: 42            │
└─────────────────────────────────────────────────────────────────┘
```

### Dashboard 2: Provisioning Pipeline

```
┌─────────────────────────────────────────────────────────────────┐
│  Provisioning (Last 24h)                                         │
├─────────────────────────────────────────────────────────────────┤
│  Total: 1,247  │  Success: 1,230 (98.6%)  │  Failed: 17 (1.4%) │
├─────────────────────────────────────────────────────────────────┤
│  By Connector:                                                   │
│    Entra ID:  800 ops  │  P95: 1.2s  │  Errors: 5              │
│    AD:        350 ops  │  P95: 0.8s  │  Errors: 2              │
│    Okta:       97 ops  │  P95: 2.1s  │  Errors: 10 ⚠️          │
├─────────────────────────────────────────────────────────────────┤
│  [Provisioning rate chart over time]                             │
│  [Error rate chart with connector breakdown]                     │
└─────────────────────────────────────────────────────────────────┘
```

### Dashboard 3: Drift Monitor

```
┌─────────────────────────────────────────────────────────────────┐
│  Drift Detection (Last 7 Days)                                   │
├─────────────────────────────────────────────────────────────────┤
│  Total Drifts: 38  │  Auto-Fixed: 31  │  Pending Review: 7     │
├─────────────────────────────────────────────────────────────────┤
│  By Severity:                                                    │
│    🔴 Critical: 2   │  🟡 Medium: 12   │  🟢 Low: 24           │
├─────────────────────────────────────────────────────────────────┤
│  Circuit Breaker Trips: 0 (last 30 days)                        │
└─────────────────────────────────────────────────────────────────┘
```

---

## Implementation Plan

### Phase 1: Structured Logging (1–2 days)

| # | Task | Files |
|---|------|-------|
| 1 | Create `infrastructure/observability/logger.config.ts` — Winston JSON config | New file |
| 2 | Create `infrastructure/observability/pii-redact.format.ts` — PII redaction format | New file |
| 3 | Wire Winston into `main.ts` via `NestFactory.create` logger option | `main.ts` |
| 4 | Create `infrastructure/middleware/correlation.middleware.ts` — AsyncLocalStorage + UUID | New file |
| 5 | Register correlation middleware globally in `app.module.ts` | `app.module.ts` |
| 6 | Create `infrastructure/observability/contextual-logger.service.ts`: a wrapper that auto-injects correlationId | New file |
| 7 | Replace `Logger` usage in top-5 services with contextual logger | Existing service files |

### Phase 2: Metrics (1–2 days)

| # | Task | Files |
|---|------|-------|
| 1 | Install `prom-client` | `package.json` |
| 2 | Create `infrastructure/observability/metrics.service.ts` — define counters, histograms, gauges | New file |
| 3 | Create `infrastructure/observability/metrics.module.ts` — global module | New file |
| 4 | Register `GET /metrics` on the HTTP adapter in `main.ts` (no controller; optional `METRICS_TOKEN` bearer) | `main.ts` |
| 5 | Instrument connector services (provisioning counter + duration histogram) | Connector service files |
| 6 | Instrument policy engine (evaluation counter + duration) | `policy-engine.service.ts` |
| 7 | Instrument reconciliation (drift counter) | `reconciliation.service.ts` |

### Phase 3: Distributed Tracing (OpenTelemetry) ✅ DONE

| # | Task | Files |
|---|------|-------|
| 1 | Install `@opentelemetry/sdk-node` + instrumentation packages | `package.json` |
| 2 | Create `infrastructure/observability/tracing.ts` — OTel initialization | `backend/src/infrastructure/observability/tracing.ts` |
| 3 | Configure trace propagation in Temporal activity interceptors | `worker.ts` |
| 4 | Export to Jaeger/Tempo (local Docker) or Grafana Cloud (production) | Config / Docker Compose |

#### OTel Setup

Tracing is bootstrapped in `backend/src/infrastructure/observability/tracing.ts` and **must be imported first** in both `main.ts` and `worker.ts` (before any instrumented libraries load).

**Environment variables:**

| Variable | Default | Purpose |
|----------|---------|---------|
| `OTEL_SDK_DISABLED` | `false` | Set `true` to disable tracing (e.g. when no collector is available) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | OTLP HTTP endpoint (add `/v1/traces` if needed) |
| `OTEL_SERVICE_NAME` | `euroid-backend` | Service name in traces |

**What gets instrumented:**

- **HTTP:** NestJS/Express requests via `@opentelemetry/instrumentation-http` and `@opentelemetry/instrumentation-express` (registered explicitly in `tracing.ts`)
- **MongoDB:** Mongoose queries via MongoDB instrumentation
- **Outbound HTTP:** Connector API calls (Entra ID, Okta, SCIM, etc.)
- **Temporal Activities:** `@temporalio/interceptors-opentelemetry` creates spans for activity execution and propagates trace context

**Correlation:** `X-Correlation-ID` and `X-Trace-Id` are set on responses. The trace ID links logs (via correlation middleware) to traces in Jaeger/Tempo.

#### Local Dev: Jaeger / Grafana Tempo

1. **Jaeger (all-in-one):**
   ```bash
   docker run -d --name jaeger -p 16686:16686 -p 4318:4318 \
     jaegertracing/all-in-one:latest --collector.http.host-port=:4318
   ```
   Traces: http://localhost:16686

2. **Grafana Tempo (OTLP):** Run Tempo and point `OTEL_EXPORTER_OTLP_ENDPOINT` at the Tempo OTLP ingest endpoint.

**Graceful degradation:** If the OTLP exporter is unreachable, the app continues; spans may be dropped. Set `OTEL_SDK_DISABLED=true` to disable tracing entirely.

---

## Integration Points

| Existing Component | How Observability Integrates |
|--------------------|-----------------------------|
| `main.ts` | Replace default logger with Winston; register correlation middleware |
| `app.module.ts` | Import `MetricsModule` (global) |
| `worker.ts` | Initialize logger with Winston; propagate correlationId via activity args |
| All controllers | Correlation middleware runs before every request (global) |
| All connector services (`entra.service.ts`, `ad.service.ts`, `okta.service.ts`) | Increment provisioning counters; log with connector context |
| `policy-engine.service.ts` | Increment evaluation counters; measure duration |
| `reconciliation.service.ts` | Increment drift counters |
| `audit.service.ts` | Already logging — add correlationId to audit records |
| `user-event.service.ts` | Already logging timeline events — add correlationId |

---

## Related Documents

| Doc | Relevance |
|-----|-----------|
| **[roadmap/ROADMAP.md](../roadmap/ROADMAP.md)** | Prioritized backlog — this doc is the full observability spec |
| **core/SYSTEM_ARCHITECTURE.md** | Foundational Pillars — observability is cross-cutting across all |
| **infrastructure/TEMPORAL_WORKFLOWS.md** | Correlation ID propagation through workflow → activity chain |
| **`backend/src/modules/connectors/docs/ARCHITECTURE.md`** | Connector-level metrics and logging patterns |
