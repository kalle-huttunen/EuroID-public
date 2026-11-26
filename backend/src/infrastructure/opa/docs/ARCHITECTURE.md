# OPA Infrastructure — Architecture

> **Module:** OPA Client (Infrastructure)
> **Related:** [Policy Engine](../../../modules/policy/docs/ARCHITECTURE.md) | [Policy OPA Integration](../../../modules/policy/opa/)

## Overview

Global infrastructure module providing an HTTP client for Open Policy Agent (OPA). Follows the same **fail-open** pattern as `GraphModule` and `ElasticsearchModule`: returns null/false when OPA is unavailable, allowing the TypeScript policy engine to serve as fallback.

EuroID ships no OPA server: `docker-compose.yml` has no OPA service and the repository has no deploy manifest that runs one. With `OPA_ENABLED=true` (default `false`, `infrastructure/config/opa.config.ts`) the client talks to an OPA server the operator runs at `OPA_URL` (default `http://localhost:8181`, which suits an OPA sidecar next to the API), through the OPA REST API (v1).

## Components

| File | Purpose |
|------|---------|
| `opa-client.service.ts` | HTTP client — health check, query, pushPolicy, pushData |
| `opa.module.ts` | `@Global()` NestJS module — injectable everywhere |
| `config/opa.config.ts` | Zod-validated env-var configuration |

## Configuration

| Env Var | Default | Description |
|---------|---------|-------------|
| `OPA_ENABLED` | `false` | Master switch — when false, all operations return null/false |
| `OPA_URL` | `http://localhost:8181` | OPA server endpoint |
| `OPA_POLICY_PATH` | `euroid/policy/evaluate` | Rego package path for policy queries |
| `OPA_REQUEST_TIMEOUT_MS` | `5000` | Per-request timeout |
| `OPA_FALLBACK_ON_ERROR` | `true` | Return null on errors (allowing TS fallback) vs. throw |
| `OPA_BUNDLE_SYNC_INTERVAL_MS` | `30000` | Parsed by `opa.config.ts` but read by no code: nothing syncs Rego bundles on a timer |

## API Surface

### `isAvailable(): boolean`
Returns `true` only when `OPA_ENABLED=true` AND the health check succeeded on startup.

### `shouldFallback(): boolean`
Returns `OPA_FALLBACK_ON_ERROR` value. When true, query errors return null. No fallback is triggered: `PolicyEngineService` never calls OPA and always evaluates in TypeScript (`modules/policy/docs/ARCHITECTURE.md`, Evaluation Modes).

### `query(input: OpaQueryInput): Promise<OpaQueryResult | null>`
POST to `/v1/data/{policyPath}` with `{ input }` body. Returns structured `OpaQueryResult` with operations array. A failure (an HTTP error, a result without an `operations` array, a network error or timeout) returns null with `OPA_FALLBACK_ON_ERROR=true` and throws `OPA evaluation failed: <reason>` with `false`.

### `pushPolicy(policyId: string, regoSource: string): Promise<boolean>`
PUT to `/v1/policies/{policyId}` with compiled Rego source. Used by `OpaEvaluatorService.syncPolicies()`.

### `pushData(path: string, data: unknown): Promise<boolean>`
PUT to `/v1/data/{path}` with JSON data. For pushing tenant config or user attribute snapshots.

## Fail-Open Pattern

```
OPA enabled?
  NO  → return null/false immediately
  YES → OPA reachable?
          NO  → return null/false (log warning)
          YES → execute request
                  success → return result
                  error   → fallbackOnError?
                              YES → return null (log warning)
                              NO  → throw Error
```

## Startup Behavior

On module init, if `OPA_ENABLED=true`, the client performs a health check (`GET /health`). If OPA is unreachable, the client logs a warning and marks itself as unavailable — no exception is thrown, and the application starts normally with TypeScript-only policy evaluation.

## HTTP Client

Uses native `fetch()` (Node.js built-in) with `AbortController` for timeouts. No external HTTP library dependency.
