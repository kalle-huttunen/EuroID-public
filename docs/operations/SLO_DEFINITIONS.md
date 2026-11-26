# Service Level Objectives (SLOs)

## API Availability

| Tier | Target | Measurement |
|------|--------|-------------|
| Production | 99.5% uptime | Rolling 30-day window |
| Staging | 95% uptime | Business hours only |

## Latency SLOs

| Endpoint Category | p50 | p95 | p99 |
|-------------------|-----|-----|-----|
| Health check | <50ms | <100ms | <200ms |
| Identity list (paginated) | <200ms | <500ms | <1000ms |
| Identity single lookup | <100ms | <300ms | <500ms |
| Policy evaluation | <100ms | <250ms | <500ms |
| Connector health check | <500ms | <2000ms | <5000ms |
| Audit log query | <200ms | <500ms | <1000ms |
| Bulk provisioning (start) | <500ms | <1000ms | <2000ms |

## Throughput Targets

| Operation | Target | Notes |
|-----------|--------|-------|
| API requests | 100 req/s sustained | Per single API instance |
| Identity CRUD | 50 ops/s | Read-heavy (80/20 read/write) |
| Provisioning (Entra) | 10K users/hour | Rate limited by Microsoft Graph |
| Reconciliation | 50K users/run | Scatter-gather parallelism |

## Data Durability

| Data Type | RPO | RTO | Backup Frequency |
|-----------|-----|-----|------------------|
| Identity records | 1 hour | 4 hours | Hourly mongodump + oplog |
| Audit events | 4 hours | 8 hours | Daily mongodump |
| Workflow state | 0 (durable) | Auto-recovery | Temporal persistence |
| Connector configs | 1 hour | 4 hours | With identity backup |

## Error Budget

- **Monthly budget:** 0.5% = ~3.6 hours downtime
- **Burn rate alert:** If 50% of monthly budget consumed in 1 day
- **Freeze trigger:** If 80% of monthly budget consumed, halt deployments until next window

## Measurement

SLOs are measured via:
- k6 load tests (baseline validation): `tests/load/`
- Health check endpoint: `GET /api/v1/health`
- Application metrics (when Prometheus/Grafana deployed)
- Temporal workflow success/failure rates
