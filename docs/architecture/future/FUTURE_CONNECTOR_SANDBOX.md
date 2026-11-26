# Sandbox Execution for Connectors

> **Status:** Not implemented. There is no `backend/src/infrastructure/sandbox/`: connectors run in the worker process.
> **Roadmap:** [ROADMAP.md](../roadmap/ROADMAP.md) | [Data Flows](../core/DATAFLOWS.md)

### Current State (updated 2026-02-17)
- Connectors run in-process in the Temporal worker (`worker.ts`, 268 lines)
- Per-connector bulkhead task queues: `PluginRegistryService.getAll()` creates isolated `Worker` per connector plugin, each on its own `manifest.taskQueue` (`worker.ts:227-247`)
- `RateLimitActivityInterceptor` wraps all activities with per-system rate limiting (`worker.ts:200-201`)
- Circuit breakers (cockatiel) per-connector: trips after 5 consecutive failures, half-open after 30s
- But connector code still runs in the same V8 process — a memory leak or crash kills the worker
- `connectors.md` mentions Wasm remote execution model as ROADMAP v2.0

### Architecture

```
┌────────────────────────────────────────────────────────┐
│  Temporal Worker Process                               │
│                                                        │
│  Activity: provisionUserToEntra                        │
│  ┌──────────────────────────────────────────────────┐  │
│  │  V8 Isolate / Wasm Sandbox                       │  │
│  │  ┌────────────────────────────────────────────┐  │  │
│  │  │  Connector Code (entra.service.ts)         │  │  │
│  │  │  - CPU limit: 30s                          │  │  │
│  │  │  - Memory limit: 256MB                     │  │  │
│  │  │  - Network: allowlist only (graph.ms.com)  │  │  │
│  │  └────────────────────────────────────────────┘  │  │
│  └──────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────┘
```

### Implementation Plan

**Phase 1: Isolation Strategy Selection**
- **Option A: isolated-vm** (V8 Isolates) — best for JS/TS connectors, low overhead
- **Option B: WebAssembly (Wasm)** — language-agnostic, strongest isolation, higher dev effort
- **Option C: Child Process** — simplest, uses Node.js `child_process.fork()`, moderate isolation
- **Recommendation: Start with Option C (Child Process), evolve to Option A (isolated-vm)**

**Phase 2: Connector Sandbox Runtime**
- Create `backend/src/infrastructure/sandbox/`:
  - `sandbox.module.ts` — NestJS module
  - `sandbox-executor.service.ts` — forks child process, passes serialized task, collects result
  - `sandbox-config.ts` — per-connector limits: `{ cpuTimeoutMs, memoryLimitMb, networkAllowlist }`
  - `sandbox-worker.ts` — child process entry point: deserialize task → run connector → serialize result
- Communication: `process.send()` / `process.on('message')` for IPC

**Phase 3: Connector Compilation for Sandbox**
- Connectors must be serializable: no NestJS DI, no database access from sandbox
- Create `ConnectorSandboxAdapter` that:
  1. Receives `{ connectorType, method, args, credentials }` from parent
  2. Instantiates connector with only HTTP client (no DI)
  3. Executes method
  4. Returns serialized result
- Modify connector manifest to declare `sandboxCompatible: boolean`

**Phase 4: Resource Limits**
- Child process: `--max-old-space-size=256` for memory limit
- CPU timeout: `setTimeout(() → process.kill(child.pid))` after configured limit
- Network allowlist: Custom HTTP agent that blocks non-allowlisted domains (SSRF protection)

**Phase 5: Wasm Evolution (Future)**
- Compile connector logic to Wasm using `javy` (JS → Wasm compiler)
- Run in `@aspect-build/aspect-wasm` or `wasmer-js`
- Strongest isolation: memory-safe, no filesystem/network access by default

### Files Changed
| Action | File |
|--------|------|
| New | `backend/src/infrastructure/sandbox/` (module, executor, config, worker) |
| New | `backend/src/infrastructure/sandbox/sandbox-worker.ts` (child process entry) |
| Modify | Connector manifests — add `sandboxCompatible`, `resourceLimits` |
| Modify | `backend/src/worker.ts` — wrap connector activities with sandbox executor |
| Modify | `backend/src/modules/connectors/plugin/plugin-registry.service.ts` — sandbox config |

### Dependencies
- None (pure code change)

### Scope Adjustment (2026-02-17)
- Bulkhead task queues and circuit breakers provide queue-level and failure-level isolation today — sandbox adds **process-level** isolation on top.
- Rate limiter interceptor already wraps activities; sandbox executor must preserve this integration.

### Implementation Checklist

**Phase 1 — Isolation Strategy**
- [ ] Evaluate and select isolation strategy (Child Process → isolated-vm → Wasm)

**Phase 2 — Sandbox Runtime**
- [ ] Create `backend/src/infrastructure/sandbox/` module (sandbox.module.ts, sandbox-executor.service.ts, sandbox-config.ts)
- [ ] Implement `sandbox-worker.ts` child process entry point (deserialize task, run connector, serialize result)
- [ ] Implement IPC communication via `process.send()` / `process.on('message')`

**Phase 3 — Connector Adaptation**
- [ ] Create `ConnectorSandboxAdapter` (instantiate connector with HTTP client only, no DI)
- [ ] Add `sandboxCompatible` and `resourceLimits` to connector manifests
- [ ] Modify `worker.ts` to wrap connector activities with sandbox executor

**Phase 4 — Resource Limits & Security**
- [ ] Implement memory limits (`--max-old-space-size`), CPU timeouts, and network allowlist (SSRF protection)
- [ ] Ensure `RateLimitActivityInterceptor` integration is preserved with sandbox executor
- [ ] Add unit and integration tests for sandbox execution, resource enforcement, and error handling

### Risks
- Serialization overhead for large payloads
- Connector code must be refactored to not depend on NestJS DI when sandboxed
- Child process forking overhead (~50ms per invocation)
