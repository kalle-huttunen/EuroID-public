---
Last updated: 2026-02-23
---

# Disaster Recovery & Business Continuity

> **Cross-cutting:** [Deployment](../../DEPLOYMENT.md) | [Data Retention](../security/DATA_RETENTION.md) | [Observability](OBSERVABILITY_ARCHITECTURE.md)

---

## Recovery Objectives

| Tier | RPO (Data Loss) | RTO (Downtime) | Scope |
|------|-----------------|----------------|-------|
| **Tier 1 — Identity Data** | 1 hour | 4 hours | MongoDB identities, policies, entitlement catalog |
| **Tier 2 — Audit & Compliance** | 24 hours | 8 hours | Audit events, compliance reports, risk scores |
| **Tier 3 — Workflow State** | Best-effort | 8 hours | Temporal workflow history (Postgres) |
| **Tier 4 — Configuration** | Git-backed | 1 hour | `.env` files, connector configs, OIDC settings |

**Current status:** Tier 4 is handled by git. Tiers 1-3 depend on backup infrastructure described below. Managed services (Atlas, Temporal Cloud) provide their own SLAs.

---

## Backup Strategy

### MongoDB (Tier 1 + 2)

| Approach | Frequency | Retention | Tool |
|----------|-----------|-----------|------|
| **Full backup** | Daily at 02:00 UTC | 30 days | `mongodump --gzip --archive` |
| **Oplog continuous** | Continuous (if replica set) | 72 hours | Oplog tailing or Atlas continuous backup |

```bash
# Daily backup (cron or CI job)
mongodump --uri="${MONGO_URI}" --archive=euroid-$(date +%Y%m%d).archive --gzip

# Restore
mongorestore --uri="${MONGO_URI}" --archive=euroid-20260222.archive --gzip --drop
```

**Managed service (recommended):** MongoDB Atlas provides automated backups with point-in-time restore (continuous oplog backup, configurable retention).

### Temporal (Tier 3)

Temporal persists workflow state in its own Postgres database. Backup strategy depends on deployment:

| Deployment | Backup | Notes |
|------------|--------|-------|
| **Docker Compose** (dev) | `pg_dump temporal > backup.sql` | Manual, sufficient for dev |
| **Self-hosted** | Standard Postgres backup (pg_basebackup, WAL archiving) | Match RPO to business needs |
| **Temporal Cloud** | Managed by Temporal Inc. | SLA-backed, no action needed |

**In-flight workflow recovery:** Temporal automatically recovers running workflows from their event history after a restart. No manual intervention needed — workflows resume from their last checkpoint.

### Application Configuration (Tier 4)

| What | Where | Backup |
|------|-------|--------|
| `.env` files | Server filesystem | Store in secrets manager (AWS Secrets Manager, Azure Key Vault, HashiCorp Vault) |
| `ENCRYPTION_KEY` | `.env` | **Critical** — loss means all encrypted connector credentials become unreadable. Store in KMS. |
| OIDC configuration | IdP (Entra ID, Auth0) | IdP manages; document tenant IDs and client IDs in ops runbook |
| Connector credentials | MongoDB (encrypted) | Restored with MongoDB backup; requires matching `ENCRYPTION_KEY` |

---

## Failure Scenarios & Recovery

### Scenario 1: MongoDB Unavailable

**Impact:** API returns 503, no reads/writes, provisioning halted.

**Detection:** Health endpoint `GET /api/v1/health/ready` reports `components.mongodb.status: unhealthy` (`health.controller.ts`). No Prometheus metric tracks MongoDB availability.

**Recovery:**
1. Check MongoDB container/service status
2. If data corruption: restore from latest backup
3. If connection issue: verify `MONGO_URI`, network, firewall
4. API and worker auto-reconnect when MongoDB recovers (Mongoose reconnect built-in)

### Scenario 2: Temporal Unavailable

**Impact:** No new workflows start. Running workflows pause (will resume when Temporal recovers). API remains functional for reads/writes.

