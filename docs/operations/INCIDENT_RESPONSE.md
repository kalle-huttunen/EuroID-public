# Incident Response Runbook

## Severity Classification

| Level | Definition | Response Time | Example |
|-------|-----------|---------------|---------|
| **SEV-1** | Platform down, data loss risk | 15 min | MongoDB unreachable, encryption key loss |
| **SEV-2** | Major feature degraded | 1 hour | Temporal down, connector auth failures |
| **SEV-3** | Minor feature impact | 4 hours | Single connector failing, slow queries |
| **SEV-4** | Cosmetic / monitoring alert | Next business day | Elevated error rate, disk warnings |

## Incident Workflow

```
Detect → Triage (severity) → Mitigate → Root Cause → Fix → Post-Mortem
```

## Common Scenarios

### MongoDB Down (SEV-1)

**Symptoms:** API returns 500, health check fails
**Diagnose:**
```bash
docker compose ps euro-mongo          # Check container status
docker compose logs euro-mongo        # Check MongoDB logs
mongosh --eval "db.adminCommand('ping')"  # Test connectivity
```
**Mitigate:**
```bash
docker compose restart euro-mongo     # Restart container
# If data corruption:
docker compose down euro-mongo
docker volume rm euroid_mongo_data    # WARNING: data loss
docker compose up -d euro-mongo       # Fresh start + restore from backup
```
**Recovery:** Restore from latest `mongodump` backup (see [DISASTER_RECOVERY.md](../architecture/infrastructure/DISASTER_RECOVERY.md))

### Temporal Server Down (SEV-2)

**Symptoms:** Workflows don't start, provisioning stalls, worker logs show connection errors
**Diagnose:**
```bash
docker compose ps temporal            # Check container
docker compose logs temporal          # Check logs
curl http://localhost:8080            # Temporal UI accessible?
```
**Mitigate:**
```bash
docker compose restart temporal       # Restart
```
**Note:** In-flight workflows resume automatically after Temporal recovers. No data loss — Temporal persists workflow state to Postgres.

### Connector Auth Failure (SEV-3)

**Symptoms:** Provisioning fails for specific target, circuit breaker trips
**Diagnose:**
```bash
# Check circuit breaker state in logs
docker compose logs euro-worker | grep "CircuitBreaker"

# Verify connector config
curl -X POST http://localhost:3002/api/v1/connectors/<name>/health-check   # AD, Entra ID, SCIM; compose maps host 3002 to the API's 3001
```
**Mitigate:**
1. Check if target system credentials expired (OAuth token, API key)
2. Re-save connector config with fresh credentials
3. Circuit breaker auto-recovers after 30s (half-open state)

### High Memory / OOM (SEV-2)

**Symptoms:** Container restarts, `Killed` in logs
**Diagnose:**
```bash
docker stats                          # Check memory usage
docker compose logs euro-api | grep "heap"
```
**Mitigate:**
```bash
# Increase container memory limit
# In docker-compose.yml, add under service:
#   deploy:
#     resources:
#       limits:
#         memory: 2G

# Or tune Node.js heap
# NODE_OPTIONS=--max-old-space-size=1536
```
**Root cause candidates:**
- MongoDB cursor leak (check for missing `.lean()`)
- Large reconciliation batch (reduce `RECONCILIATION_BATCH_SIZE`)
- Unbounded query result (check pagination)

### Encryption Key Issues (SEV-1)

**Symptoms:** Connector configs unreadable, "decryption failed" errors
**Diagnose:**
```bash
# Verify env var is set
echo $ENCRYPTION_KEY | wc -c   # Should be >0; ENCRYPTION_KEY_PASSPHRASE or KMS_PROVIDER can supply the key instead

# Check key version mismatch
docker compose logs euro-api | grep "encryption"
```
**Mitigate:** See [DISASTER_RECOVERY.md](../architecture/infrastructure/DISASTER_RECOVERY.md) § Scenario 3: Encryption Key Lost for full recovery steps.

## Post-Mortem Template

After any SEV-1 or SEV-2 incident:

1. **What happened?** (timeline)
2. **What was the impact?** (users affected, duration)
3. **Root cause** (5 Whys)
4. **What fixed it?**
5. **Action items** (prevent recurrence)

Store post-mortems in `docs/operations/post-mortems/YYYY-MM-DD-title.md`.

## Monitoring Checklist

| Check | Method | Alert Threshold |
|-------|--------|----------------|
| API health | `GET /api/v1/health` | Fails 2x consecutive |
| MongoDB connections | `db.serverStatus().connections` | Available < 5 |
| Temporal worker | Worker log heartbeat | No heartbeat > 60s |
| Circuit breakers | Prometheus `euroid_circuit_breaker_state` (1 = open) | Any connector OPEN > 5min |
| Error rate | API 5xx count / total | > 5% over 5 min window |
| Memory | Container RSS | > 80% of limit |
| Disk | MongoDB data volume | > 85% capacity |
