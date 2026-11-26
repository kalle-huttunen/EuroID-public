# Operations Runbook

This runbook covers the most common operational scenarios for EuroID. Each section follows the format: **Symptom → Likely Cause → Investigation → Resolution → Escalation**.

> **Related docs:**
> - [Incident Response](INCIDENT_RESPONSE.md) — severity classification and incident workflow
> - [SLO Definitions](SLO_DEFINITIONS.md) — target availability, latency, and throughput
> - [Alerting Thresholds](ALERTING_THRESHOLDS.md) — warning and critical alert rules

---

## 1. Service Health

### Symptom
- Health endpoint (`GET /health`) returns non-200 or times out
- Load balancer marks API pods as unhealthy

### Likely Cause
- MongoDB connection failure
- Temporal connection failure
- Pod OOM kill or crash loop
- Misconfigured environment variables after deployment

### Investigation
1. Check pod status: `kubectl get pods -l app=euroid-api`
2. Check pod logs: `kubectl logs <pod> --tail=100`
3. Hit health endpoint directly: `curl http://<pod-ip>:3001/health`
4. Check MongoDB connectivity: `mongosh --eval "db.runCommand({ping: 1})"`
5. Check Temporal connectivity: `tctl cluster health`

### Resolution
- If MongoDB is down → see Section 2
- If Temporal is down → see Section 3
- If OOM → increase memory limits, check for memory leaks (see worker memory in alerting thresholds)
- If env var misconfiguration → rollback deployment (`kubectl rollout undo deployment/euroid-api`)

### Escalation
- If health endpoint fails across all pods → SEV-1, page on-call engineer
- If intermittent → SEV-3, investigate during business hours

---

## 2. MongoDB

### Symptom
- Slow API responses (p95 > 1000ms)
- Connection pool exhaustion warnings in logs
- Replication lag alerts from MongoDB monitoring

### Likely Cause
- **Connection pool exhaustion:** Too many concurrent connections, pool size too small
- **Slow queries:** Missing indexes, large collection scans, unoptimized aggregation pipelines
- **Replication lag:** High write volume on primary, slow secondary disk I/O

### Investigation
1. Check connection pool: `db.serverStatus().connections` — compare `current` vs `available`
2. Check slow queries: `db.currentOp({"secs_running": {$gt: 5}})` for long-running operations
3. Check replication lag: `rs.printSecondaryReplicationInfo()`
4. Check index usage: `db.identities.aggregate([{$indexStats: {}}])`
5. Check application logs for `MongoTimeoutError` or `MongoPoolClearedError`

### Resolution
- **Pool exhaustion:** Increase `maxPoolSize` in MongoDB connection options (env var `MONGO_MAX_POOL_SIZE`, default 20; `MONGO_MIN_POOL_SIZE` sets the minimum, default 5)
- **Slow queries:** Add missing indexes; for immediate relief, kill long-running operations with `db.killOp(<opId>)`
- **Replication lag:** Reduce write pressure (defer non-critical batch operations), check secondary disk IOPS

### Escalation
- Connection pool at >95% → SEV-2, immediate intervention required
- Replication lag > 30 seconds → SEV-2, risk of stale reads

---

## 3. Temporal

### Symptom
- Workflows stuck in `RUNNING` state for longer than expected
- Task queue backlog growing (visible in Temporal Web UI)
- Worker pods in crash loop

### Likely Cause
- **Stuck workflows:** Activity timeout too long, external system unresponsive, missing signal
- **Task queue backlog:** Insufficient worker count, slow activity execution, worker crash loop
- **Worker crash:** OOM, unhandled exception in activity, Temporal server connection lost

### Investigation
1. Temporal Web UI: check workflow execution history for the stuck workflow
2. Check task queue depth: Temporal Web UI → Task Queues → select queue → "Backlog"
3. Check worker logs: `kubectl logs -l app=euroid-worker --tail=200`
4. Check worker pod status: `kubectl get pods -l app=euroid-worker`
5. Check Temporal server health: `tctl cluster health`

