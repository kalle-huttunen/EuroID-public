# Rollback Procedures

This document describes rollback procedures for EuroID deployments, database changes, Temporal workflows, and canary deployments.

> **Related docs:**
> - [Disaster Recovery](../architecture/infrastructure/DISASTER_RECOVERY.md) — backup/restore and recovery objectives
> - [Incident Response](INCIDENT_RESPONSE.md) — severity classification and incident workflow
> - [Alerting Thresholds](ALERTING_THRESHOLDS.md) — automated rollback trigger signals

---

## 1. Application Rollback

### Docker Image Tagging Strategy

Every release produces a Docker image tagged with both:
- **Semver:** `euroid-api:1.5.2`, `euroid-worker:1.5.2`
- **Git SHA:** `euroid-api:abc1234`, `euroid-worker:abc1234`

The `latest` tag always points to the most recent production release. Previous images are retained for at least 30 days.

### Kubernetes Rollback

```bash
# Check rollout history
kubectl rollout history deployment/euroid-api

# Rollback to previous revision
kubectl rollout undo deployment/euroid-api

# Rollback to specific revision
kubectl rollout undo deployment/euroid-api --to-revision=3

# Verify rollback
kubectl rollout status deployment/euroid-api
```

Repeat for `euroid-worker` deployment if worker code was also changed.

### Database Migration Rollback

Migrations are categorized by reversibility:

| Migration Type | Reversible | Rollback Method |
|----------------|------------|-----------------|
| Add field (with default) | Yes | Remove field, drop index if added |
| Add index | Yes | Drop index |
| Rename field | Risky | Rename back (but downstream code may have already adapted) |
| Remove field | No | Restore from backup (field data is lost) |
| Change field type | No | Restore from backup |

**Rule:** There is no feature flag system, so new behavior cannot be switched off without a deployment. Take a backup before deploying an irreversible migration (section 2).

### Reverting a Migration

Migrations run with migrate-mongo: files in `backend/migrations/`, applied ones recorded in the `migration_changelog` collection. From `backend/`:

1. `npm run migrate:status` lists applied and pending migrations.
2. `npm run migrate:down` runs the `down` of the last applied migration only. Run it once per migration to revert.
3. Read the migration's `down` first. In `20260222000000-baseline` and `20261124000000-deprovisioned-writeback-incomplete` it does nothing;
   in `20261123000001-identity-email-unique-among-live` it changes no index and fails while two identities of a tenant (deleted ones included) share an email.

---

## 2. MongoDB Rollback

### Backup and Restore

See [Disaster Recovery](../architecture/infrastructure/DISASTER_RECOVERY.md) for full backup strategy. Summary:

| Method | RPO | Use Case |
|--------|-----|----------|
| Continuous backup (Atlas/Ops Manager) | Minutes | Production point-in-time recovery |
| `mongodump` scheduled | Hours | Staging/dev restore |
| Oplog-based PITR | Seconds | Fine-grained recovery within backup window |

### Point-in-Time Recovery

If a deployment corrupts data:

1. Identify the timestamp just before the corruption (from deployment logs)
2. Restore to that point using MongoDB's point-in-time recovery (Atlas: Backup → Restore → Point in Time)
3. Verify data integrity on the restored instance
4. Switch application to the restored instance

### Schema Migration Reversion Checklist

When rolling back a schema change:

- [ ] Identify all indexes added/modified by the migration
- [ ] Verify no application code depends on the new schema (check all deployed services)
- [ ] Run the rollback script (drop indexes, remove fields) on a staging copy first
- [ ] Verify application health on staging with the rolled-back schema
- [ ] Execute on production during a maintenance window
- [ ] Monitor for errors for 30 minutes post-rollback

---

## 3. Temporal Rollback

### Workflow Versioning

Temporal supports running multiple versions of workflow code simultaneously using the **patching API**:

```typescript
import { patched } from '@temporalio/workflow';

export async function onboardingWorkflow(input: OnboardingInput) {
  if (patched('new-provisioning-logic')) {
    // New code path
    await newProvisioningActivity(input);
  } else {
    // Old code path (for in-flight workflows started before this deploy)
    await legacyProvisioningActivity(input);
  }
}
```

