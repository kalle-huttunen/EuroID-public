---
Last updated: 2026-02-23
---

# Infrastructure Scaling - The 2026 Standard

## Current State

EuroID currently runs as a **single NestJS monolith** with multi-tenancy via:
- **JWT `tenantId` claim** — extracted by `TenantGuard` middleware
- **MongoDB tenant scoping** — via `TenantPlugin` using `AsyncLocalStorage`; all Mongoose queries auto-scoped
- **Temporal tenant isolation** — workflows prefixed with `t-{tenantId}-` and filtered via `TenantId` search attribute

All tenants share a single API process, MongoDB instance, and Temporal worker pool.

---

## Scalability Hardening (Task 119)

### Redis (Distributed Cache)

When `REDIS_URL` is set, EuroID uses Redis for shared state across API/worker instances: the Nest cache (`CACHE_MANAGER`, a Keyv store on ioredis, `redis-keyv.store.ts`) and the distributed-transaction locks (`OWNED_LOCK_STORE`). At startup `CacheBackendCheck` (`cache-backend.check.ts`) writes a probe through each and reads it back from Redis with a separate client: if either is not in Redis, or Redis does not answer, startup fails. The log line `Cache and owned locks: Redis at <host:port>` confirms the backend. When `REDIS_URL` is unset (dev), both are in-memory per process and startup logs a warning: run a single API and a single worker only.

Security state has a store of its own (`SECURITY_STATE_STORE`, `security-state.store.ts`; Redis with `REDIS_URL`, in-memory without). The Nest cache fails open: Keyv and cache-manager turn a failed Redis read into a miss, so a lockout counter would read as zero while Redis is down. The security state store rejects instead, and its callers fail closed: MFA verification and the emergency token are refused with `503` while their failure counters cannot be read or written, `POST /auth/login` is rate limited per client across all instances (its `@Throttle()` counters use `sharedThrottleKey`, `shared-throttler.storage.ts`) and answers `503` while the store fails, a SAML code is read and deleted in one step (a Lua script; of two simultaneous exchanges of one code only one gets the tokens) and is not exchanged unless it can be used up. The JWT guard does not use the store for revocation: it reads the admin's `isActive` and `tokenVersion` from MongoDB on every request with a local token (`jwt-auth.guard.ts`), so a revoked token is refused from the next request on, on every instance, whether or not Redis is reachable. A delete that fails stays pending in that instance: it deletes the key before any later read of it (and fails the read while it cannot) and resends the delete every second, so a Redis that comes back with the old entry does not hand it back. Its client has short timeouts (`SECURITY_STORE_CONNECT_TIMEOUT_MS`, default 1000; `SECURITY_STORE_COMMAND_TIMEOUT_MS`, default 500), so while Redis is unreachable a check denies within them instead of waiting out ioredis's reconnect retries (about 10 s). Each failure is logged as an error, and `GET /health/ready` reports `components.securityState` (`status: "failing"` makes the overall status `degraded`, HTTP 200). The other caches (rate limiter, OAuth tokens, connector health) still fail open.

| Usage | Key Pattern | TTL |
|-------|-------------|-----|
| Rate limiter | `euroid:ratelimit:{system}` | Window (e.g. 1h) |
| MFA failed attempts (security state) | `euroid:mfa:failed:{userId}` | 15 min |
| Emergency token failures (security state) | `euroid:emergency:failed:{ip}` | 15 min window |
| SAML one-time code (security state) | `euroid:saml:auth:{code}` | 60s |
| Login rate limit (security state) | `euroid:throttle:{sha256 of route, throttler and client IP}` | Throttle window (1s, 60s) |
| OAuth Entra | `euroid:oauth:entra:{tenantId}:{clientId}:{sha256 of the client secret}` | Token expiry − 60s |
| OAuth SCIM | `euroid:oauth:scim:{baseUrl}\|{oauth2TokenUrl}\|{clientId}\|{sha256 of the client secret}` | Token expiry − 60s |
| Distributed-transaction lock | `euroid:disttx:lock:{tenantId}:{system}:{sha256 of the lowercased email}` | 5 min, released at commit |

**Env vars:** `REDIS_URL`, `REDIS_PASSWORD`, `REDIS_KEY_PREFIX` (default `euroid:`), `SECURITY_STORE_CONNECT_TIMEOUT_MS`, `SECURITY_STORE_COMMAND_TIMEOUT_MS`.  
**Module:** `backend/src/infrastructure/cache/redis.module.ts`

### Circuit Breaker (Connector HTTP Calls)

Circuit breakers (cockatiel) protect Entra ID and SCIM HTTP calls (`entra.client.ts`, `scim.client.ts` use `infrastructure/resilience/connector-circuit-breaker.ts`): one per tenant, connector and target (the Entra ID directory and app; the SCIM base URL, and the OAuth token URL), so one tenant's failing target never blocks another tenant or target. Only a failure of the target counts: a 5xx answer or no answer at all (SCIM calls and the SCIM token request time out after `CONNECTOR_TIMEOUT_MS`, default 15 s, which counts as no answer; a SCIM 5xx is counted inside the breaker and then answered as its `SCIMError`). A 4xx (404 on a free UPN, 409), a 429 or refused credentials never count. Trips after 5 consecutive counted failures; half-open after 30s.

- **Event:** `connector.circuit_breaker_tripped` with payload `{ connector, state }` (the log line names the tenant and target)
- **Metrics:** `euroid_circuit_breaker_trips_total`, `euroid_circuit_breaker_state` (labels: `connector`, `state`)
- **Module:** `backend/src/infrastructure/resilience/connector-circuit-breaker.ts`

