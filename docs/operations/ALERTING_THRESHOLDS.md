# Alerting Thresholds

Recommended alert rules for EuroID production environments. These thresholds are derived from [SLO Definitions](SLO_DEFINITIONS.md) and validated against [load test results](../../tests/load/README.md).

> **Integration:** Configure these alerts in your monitoring system (Prometheus/Grafana, Datadog, or equivalent). Each alert should page the on-call engineer at the Critical level and notify via Slack/email at the Warning level.

---

## Alert Rules

| Metric | Warning | Critical | Action |
|--------|---------|----------|--------|
| API p95 latency | > 500ms (5 min window) | > 1000ms (5 min window) | Scale API pods; investigate slow queries (see [Runbook § MongoDB](RUNBOOK.md#2-mongodb)) |
| API error rate (5xx) | > 1% (5 min window) | > 5% (5 min window) | Check logs and circuit breakers (see [Runbook § Provisioning](RUNBOOK.md#4-provisioning)) |
| Temporal task queue depth | > 50 | > 200 | Scale workers; check for stuck workflows (see [Runbook § Temporal](RUNBOOK.md#3-temporal)) |
| MongoDB connection pool usage | > 80% | > 95% | Increase pool size (`MONGO_MAX_POOL_SIZE` env var, default 20); check for connection leaks (see [Runbook § MongoDB](RUNBOOK.md#2-mongodb)) |
| DLQ depth | > 10 | > 50 | Investigate + replay failed events (see [Runbook § DLQ](RUNBOOK.md#5-dead-letter-queue)) |
| Connector circuit breaker | HALF_OPEN | OPEN | Check target system health (see [Runbook § Provisioning](RUNBOOK.md#4-provisioning)) |
| Worker memory usage | > 80% | > 95% | Restart workers; check for memory leaks; review activity payload sizes |
| Disk usage | > 80% | > 90% | Archive old data; run data retention purge; check log rotation |

---

## SLO Alignment

These thresholds are calibrated against the platform's SLO targets:

| SLO Metric | Target | Alert Triggers At |
|------------|--------|-------------------|
| API availability | 99.5% uptime | Error rate > 1% (warning), > 5% (critical) |
| API p95 latency | < 500ms (smoke), < 1000ms (soak) | p95 > 500ms (warning), > 1000ms (critical) |
| Error budget | 0.5% monthly (~3.6 hours) | Error rate alerts fire well before budget is consumed |
| Provisioning throughput | 10K users/hour (Entra) | Task queue depth alerts detect throughput degradation |

See [SLO Definitions](SLO_DEFINITIONS.md) for per-endpoint latency targets and [load test README](../../tests/load/README.md) for stress test thresholds.

---

## Alert Configuration Notes

- **Window size:** Use 5-minute sliding windows for rate-based alerts to avoid flapping.
- **Deduplication:** Group alerts by service + metric to prevent alert storms during cascading failures.
- **Muting during maintenance:** Suppress alerts during planned maintenance windows (deployments, database migrations).
- **Runbook links:** Include a link to the relevant [Runbook](RUNBOOK.md) section in every alert notification for faster triage.
