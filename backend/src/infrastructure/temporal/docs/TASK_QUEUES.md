# Temporal Task Queues — Bulkhead Pattern

> **Module:** Infrastructure / Temporal
> **Cross-cutting:** [Temporal Workflows](../../../../../docs/architecture/infrastructure/TEMPORAL_WORKFLOWS.md) | [Connectors](../../../modules/connectors/docs/ARCHITECTURE.md)

> **Status:** Active (CURRENT_TASK_20)
> **Spec:** [roadmap/ROADMAP.md](../../../../../docs/architecture/roadmap/ROADMAP.md) Wave 1

---

## Overview

Each connector type has its own Temporal task queue so that a slow or failing connector (e.g., Entra ID rate-limited) cannot starve other connectors (AD, Okta, SCIM). This enables:

- **Fault isolation** — Entra issues don't block AD, Okta or SCIM provisioning
- **Per-connector scaling** — Scale Entra workers independently if Entra is the bottleneck
- **Operational visibility** — Queue-specific metrics and health

---

## Task Queue Mapping

| Connector   | Task Queue          | Activities                                                                 |
|-------------|---------------------|-----------------------------------------------------------------------------|
| Default     | `provisioning-default` | Workflows, config, identity, policy, HR, bulk provisioning, reconciliation; the connectors without a queue of their own: GitHub and ServiceNow offboarding (`deprovisionGitHubUser`, `deprovisionServiceNowUser`) and onboarding's health check and provision for GitHub, ServiceNow, Discord webhook, Google Sheets and File outbound (see below); the map is `src/worker-default-activities.ts` |
| Entra ID    | `provisioning-entra`   | `isEntraConfigured`, `checkEntraHealth`, `provisionUserToEntra`, `deleteUser`, `discoverEntitlements`, `enableEntraUser` and `disableEntraUser` (also a privileged session's), etc.; `revokeReviewAccess`, `applyMoverAccess` |
| AD          | `provisioning-ad`      | `checkAdHealth`, `provisionUserToAd`, `disableAdUser`, `deprovisionAdUser`, `createAdUser`, `setAdUserEnabled` (a privileged session); `revokeReviewAccess`, `applyMoverAccess` |
| SCIM        | `provisioning-scim`    | `checkScimHealth`, `provisionUserToScim`, `deprovisionScimUser`, `discoverScimEntitlements`, `setScimUserActive` (a privileged session); `revokeReviewAccess`, `applyMoverAccess` |
| Okta        | `provisioning-okta`    | `checkOktaHealth`, `provisionUserToOkta`, `disableOktaUser`, `deprovisionOktaUser`, `discoverOktaEntitlements`, `setOktaUserEnabled` (a privileged session: suspend, unsuspend); `revokeReviewAccess`, `applyMoverAccess` |

A connector queue's activities come from its plugin manifest (`activityBindings`), plus the access review's `revokeReviewAccess` (`AccessReviewRevocationActivities`) and the mover's `applyMoverAccess` (`MoverAccessActivities`, `activities/mover-access.activities.ts`), which `worker.ts` adds to the Entra, AD, Okta and SCIM queue workers through `accessReviewRevocationQueueActivities` and `moverAccessQueueActivities`. Both take ids only and read the identity or review item, the account and the connector config in the activity.

Onboarding and admin account provisioning call a target without a queue of their own on the default queue as `check<System>Health` and `provisionUserTo<System>`, `<System>` being the canvas system name with its first letter capitalised (`getHealthMethodName` in `onboarding-health-check.ts`, `getProvisionMethodName` in `onboarding.workflow.ts`). The activity type names therefore keep the canvas spelling, hyphen included; `defaultQueueTargetActivities` in `worker-default-activities.ts` registers them, and `worker-default-activities.spec.ts` fails when a provisioning connector without a `taskQueue` lacks either name:

| Target | Health check | Provision | Implementation |
|---|---|---|---|
| GitHub | `checkGithubHealth` | `provisionUserToGithub` | `GitHubActivities` (`github.activities.ts`) |
| ServiceNow | `checkServicenowHealth` | `provisionUserToServicenow` | `ServiceNowActivities` (`servicenow.activities.ts`) |
| Discord webhook | `checkDiscord-webhookHealth` | `provisionUserToDiscord-webhook` | `NoAccountTargetActivities` (`no-account-target.activities.ts`) |
| Google Sheets | `checkGoogle-sheetsHealth` | `provisionUserToGoogle-sheets` | `NoAccountTargetActivities` |
| File outbound | `checkFile-outboundHealth` | `provisionUserToFile-outbound` | `NoAccountTargetActivities` |

Renaming one is a workflow change (the workflow schedules the name): it needs a `patched()` guard and a replay test.

---

## How It Works

1. **Workflows** run on `provisioning-default`. All workflow tasks (orchestration logic) are executed by workers listening to that queue.

2. **Connector-specific activities** are routed to their queues via `taskQueue` in `proxyActivities`:

   ```typescript
   const entraProxy = proxyActivities<EntraActivities>({
     taskQueue: 'provisioning-entra',
     startToCloseTimeout: '1m',
   });
   await entraProxy.provisionUserToEntra(user, intent, config);
   ```

3. **Workers** subscribe to multiple queues. In development, a single process runs workers for all queues. In production, you can run separate worker processes per queue.

---

## Running Workers

### Option A: Single Process (Development)

One `npm run start:worker` creates workers for all queues in the same process:

- `provisioning-default` — workflows + generic + fallback
- `provisioning-entra` — Entra activities only
- `provisioning-ad` — AD activities only
- `provisioning-scim` — SCIM activities only
- `provisioning-okta` — Okta activities only

### Option B: Separate Processes (Production)

For production scaling, run one worker process per queue:

```bash
# Terminal 1 — default queue (workflows + generic)
TASK_QUEUE=provisioning-default npm run start:worker

# Terminal 2 — Entra (scale independently if Entra is slow)
TASK_QUEUE=provisioning-entra npm run start:worker

# Terminal 3 — AD
TASK_QUEUE=provisioning-ad npm run start:worker

# Terminal 4 — SCIM
TASK_QUEUE=provisioning-scim npm run start:worker
```

*Note: The current worker implementation registers all queues in one process. To support per-process deployment, add `TASK_QUEUE` env var handling to `worker.ts`.*

---

## Scaling Guidance

| Scenario              | Action                                                                 |
|----------------------|------------------------------------------------------------------------|
| Entra ID rate-limited | Scale `provisioning-entra` workers (more instances, more activity capacity) |
| AD slow              | Scale `provisioning-ad` workers independently                          |
| High bulk load       | Scale `provisioning-default` (workflow orchestration + bulk execution) |

---

## Configuration

- **Queue names:** `backend/src/infrastructure/temporal/task-queue.config.ts`
- **Helper:** `getTaskQueueForConnector(connectorType: string): string`
- **Adding a connector:** set `taskQueue` in its manifest (leave it out for `provisioning-default`); `worker.ts` creates that queue's worker from the manifest (`activityClass`, `activityBindings`), no code change there. Workflows reach the queue through `QUEUE_NAMES` (`proxyActivities({ taskQueue: QUEUE_NAMES[...] })`), so add it there and the proxies in the workflows that call it; `registerConnectorQueue()` exists but nothing calls it.

---

## Gotchas

- **Existing workflows** — Running workflows may still be on the old default queue. New workflows only. No migration of in-flight workflows.
- **Worker startup order** — If using separate workers, all must be running for full coverage. Workflows on `provisioning-default` will schedule activities on connector queues; those workers must be up.
- **Temporal SDK** — `Worker.create` accepts `taskQueue`. You can create multiple workers in one process, each with a different `taskQueue`.