An API that starts while Temporal is unreachable starts anyway and connects later on its own (`backend/src/infrastructure/temporal/temporal-client.provider.ts`): a route or job that needs Temporal starts a connection attempt and answers "not connected" until one succeeds, at most one attempt per backoff delay (`TEMPORAL_RECONNECT_MIN_MS`, default 1000, doubling up to `TEMPORAL_RECONNECT_MAX_MS`, default 30000). No restart is needed.

**Detection:** Worker logs `transport error`. Temporal UI unreachable.

**Recovery:**
1. Check Temporal + Postgres containers
2. If Postgres corruption: restore from backup, Temporal rebuilds state
3. In-flight workflows automatically resume from their last activity checkpoint
4. No data loss — Temporal's event sourcing model is inherently durable

### Scenario 3: Encryption Key Lost

**Impact:** All encrypted connector credentials unreadable. Connectors cannot authenticate to target systems (Entra, AD, etc.).

**Recovery:**
1. If `ENCRYPTION_KEY_PREVIOUS` is set and old key available: re-encrypt with new key using `rotate-encryption-key.ts`
2. If key is permanently lost: re-enter all connector credentials manually via the UI
3. **Prevention:** Store `ENCRYPTION_KEY` in a KMS (AWS KMS, Azure Key Vault). Enable `KMS_PROVIDER` for envelope encryption.

### Scenario 4: Full Environment Loss

**Recovery sequence:**
1. Provision infrastructure (Docker Compose or K8s)
2. Restore MongoDB from backup
3. Restore Temporal Postgres from backup
4. Set environment variables (from secrets manager)
5. Start services: API → Worker → Frontend
6. Verify: health check, Temporal UI, Swagger UI
7. Run `GET /api/v1/audit/verify-integrity` to confirm audit chain

---

## Multi-Region Considerations (Future)

Currently not implemented. When cell-based architecture (see `docs/architecture/future/FUTURE_CELL_ARCHITECTURE.md`) is adopted:

- Each cell can be deployed in a separate region
- MongoDB Atlas supports multi-region clusters with automatic failover
- Temporal Cloud supports multi-region namespaces
- Ingress gateway routes by tenant to correct region/cell

---

## Monitoring & Alerting

| Alert | Condition | Action |
|-------|-----------|--------|
| MongoDB down | Health check fails for >60s | Page on-call, check container |
| Temporal down | Worker heartbeat missing >5min | Page on-call, check Temporal + Postgres |
| Backup failed | Daily backup job exits non-zero | Investigate, run manual backup |
| Disk >80% | MongoDB data volume | Expand volume, review TTL indexes |
| Audit chain broken | `verify-integrity` returns `valid: false` | Investigate tampering, restore from backup |

**Known limitation**: GDPR erasures run before commit `47fa1cd7` (2026-11-24) recorded no `removedSeqs`, so `verify-integrity` over a window holding the event after an entry they deleted answers `valid: false` with `broken_link`. Nothing repairs that gap; it is accepted ([GDPR_COMPLIANCE.md](../../../backend/src/modules/compliance-reporting/docs/GDPR_COMPLIANCE.md), Known Limitations item 4). Such a `broken_link` right after an erasure from before that commit is not tampering, and a restore does not remove it.

See [Observability Architecture](OBSERVABILITY_ARCHITECTURE.md) for full metric/dashboard setup.

---

## Related Documents

| Document | Relevance |
|----------|-----------|
| [Deployment Guide](../../DEPLOYMENT.md) | Production checklist, Docker Compose setup |
| [Data Retention](../security/DATA_RETENTION.md) | TTL indexes, soft-delete, archival strategy |
| [Secrets Management](../../../backend/src/infrastructure/secrets/docs/ARCHITECTURE.md) | Encryption key lifecycle |
| [Multi-Tenancy](ARCHITECTURE_MULTI_TENANCY.md) | Tenant-scoped data isolation |
| [Observability](OBSERVABILITY_ARCHITECTURE.md) | Logging, metrics, tracing |
