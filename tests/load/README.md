# EuroID Load Tests

Performance and scalability tests using [k6](https://k6.io/).

## Install k6

```bash
# macOS
brew install k6

# Windows
winget install k6

# Docker (no install)
docker run --rm -i grafana/k6 run - <k6-smoke.js
```

## Test Suites

| Script | Purpose | Duration | VUs |
|--------|---------|----------|-----|
| `k6-smoke.js` | Validate endpoints respond correctly under light load | ~2 min | 5 |
| `k6-soak.js` | Detect memory leaks & connection pool exhaustion | ~35 min | 20 |
| `k6-stress.js` | Find breaking point, test throttle behavior | ~10 min | 10→300 |

## Running

```bash
# Smoke test (quick validation)
k6 run tests/load/k6-smoke.js

# With custom base URL
k6 run -e BASE_URL=http://staging:3001/api/v1 tests/load/k6-smoke.js

# With auth token
k6 run -e AUTH_TOKEN=eyJhbG... tests/load/k6-smoke.js

# Export results to JSON
k6 run --out json=results.json tests/load/k6-smoke.js
```

## Thresholds (SLOs)

| Metric | Smoke | Soak | Stress |
|--------|-------|------|--------|
| p95 latency | <500ms | <1000ms | <2000ms |
| p99 latency | <1000ms | <2000ms | — |
| Error rate | <5% | <2% | <30% |

## Key Endpoints Tested

- `GET /health` — API + DB connectivity
- `GET /identity` — Paginated identity list (MongoDB query perf; every test pages with `_start`/`_end`, the stress test searches with `q`)
- `GET /policy` — Policy engine evaluation
- `GET /connectors` — Connector config retrieval
- `GET /audit` — Audit log pagination
- `GET /entitlement-catalog` — Entitlement lookup (every test asks for `system=entra-id`; without a system the route answers an empty list)
- `GET /analytics/seasonal-patterns` — Aggregation queries (12 months of audit events, soak only)
- `GET /risk-scores?top=10` — Top risky identities (soak only)
- `GET /access-reviews/campaigns` — Access review campaigns, paginated (soak only)