### Resolution
- **Stuck workflow — activity timeout:** If the external system is confirmed down, terminate the workflow: `tctl workflow terminate -w <workflowId>`
- **Stuck workflow — missing signal:** Send the signal manually: `tctl workflow signal -w <workflowId> --name <signalName> --input '<json>'`
- **Task queue backlog:** Scale workers: `kubectl scale deployment euroid-worker --replicas=<N>` (or let KEDA autoscaler handle it)
- **Worker crash loop:** Check logs for root cause, fix, and redeploy. If immediate relief needed, rollback worker deployment.

### Escalation
- Task queue backlog > 200 → SEV-2, scale workers immediately
- All workers down → SEV-1, page on-call

---

## 4. Provisioning

### Symptom
- Provisioning workflows failing or timing out
- Spike in `409 Conflict` responses from target systems
- Circuit breaker in OPEN state for a connector

### Likely Cause
- **Connector timeout:** Target system (Entra ID, AD) is slow or unavailable
- **409 Conflict storms:** Duplicate provisioning requests hitting the target system simultaneously
- **Circuit breaker OPEN:** Repeated failures triggered the circuit breaker threshold

### Investigation
1. Check connector health: `GET /api/v1/reconciliation/connector-health` (every installed connector, result cached briefly) or `POST /api/v1/connectors/<name>/health-check` (one connector; AD, Entra ID and SCIM only)
2. Check provisioning workflow history in Temporal Web UI
3. Check target system status (e.g., Azure Service Health for Entra ID)
4. Check circuit breaker state in application logs: search for `[CircuitBreaker]` (`<connector> state changed to <state>`), or read the Prometheus gauge `euroid_circuit_breaker_state`
5. Check for 409 patterns: search logs for `status=409` and correlate with workflow IDs

### Resolution
- **Target system down:** Wait for recovery. Circuit breaker will transition to HALF_OPEN and retry automatically.
- **409 storms:** Verify idempotency keys are being generated correctly. Check for duplicate workflow starts.
- **Circuit breaker stuck OPEN:** If target system is confirmed healthy, reset circuit breaker by restarting the affected worker pod.

### Escalation
- Connector OPEN state > 30 minutes with target system confirmed healthy → SEV-2
- Mass provisioning failure affecting > 100 identities → SEV-2

---

## 5. Dead Letter Queue

### Symptom
- DLQ depth rising (alert from monitoring)
- Events not being processed by downstream consumers

### Likely Cause
- **Handler failure:** A domain event consumer is throwing unhandled exceptions
- **Validation failure:** Event payloads failing Zod schema validation
- **Chain depth exceeded:** Event cascade hit the `MAX_EVENT_DEPTH = 20` limit

### Investigation
1. Query DLQ entries: `GET /api/v1/dead-letter` (or direct MongoDB query on `dead_letter` collection)
2. Check `type` field: `event_handler_failure`, `event_validation_failure`, or `event_chain_depth_exceeded`
3. For handler failures: check the `error` field for stack trace and `handler` (`Class.method`) for the handler that failed
4. For validation failures: check the `originalPayload` field against the expected Zod schema
5. For depth exceeded: trace the `causedBy` chain to find the event loop

### Resolution
- **Handler failure:** Fix the bug in the consumer, deploy, then replay DLQ entries: `POST /api/v1/dead-letter/:id/replay`. The answer says whether it worked (`success`, `status`, `error`); an entry naming its `handler` re-runs only that handler. An entry that carries no event (validation failure, depth exceeded, workflow terminal, connector error) is refused with 409: dismiss it once the cause is fixed.
- **Validation failure:** Update the Zod schema or fix the emitting service to produce valid payloads
- **Chain depth exceeded:** Identify and break the circular event chain (A → B → A). This is a design bug — fix the event handler that re-emits events unnecessarily.

### Escalation
- DLQ depth > 50 → SEV-2, investigate immediately
- DLQ growing at > 10/minute → SEV-2, likely a systemic handler failure

---

## 6. Reconciliation

### Symptom
- Drift detection reporting abnormally high drift count
- Orphan account count spike
- Reconciliation workflow taking longer than expected

### Likely Cause
- **Drift spike:** Bulk change in target system (e.g., IT admin mass-modified group memberships)
- **Orphan spike:** HR system removed many users, or connector discovery returned stale data
- **Slow reconciliation:** Large tenant with many identities, or target system rate limiting discovery

