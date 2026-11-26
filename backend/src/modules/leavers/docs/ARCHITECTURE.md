# HR Leavers (`modules/leavers`)

> **Related:** [HR joiners](../../joiners/docs/ARCHITECTURE.md) · [Multi-HR ingestion](../../identity/docs/MULTI_HR_INGESTION.md) · [Connectors](../../connectors/docs/ARCHITECTURE.md) · [Temporal workflows](../../../../../docs/architecture/infrastructure/TEMPORAL_WORKFLOWS.md) · [Event bus](../../../../../docs/architecture/core/EVENT_BUS_ARCHITECTURE.md) · [User flows, Flow 10](../../../../../docs/USER_FLOWS.md)

Offboards people when the HR source says they left, without anyone calling `DELETE /identity/:id`. Every HR ingest (manual `POST /connectors/:name/ingest`, or the scheduled `scheduledSyncWorkflow`) ends with leaver detection for the source it read. Leavers start the existing `offboardingWorkflow` through `IDENTITY_OFFBOARD_REQUESTED`, the same event the manual delete uses. A sync that would offboard too many people starts nobody and leaves a batch for an admin.

## Flow

```mermaid
sequenceDiagram
    participant S as HR sync (HrIngestionService)
    participant H as LeaverSyncHandler
    participant D as LeaverDetectionService
    participant X as LeaverExecutionService
    participant O as OffboardingService
    participant T as Temporal
    S->>H: HR_SYNC_COMPLETED (emitAndWait, counts only)
    H->>D: evaluateSync(tenant of the sync context)
    D->>D: record hr_sync_runs, evaluate signals per identity
    alt leavers <= mass-leaver allowance
        D->>X: startQueued(source)
        X->>O: IDENTITY_OFFBOARD_REQUESTED {reason: leaver:*}
        O->>T: start offboardingWorkflow (t-{tenant}-offboard-{id})
    else above the allowance
        D->>D: leaver_batches (pending) + events pending-approval
        Note over D: admin approves -> answer, then startQueued(batch); rejects -> closed
    end
    H-->>S: LeaverSyncSummary (IngestResult.leavers)
```

When this handler has answered, HR ingestion emits `HR_SYNC_MOVERS_REQUESTED` for HR mover detection (`modules/mover/docs/ARCHITECTURE.md`), which leaves every identity with an open leaver event, or a started offboarding without a result, alone, and then `HR_SYNC_JOINERS_REQUESTED` for HR joiner detection (`modules/joiners/docs/ARCHITECTURE.md`), which never onboards an identity this run's leaver detection raised an event for (a person who joins and is marked terminated in the same export). A failed leaver detection skips both for that run.

## Signals

Evaluated by the pure functions in `leaver-signals.ts`, one reason per identity, first match wins:

| Reason | Fires when | Effective |
|---|---|---|
| `terminated` | The HR status word (`customAttributes.hrStatus`, else the record's `status`) is in `terminatedStatuses`, compared without case | At once; with an end date, once that day is over |
| `end-date` | The HR end date (or termination date) is over | The day after the end date, in the policy time zone |
| `missing-from-source` | The person was not delivered by the source's last `missingSyncThreshold` full syncs | After the last of them |

- **Which data.** Detection reads the authoritative source's own record (`identity.sources[].rawData` of the syncing source), not the merged `profile`: the profile holds the merge of every source, and a field the feed dropped is cleared only when that source owns it (`identity/docs/MULTI_HR_INGESTION.md`, Survivorship Rules).
- **Authoritative source only.** A source decides about an identity only when it is `metadata.primaryHrSource`; with no primary resolved (no reconciliation config), when the identity was created from it (`sources[0]`). A secondary contract ending never offboards the person.
- **End of day.** A date-only HR value (`2026-11-20`, stored as UTC midnight) keeps its calendar day; a timestamp is read in the policy `timezone`. The day is over when the calendar day in that zone has moved past it.
- **Full sync.** A run counts toward `missing-from-source` only when it fetched rows, the connector skipped none (no id or email) and every row saved. A failed fetch reports nothing; a partial or empty run is recorded but never counts and never detects anyone as missing (it still detects terminated and end-date leavers).
- **Rehires.** A departure after a rehire is a new leaver event: the event key also names `metadata.rehiredAt` (set when the Hub revives a rehired identity, `identity/docs/MULTI_HR_INGESTION.md`), so a second leave with the same HR status word and no end date is not taken for the first departure. An identity never rehired keeps the key it had, so its existing events still match. Before the final sweep of 2026-11-23 such a second leave was never offboarded.
- **Miss counting.** No counter is stored: `hr_sync_runs` keeps each run's start, and a person is missing when their `sources[].lastSync` is older than the start of the oldest of the last N full runs. Delivering the person again moves `lastSync`, which resets the count.

## Mass-leaver safety

`massLeaverAllowance = max(massLeaverMinCount, min(massLeaverMaxCount, floor(activeIdentities * massLeaverMaxPercent / 100)))` (`leaver-signals.ts`), the HR mover policy's shape; active identities are the tenant's non-deleted identities whose status is not `TERMINATED` or `DELETED`. A run with more new leavers than the allowance creates one `leaver_batches` document (`pending`) and stores every leaver as `pending-approval`; nothing starts. With the defaults (10, 5 %, floor 2) a sync starts up to 2 leavers on its own below 60 active identities, 5 % from 60 and 10 from 200 on; without the floor a tenant below 20 active identities needed approval for every leaver (5 % of 19 is under 1). The floor never exceeds the count limit: the API rejects such a policy, and a policy stored before the floor existed reads `min(LEAVER_MASS_MIN_COUNT, massLeaverMaxCount)`, so a count limit of 0 still sends every leaver to approval.

- `POST /leavers/batches/:id/approve` moves the batch to `approved` (only from `pending`, else 409), skips any missing-from-source member the feed delivered again since detection (`superseded`), queues the rest, emits `leaver.batch_approved` and answers with the members `queued`. The offboardings start after the answer (`LeaverBatchService.startAfterAnswer`, in the tenant context, actor the approver): `startQueued` for the batch, one start after the other, then the batch's `startedCount`. Before, the approval waited for every start, 30 to 45 s per member with Temporal down.
- `POST /leavers/batches/:id/reject` moves it to `rejected` and closes its members. The same evidence never raises them again; changed HR data does.
- While a batch waits, its members are open events, so further syncs do not raise them again or create another batch.

## Exactly one offboarding per leaver event

| Guard | Where |
|---|---|
| One event per identity, source, reason and evidence, and after a rehire its `rehiredAt` (`eventKey`, unique index) | `leaver_events` |
| At most one open event (`pending-approval`, `queued`) per identity (partial unique index on `open: true`) | `leaver_events` |
| A start is claimed atomically (`claimedAt`, abandoned after `LEAVER_START_CLAIM_TIMEOUT_MS`) | `LeaverExecutionService.startOne` |
| One start waits at most `HR_START_TIMEOUT_MS` (default 10 s), then counts as failed. If it lands later, the next try finds the workflow running (`WorkflowExecutionAlreadyStartedError`) or, once that run finished, its offboarding record finished after the event's first attempt (`startAttemptedAt`): either counts as the event's offboarding, never a second one. A workflow id reuse policy cannot do this: the id is per identity, not per leaver event, so it would also refuse a rehire's later offboarding | `LeaverExecutionService.startOne` |
| A running workflow with the same id counts as started (`WorkflowExecutionAlreadyStartedError`) | `LeaverExecutionService` |
| Deterministic workflow id `t-{tenant}-offboard-{identityId}` | `OffboardingService.triggerOffboarding` |

A failed start (Temporal down, or no answer within `HR_START_TIMEOUT_MS`) stays `queued` with `startError`, and the source's next sync retries it. The batch items (`GET /leavers/batches`) carry `startError` as joiner items do: the batch history shows it on the member's status. The approve answer comes before any start, so its members are `queued` without `startError`, and the approval toast says the offboardings are starting ("Starting N offboardings"; a warning names members not started, such as one back in the feed). An identity already deleted when its start comes up is closed as `superseded`.

## Tenancy and actors

- The tenant is the sync's context: the request tenant for a manual ingest, the workflow input tenant in the scheduled-sync activity (`withTenantContext`). `LeaverSyncHandler` takes it from the event metadata, and every query names it explicitly on top of the tenant plugin.
- API routes take the tenant and the actor (`decidedBy`, `updatedBy`, the audit actor) from the authenticated user; bodies are strict Zod objects, so a body naming an actor or tenant is a 400.

## Audit and timeline

Every step is a domain event, so the wildcard `AuditEventHandler` audits it: `connector.hr_sync_completed`, `identity.leaver_detected`, `leaver.batch_paused`, `leaver.batch_approved` / `leaver.batch_rejected` (actor and comment; an approval since 2026-11-24 carries no `started` count, each start being its own event), `identity.leaver_offboarding_started` (workflow id), `leaver.policy_updated` (changed fields), `identity.offboarding_target_removed_manually` (admin, target, note). `LeaverTimelineHandler` puts the detection (`LEAVER_DETECTED`, noting a paused batch) and the started offboarding (`WORKFLOW_STARTED`) on the identity timeline. When the offboarding finishes (or stops with a failed target), `identity.offboarding_completed` carries its per-system result: `OffboardingTimelineHandler` adds one `USER_DEPROVISIONED` entry per target system and a `WORKFLOW_COMPLETED` summary, and `LeaverOffboardingResultHandler` stores it as the offboarding record of that workflow id (`offboarding_records`: `{ workflowId, identityId, status, hubStatus, systems[], linkedAdmins[], finishedAt }`, one per workflow id, a rerun replaces it; `linkedAdmins` is what became of the person's linked admin accounts, each offboarded first by its own child offboarding, absent on records from before 2026-11-25) for every offboarding, whether a leaver event or `DELETE /identity/:id` started it, and marks the started leaver event of that workflow finished (`offboardingFinishedAt`, which the HR mover reads). Batch members show the record of their workflow id. The offboarding workflow's memo carries `reason: leaver:<reason>`. Leaver payloads carry ids and reasons only, no names or emails.

## Failed targets: removed manually

An offboarding that could not remove access in a target (an accepted GitHub invitation, an account EuroID cannot find, a target that keeps rejecting the call) leaves that target `failed` and the Golden Record suspended. When an admin has removed the account in the target system by hand, they close the target on the Leavers page (`LeaverManualRemovalService`). The action is keyed by the offboarding's workflow id, so it works the same for an HR leaver and for an offboarding started by `DELETE /identity/:id` (deleting the user), which has no leaver event:

- Only a target the offboarding record has `failed`, and only once: the result entry is flipped atomically (`findOneAndUpdate` on `systems` matching `{ system, outcome: 'failed' }`), so a second admin gets 409.
- Closing the last failed target (no other target and no linked admin account of the record `failed`) deletes the person, so it is refused while one of the person's linked admin identities is live (`findLiveLinkedAdmins`, `modules/identity/linked-admin-identities.ts`: its offboarding runs elsewhere, or it was linked after the offboarding): the entry goes back to `failed`, no event goes out, and the answer is 409 naming the admin identities. Offboard them first.
- The entry becomes `outcome: removed-manually` with `manualRemoval: { by, at, reason }` (the authenticated user and their required note); the original failure `reason` stays. The UI shows it as "Removed manually", never as removed by EuroID.
- `identity.offboarding_target_removed_manually` goes out with `emitAndWait`. Its identity handler (`infrastructure/events/handlers/offboarding-manual-removal.handler.ts`, registered by IdentityModule) marks the target's provisioning entry `DEPROVISIONED` (a re-run of offboarding skips it) and, when the flip left no target `failed` and no linked admin account of the record `failed`, soft-deletes the Golden Record with `markAsDeleted`, the path and `identity.deleted` audit of a fully successful offboarding, with the admin as actor. The record then reads `completed` / `deleted`. The event names the leaver event (`leaverEventId`) only when one started the offboarding. If the identity update fails, the entry goes back to `failed` and the request fails.
- Audit: the wildcard handler records the event (admin, note, target); the identity timeline gets "Removed manually: <system>" and, for the last one, "Offboarding completed".

A linked admin account whose offboarding failed has its own record (its own workflow id), where its failed target is closed the same way; the person's record keeps the account `failed` and the person suspended, so a leaver is never deleted while an admin account may still exist. The offboarding workflow reads the person's linked admin identities again right before the delete: one still live then (its offboarding elsewhere had not finished, or it was linked meanwhile) is recorded `failed` with a reason saying to rerun the person's offboarding once it has finished, and the record is on this list. Once the admin account is cleared, offboard the person again (`DELETE /identity/:id`): the rerun finds no live admin account and nothing left to remove, and deletes the Golden Record.

The Failed offboardings tab lists every offboarding record that still has a `failed` target or linked admin account (`GET /leavers/open-offboardings`): HR leavers, batch members or not, with the reason and source of their leaver event, and deleted users ("User deleted"). Results stored on leaver events before offboarding records existed move there with `migrations/20261122000002-offboarding-records-from-leaver-events.ts`.

## Policy (per tenant)

Stored in `leaver_policies` (one document per tenant). A tenant without one gets the defaults, which come from the environment:

| Field | Default | Env |
|---|---|---|
| `signals.terminated`, `signals.endDate`, `signals.missingFromSource` | all `true` | |
| `terminatedStatuses` | `terminated, inactive, left` | `LEAVER_TERMINATED_STATUSES` |
| `missingSyncThreshold` | `3` | `LEAVER_MISSING_SYNC_THRESHOLD` |
| `massLeaverMaxCount` | `10` | `LEAVER_MASS_MAX_COUNT` |
| `massLeaverMaxPercent` | `5` | `LEAVER_MASS_MAX_PERCENT` |
| `massLeaverMinCount` | `2` (at most `massLeaverMaxCount`) | `LEAVER_MASS_MIN_COUNT` |
| `timezone` | `UTC` (tenants have no time zone setting of their own) | `LEAVER_DEFAULT_TIMEZONE` |

`hr_sync_runs` expire after `HR_SYNC_RUN_RETENTION_DAYS` (180).

## HR field mapping

Connectors map, they do not decide (`connectors/hr/hr-lifecycle-fields.ts`): the HR status word goes verbatim to `customAttributes.hrStatus`, the end or termination date to `endDate`. Default columns: CSV `Status`, `Employment Status`, `End Date`, `Termination Date`; JSON `status`, `employment_status`, `employmentStatus`, `end_date`, `endDate`, `termination_date`, `terminationDate`. A connector's `columnMap` (CSV) or `fieldMap` (JSON) maps other names to `hrStatus` or `endDate`.

## API

All routes require `policy-admin` (or `super-admin`).

| Method | Path | |
|---|---|---|
| GET | `/api/v1/leavers/batches?status=pending\|approved\|rejected` | Newest 50 batches with their identities (name, email, reason, effective date, status, workflow id, and `offboarding` once the workflow finished: per-system outcome and whether the Golden Record was deleted or suspended) |
| POST | `/api/v1/leavers/batches/:id/approve` | Body `{ comment? }`. Approves the batch and answers with its members queued; the offboardings start right after. 404 for another tenant's batch, 409 when already decided |
| POST | `/api/v1/leavers/batches/:id/reject` | Body `{ comment? }` |
| GET | `/api/v1/leavers/open-offboardings` | Newest 50 offboardings whose result has a `failed` target or linked admin account, leaver or user delete: `{ workflowId, identityId, displayName, email?, leaver?: { leaverEventId, sourceName, reason, effectiveDate? }, offboarding }` |
| POST | `/api/v1/leavers/offboardings/:workflowId/removed-manually` | Body `{ system, reason }` (both required). Closes that failed target as removed by hand; answers the updated offboarding; 404 for an unknown workflow id (or another tenant's), 409 when the target is not `failed`, or when it is the last failed one and a linked admin identity of the person is still live (the message names it) |
| GET | `/api/v1/leavers/policy` | The policy, `configured: false` while on the defaults |
| PUT | `/api/v1/leavers/policy` | The whole policy; an unknown time zone is a 400 |

UI: Governance > Joiners, movers and leavers (`frontend/src/features/leavers/`): pending batches with approve/reject confirmation, failed offboardings (every offboarding that left a target or a linked admin account failed, HR leaver or deleted user, with [Mark removed] next to the failed system), decided batches (each identity's offboarding result per target system, with the same action; both show a tag per linked admin account, "Admin account: Offboarded", "Failed" or "Offboarding elsewhere", hover: the admin identity and the reason), the HR joiners tab (joiner batches and the mass-joiner limit, `modules/joiners/docs/ARCHITECTURE.md`), the HR movers tab (mover batches and the mass-mover limit, `modules/mover/docs/ARCHITECTURE.md`), and the policy form. The joiner path reads this policy's `timezone` and `terminatedStatuses` for start and end dates and "left" words.

## Limits

- Detection runs when a source syncs. With "Manual only" sync, an end date passes unnoticed until the next ingest.
- Leaver detection starts offboarding from the service, like the manual delete. What the workflow does per target system (and its patch `offboarding:per-system-results`): `docs/architecture/infrastructure/TEMPORAL_WORKFLOWS.md`, Offboarding Workflow Flow.
- Leavers started without a batch (under the mass-leaver allowance) have no Leavers-page row unless their offboarding left a target failed (Failed offboardings tab); their result is on the identity timeline.

## Files

| File | Role |
|---|---|
| `leaver-signals.ts` | Pure signal rules, end-of-day in a zone, mass-leaver allowance, event key |
| `leaver-detection.service.ts` | One sync: record the run, find leavers, pause or queue |
| `leaver-execution.service.ts` | Claim and start queued events through `IDENTITY_OFFBOARD_REQUESTED`, each start with a timeout |
| `leaver-batch.service.ts` | List, approve (starts after the answer), reject batches |
| `leaver-policy.service.ts`, `leaver-policy.defaults.ts` | Per-tenant policy and env defaults |
| `leaver-sync.handler.ts` | `HR_SYNC_COMPLETED` listener |
| `leaver-offboarding-result.handler.ts` | Stores `identity.offboarding_completed` as the offboarding record; marks the leaver event finished |
| `leaver-manual-removal.service.ts` | Failed offboardings list (any trigger); close a failed target as removed manually, by workflow id |
| `leaver-items.ts` | Leaver events and offboarding records as page items (name, email, result, leaver event); `identityNames` is also used by the HR mover batches |
| `leavers.controller.ts`, `dto/leaver.dto.ts` | HTTP API and Zod schemas |
| `schemas/` | `leaver_policies`, `leaver_events`, `leaver_batches`, `hr_sync_runs`, `offboarding_records` |

Tests: `leaver-signals.spec.ts`, `leaver-detection.integration.spec.ts` and `leaver-manual-removal.integration.spec.ts` (in-memory MongoDB), `leavers.controller.spec.ts` (HTTP, roles), `backend/test/workflows/hr-leaver.workflow.e2e-spec.ts` (Temporal time-skipping, `TEMPORAL_E2E=1`).