**Rules:**
- Never remove the old code path until all in-flight workflows started before the deploy have completed
- Use `patched()` for additive changes; use `deprecatePatch()` to mark old paths for removal
- In this repo, workflows call `isPatched('<workflow>:<change>')` and `deprecatePatch()` from `backend/src/workflows/workflow-versioning.ts`
  (for example `onboarding:skip-synced-targets`, `offboarding:per-system-results`). A patched change comes with a history recorded before it,
  `backend/test/fixtures/<workflow>-pre-<change>.history.json`, which its e2e spec in `backend/test/workflows/` replays with `Worker.runReplayHistory`
  (`TEMPORAL_E2E=1 npm run test:e2e`, run by the pre-push hook)
- Workflow IDs include a version indicator when breaking changes are introduced

### Worker Backward Compatibility

When deploying a new worker version:

1. **Before deploy:** Verify the new worker code handles both old and new activity signatures
2. **During deploy (rolling update):** Old and new workers run simultaneously. Temporal routes tasks to available workers.
3. **After deploy:** Monitor for `NonDeterminismError` in worker logs — this indicates workflow replay divergence

If `NonDeterminismError` appears:
1. Stop the new workers immediately
2. Roll back to the previous worker version
3. Investigate the determinism violation (typically `Date.now()`, `Math.random()`, or reordered activity calls)

### Payload Codec

The API and the worker encrypt every Temporal payload (`backend/src/infrastructure/temporal/temporal-payload-codec.ts`, encoding `binary/encrypted`).
Do not roll back to a build without the codec while workflows started with it are running or their results are still read:
such a worker fails their tasks (unknown encoding `binary/encrypted`) and such an API cannot read their results, until a build with the codec runs again.
The workflows keep their state, but an activity whose encrypted input such a worker picks up fails its attempts and can run out of retries.
Details: [DEPLOYMENT.md](../DEPLOYMENT.md) § Production Checklist, Temporal payload encryption.

### In-Flight Workflow Handling

During a deployment, in-flight workflows are handled as follows:

| Scenario | Behavior |
|----------|----------|
| Worker restarts | Temporal automatically retries the current activity on another worker |
| Activity timeout during deploy | Activity retries after the new worker is healthy |
| Workflow code changed (with patches) | In-flight workflows follow the old code path via `patched()` |
| Workflow code changed (without patches) | Risk of `NonDeterminismError` — avoid this |

**Safe deployment sequence:**
1. Deploy new workers (rolling update — old workers keep running until new ones are healthy)
2. Verify no `NonDeterminismError` in logs (wait 5 minutes)
3. Deploy new API pods
4. Monitor Temporal Web UI for workflow health

---

## 4. Canary Deployment

### Traffic Shift Strategy

The recommended canary deployment follows a gradual traffic shift:

| Phase | Traffic to Canary | Duration | Auto-Rollback Trigger |
|-------|-------------------|----------|-----------------------|
| 1 — Canary | 10% | 15 minutes | Error rate > 5% or p95 > 1000ms |
| 2 — Partial | 50% | 15 minutes | Error rate > 2% or p95 > 800ms |
| 3 — Full | 100% | — | Standard alerting thresholds |

### Canary Deployment Steps

1. Deploy the new version to a canary pod group (separate deployment or label selector)
2. Configure the ingress/service mesh to route 10% of traffic to canary pods
3. Monitor canary metrics for 15 minutes (error rate, latency, logs)
4. If healthy, shift to 50% and monitor for 15 more minutes
5. If healthy, promote to 100% (update the main deployment)
6. If unhealthy at any stage, route 100% back to the stable deployment

### Automated Rollback

Configure the deployment pipeline to automatically rollback if:
- Canary error rate exceeds the phase threshold (see table above)
- Health endpoint returns non-200 on canary pods
- Canary pods enter crash loop

### Worker Canary Deployment

Workers require a slightly different approach since Temporal distributes tasks across all available workers:

1. Deploy 1 canary worker pod alongside existing workers
2. Monitor for `NonDeterminismError` and activity failure rates
3. If healthy after 15 minutes, proceed with rolling update of all worker pods
4. Watch Temporal task queue depth during the canary phase. Worker autoscaling by queue depth (KEDA) is not built and the repo has no Kubernetes manifests ([FUTURE_KEDA_SCALING.md](../architecture/future/FUTURE_KEDA_SCALING.md))