### MongoDB Pool Tuning

Connection pool is configurable via env vars:

| Var | Default | Description |
|-----|---------|-------------|
| `MONGO_MAX_POOL_SIZE` | 20 | Max connections per process |
| `MONGO_MIN_POOL_SIZE` | 5 | Min connections in pool |
| `serverSelectionTimeoutMS` | 5000 | Timeout for server selection |
| `socketTimeoutMS` | 45000 | Socket timeout |
| `w` | `majority` | Write concern |

**Read preference:** For replica sets, analytics queries can use `readPreference: 'secondaryPreferred'` to offload reads to secondaries. Single-node deployments ignore this.

### Index Verification

Run `npx ts-node -r tsconfig-paths/register src/scripts/verify-indexes.ts` to compare expected indexes with actual. Exit 0 if all present, 1 if any missing. Expected indexes include:

- `policies`: `{ tenantId, status, priority }`
- `review_campaigns`: `{ tenantId, status }`
- `review_items`: `{ tenantId, campaignId, decision }`
- `connector_configs`: `{ tenantId, connectorName }` (unique)
- `user_events`: `{ tenantId, userId, timestamp }`

### Temporal mTLS

When `TEMPORAL_TLS_CERT_PATH`, `TEMPORAL_TLS_KEY_PATH`, and `TEMPORAL_TLS_CA_PATH` are set and files exist, the worker and the API's Temporal client connect to Temporal over mTLS (client certificate authentication). Both read them through `temporalTlsConfig()` in `backend/src/infrastructure/config/temporal.config.ts`.

**Env vars:**

| Var | Description |
|-----|-------------|
| `TEMPORAL_TLS_CERT_PATH` | Path to client certificate (PEM) |
| `TEMPORAL_TLS_KEY_PATH` | Path to client private key (PEM) |
| `TEMPORAL_TLS_CA_PATH` | Path to server CA certificate (PEM) |

**Dev: self-signed certs**

```bash
# Generate CA
openssl genrsa -out temporal-ca.key 2048
openssl req -x509 -new -nodes -key temporal-ca.key -sha256 -days 3650 -out temporal-ca.pem -subj "/CN=Temporal-CA"

# Generate client cert
openssl genrsa -out temporal-client-key.pem 2048
openssl req -new -key temporal-client-key.pem -out temporal-client.csr -subj "/CN=euroid-worker"
openssl x509 -req -in temporal-client.csr -CA temporal-ca.pem -CAkey temporal-ca.key -CAcreateserial -out temporal-client.pem -days 3650 -sha256
```

**Temporal Server config:** Enable client cert auth in `frontend` config (e.g. `frontend.enableClientCertAuth`, `frontend.clientCertFile`). See [Temporal docs](https://docs.temporal.io/self-hosted-guide/security).

**Production:** Use cert-manager, AWS ACM, or HashiCorp Vault PKI for certificate lifecycle.

---

## Cell-Based Architecture

> **ROADMAP / TARGET ARCHITECTURE** — The cell-based model below is **NOT yet implemented**. It describes the target scaling architecture for production multi-tenant deployments.

A **Cell** is the smallest deployable unit of the EuroID platform. Each Cell is tenant-isolated and self-contained.

| Component | Per Cell |
|-----------|----------|
| **API** | 1 NestJS instance (or replica set) |
| **MongoDB** | 1 database (or replica set) |
| **Worker Pool** | 1 Temporal worker pool |

Cells enable horizontal scaling: add more Cells for more tenants or load. Each Cell serves a subset of tenants; the Ingress Gateway routes traffic to the correct Cell.

---

## Routing

> **ROADMAP** — Not yet implemented.

The Ingress Gateway routes requests to Cells based on `tenantId`.

1. **Extract:** JWT or header provides `tenantId`.
2. **Lookup:** Routing table maps `tenantId` → Cell endpoint.
3. **Forward:** Request is proxied to the Cell's API.

This allows:
- **Tenant isolation:** One Cell per high-security tenant.
- **Geographic distribution:** Cells in EU vs US for data residency.
- **Load balancing:** Multiple Cells for high-volume tenants.

---

## Cold Storage

> **PLANNED:** tiering inside S3 (Standard to Glacier) is not implemented, and only audit and user events leave MongoDB. Built: `archival.workflow.ts` exports `audit_events` and `user_events` past their retention to S3 or Azure Blob (NDJSON, gzipped), then deletes them (`ARCHIVAL_ENABLED=true`); `audit-archive.workflow.ts` exports Merkle-checkpointed audit events to S3 with Object Lock and deletes nothing (`AUDIT_ARCHIVE_ENABLED=true`, `modules/audit/audit-archive.service.ts`). Other data stays in MongoDB under TTL indexes (`RetentionModule`, `infrastructure/retention/`).

**Target data lifecycle policy:**

| Stage | Store | Retention |
|-------|-------|-----------|
| **Hot** | MongoDB | Active queries, last 90 days |
| **Warm** | S3 Standard | Archive, 90 days – 1 year |
| **Cold** | S3 Glacier / Glacier Deep Archive | Compliance, > 1 year |

**Current implementation:**
- TTL indexes on `audit_events`, `user_events`, `transaction_logs` (configurable via `AUDIT_RETENTION_DAYS`, `USER_EVENTS_RETENTION_DAYS`, `WORKFLOW_RETENTION_DAYS`)
- Soft-delete with configurable retention (`IDENTITY_SOFT_DELETE_RETENTION_DAYS`)
- `POST /api/v1/dev/retention/purge-deleted` for manual purge (super-admin)
