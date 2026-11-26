# ADR-002: Temporal for Workflow Orchestration

**Status:** Accepted
**Date:** 2026-02-23
**Author:** EuroID Team

## Context

EuroID's core operations — onboarding, offboarding, role changes, reconciliation — are multi-step distributed processes. For example, onboarding a user requires:

1. Sync identity from HR source
2. Compute provisioning plan via Policy Engine
3. Create accounts in Entra ID
4. Create accounts in Active Directory
5. Wait for sync confirmation
6. Send welcome notification

If step 3 fails due to an API outage, the system must retry automatically. If step 4 fails after step 3 succeeds, the system must compensate (roll back step 3). Standard Promise chains or cron jobs cannot provide this durability, and manual retry logic is error-prone and inconsistent across workflows.

## Decision

Use **Temporal.io** as the sole orchestration engine for all multi-step workflows. Key design rules:

1. **Pure workflows:** Workflow functions contain only deterministic logic. No `Date.now()`, `Math.random()`, `fetch()`, or any I/O. Temporal replays workflow history on recovery — non-deterministic code causes replay divergence.
2. **Activities for I/O:** All side effects (API calls, database writes, notifications) are implemented as Temporal Activities. Activities are independently retryable and configurable.
3. **Configured retry limits:** Every activity specifies `maximumAttempts` and lists non-retryable error types (e.g., `400 Bad Request`). Default "retry forever" is never used.
   In the code this holds for the activities that take a policy from `backend/src/infrastructure/config/retry-policies.ts` (connector calls, health checks, queries, batches, reconciliation, access review, archival, scheduled sync).
   Other activity proxies set no retry policy and get Temporal's default (unlimited attempts), for example in `access-request-approval.workflow.ts`, `orphan-cleanup.workflow.ts`,
   `onboarding.workflow.ts` (HR, identity, policy, writeback activities) and `offboarding.workflow.ts`.
4. **Saga compensation:** Workflows implement compensating activities for rollback. If step N fails, steps 1..N-1 are reversed in order.
5. **Task queues:** Separate task queues per connector to isolate blast radius: `provisioning-entra`, `provisioning-ad`, `provisioning-scim`, `provisioning-okta` (a manifest's `taskQueue`).
   Workflows and all other activities run on `provisioning-default` (`backend/src/infrastructure/temporal/task-queue.config.ts`, `backend/src/worker.ts`).
6. **Tenant isolation:** Workflow IDs prefixed with `t-{tenantId}-` and filtered via Temporal's `TenantId` search attribute.

## Consequences

### Positive
- Durable execution: workflows survive process crashes, restarts, and deployments
- Deterministic replay: full workflow history enables debugging and time-travel
- Built-in retry, timeout, and heartbeat support for activities
- Signal support: workflows can receive external signals (e.g., approval events) and react
- Visibility: Temporal Web UI provides workflow state inspection and manual intervention

### Negative
- Operational dependency on Temporal server (must be deployed, monitored, and maintained)
- Learning curve: developers must understand deterministic constraints and avoid common pitfalls
- Testing requires Temporal test server or careful mocking of workflow/activity boundaries

### Risks
- Temporal server outage blocks all workflow execution (mitigated by Temporal's own persistence layer and cluster HA)
- Workflow versioning complexity: changing workflow logic for in-flight workflows requires Temporal's patching/versioning API

## Alternatives Considered

| Option | Pros | Cons |
|--------|------|------|
| BullMQ job queues | Simple setup, Redis-backed, familiar Node.js API | No saga support, no deterministic replay, manual retry logic, no signal/query support |
| AWS Step Functions | Managed service, visual workflow editor | Vendor lock-in (AWS), JSON-based state machine language, cold start latency, limited local testing |
| Custom saga framework | Full control, no external dependency | High development cost, no replay/visibility, must build retry/timeout/compensation from scratch |