### Investigation
1. Check reconciliation dashboard: `GET /api/v1/reconciliation/drifts` (filters `status`, `type`, `severity`, `targetSystem`) and `GET /api/v1/reconciliation/drifts/stats`
2. Check orphan count: `GET /api/v1/reconciliation/orphans/stats` (counts per system and status); the list is `GET /api/v1/reconciliation/drifts?type=ORPHAN_ACCOUNT`
3. Check reconciliation workflow execution time in Temporal Web UI
4. Compare drift timestamps — are all drifts from the same time window? (suggests bulk external change)
5. Check target system audit logs for recent bulk operations

### Resolution
- **Bulk external change:** If the change was intentional, acknowledge drifts in bulk. If unintentional, use the reconciliation "Correct" action to push desired state.
- **Orphan spike:** Verify with HR team whether the removals are expected. If stale discovery data, re-run connector discovery.
- **Slow reconciliation:** Check for missing indexes on the `identities` collection. Consider running reconciliation during off-peak hours.

### Escalation
- Drift count > 1000 in a single reconciliation run → SEV-3, investigate before auto-correction
- Orphan count > 100 → SEV-3, requires HR verification before any cleanup action

---

## 7. Authentication

### Symptom
- JWT validation failures in API logs
- Users unable to authenticate
- Rate limiting triggered (429 responses)

### Likely Cause
- **JWT failures:** Token expired, wrong signing key, OIDC provider configuration mismatch
- **Auth outage:** OIDC provider (e.g., Auth0, Azure AD) is down
- **Rate limiting:** Legitimate traffic spike or credential stuffing attack

### Investigation
1. Check API logs for JWT error details: `search for "JWT" or "Unauthorized"`
2. Check OIDC provider status page
3. Verify JWT signing keys: `GET /.well-known/jwks.json` from the OIDC provider
4. Check rate limit configuration: verify thresholds in environment variables
5. Check source IPs of rate-limited requests for attack patterns

### Resolution
- **Expired/wrong keys:** Rotate the JWKS cache. If using local JWKS, update from the OIDC provider.
- **OIDC provider down:** Nothing to do but wait. Consider caching recently-validated tokens (short TTL).
- **Rate limiting — legitimate:** Increase rate limit thresholds temporarily.
- **Rate limiting — attack:** Block offending IPs at the load balancer/WAF level.

### Escalation
- All users unable to authenticate → SEV-1
- Suspected credential stuffing → SEV-2, engage security team

---

## 8. Cell Infrastructure

> **Not implemented.** The code has no cell infrastructure: no `CellRegistryService`, no `cells` collection, no `cellId` on tenants ([ADR-007](../adr/ADR-007-cell-architecture.md) is accepted, not implemented). This section applies only once cells are built.

### Symptom
- Cell health check failures for a specific cell
- Tenant migration stuck or failed
- Requests from a cell's tenants failing while shared-cell tenants are fine

### Likely Cause
- **Cell health failure:** Cell-specific MongoDB or Temporal instance is down
- **Migration stuck:** Tenant data migration workflow hit an error, or in-flight workflows preventing cutover
- **Cell routing failure:** `CellRegistryService` cache returning stale data, or cell connection string invalid

### Investigation
1. Check cell status: query `cells` collection for the cell's `status` field
2. Check cell-specific MongoDB: connect directly to the cell's MongoDB URI and run `db.runCommand({ping: 1})`
3. Check cell-specific Temporal: verify the cell's Temporal namespace is healthy
4. Check `CellRegistryService` cache: restart the API pod to clear stale cache entries
5. Check tenant-to-cell mapping: query `tenants` collection for the affected tenant's `cellId`

### Resolution
- **Cell MongoDB down:** Restart the cell's MongoDB instance. If persistent, failover to replica.
- **Cell Temporal down:** Restart the cell's Temporal namespace. In-flight workflows will resume from their last checkpoint.
- **Migration stuck:** Check the migration workflow in Temporal Web UI. If the error is recoverable, fix and let it retry. If not, terminate and re-run the migration.
- **Stale routing cache:** Restart API pods to clear the `CellRegistryService` in-memory cache.

### Escalation
- Cell serving > 10 tenants is completely down → SEV-1
- Tenant migration failure with data in inconsistent state → SEV-1, requires manual intervention
