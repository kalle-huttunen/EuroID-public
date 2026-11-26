# HR Joiners (`modules/joiners`)

> **Related:** [HR leavers](../../leavers/docs/ARCHITECTURE.md) · [Mover](../../mover/docs/ARCHITECTURE.md) · [Multi-HR ingestion](../../identity/docs/MULTI_HR_INGESTION.md) · [Temporal workflows, Onboarding Flow](../../../../../docs/architecture/infrastructure/TEMPORAL_WORKFLOWS.md) · [Event bus](../../../../../docs/architecture/core/EVENT_BUS_ARCHITECTURE.md) · [User flows, Flow 1](../../../../../docs/USER_FLOWS.md)

Onboards the people an HR sync adds, without anyone pressing [Provision] for each of them. An HR sync mints a Golden Record for every new HR row (identity correlation); the joiners module records each minted identity as a joiner and starts its onboarding through `IDENTITY_PROVISION_REQUESTED`, the event `POST /identity?triggerWorkflow=true` uses, so `OnboardingService.triggerOnboarding` starts the existing `onboardingWorkflow` (one run per person, workflow id `t-{tenant}-onboard-{identityId}`). It is the sibling of the HR-driven leaver (`modules/leavers`) and mover (`modules/mover`): same mass limit, same batch approval, same roles.

## Flow

```mermaid
sequenceDiagram
    participant S as HR sync (HrIngestionService)
    participant L as LeaverSyncHandler
    participant M as HrMoverSyncHandler
    participant H as JoinerSyncHandler
    participant D as JoinerDetectionService
    participant O as OnboardingEventHandler
    participant T as Temporal
    S->>L: HR_SYNC_COMPLETED (emitAndWait)
    L-->>S: LeaverSyncSummary (this run's leavers recorded)
    S->>M: HR_SYNC_MOVERS_REQUESTED (emitAndWait)
    M-->>S: MoverSyncSummary
    S->>H: HR_SYNC_JOINERS_REQUESTED (emitAndWait, same counts-only payload)
    H->>D: evaluateSync(tenant of the sync context)
    D->>D: joiner_events (waiting) for the identities this run minted
    alt partial run, or pipeline not DEPLOYED
        Note over D: nothing starts, the joiners wait for the next full sync
    else due joiners <= mass-joiner allowance
        D->>O: IDENTITY_PROVISION_REQUESTED {reason: joiner:hr-sync:<source>} (no email: O reads it by id)
        O->>T: start onboardingWorkflow (t-{tenant}-onboard-{identityId})
    else above the allowance
        D->>D: joiner_batches (pending) + events pending-approval, event joiner.batch_paused
        Note over D: admin approves -> answer, then each member read again and started; rejects -> closed
    end
    H-->>S: JoinerSyncSummary (IngestResult.joiners)
```

### Order: leavers, movers, joiners

Joiner detection runs last, after leaver detection answered and after mover detection:

- **After leavers.** A person who joins and is marked terminated in the same export gets a leaver event from leaver detection first; joiner detection then sees it (and the HR status word) and closes the joiner instead of onboarding someone who left. A failed leaver detection skips joiner detection for that run, as it skips the mover's.
- **After movers.** The two sets do not overlap: the mover needs a provisioned identity (a `SYNCED` target), a joiner has no provisioning at all. Running joiners last leaves the existing leaver and mover steps exactly as they were, and mover detection never looks at an identity whose onboarding this run has just started.

## Who is a joiner, and when it starts

**Recording.** Every HR run, full or partial, records each identity minted from its source as a `joiner_events` document (`waiting`): created from the source (`sources[0]`, the record identity correlation minted it with), not soft-deleted, and created since the source's previous recording (`joiner_sources.recordedUntil`; a source recorded for the first time: since the run started). The cursor only moves when joiner detection ran, so the identities of a run whose joiner detection failed or did not run (a failed leaver detection) are recorded by the next run of the source. One joiner per identity and hire (unique index on `tenantId`, `identityId`, `rehiredAt`; existing databases get it from migration `20261123000000-joiner-events-one-per-hire`): re-ingesting the same export, or any later sync, never raises it again. Identities that existed before (created by a sync before this module, by hand, by SCIM) are not joiners; an operator onboards them from the Users page.

**Rehires.** A rehire a sync revives (an active HR row of a soft-deleted identity whose start date is after the deletion, `identity/docs/MULTI_HR_INGESTION.md`) is a joiner of that source like a minted identity: correlation marks it `metadata.rehiredAt` / `rehiredFrom`, and the run records a joiner with that `rehiredAt` (a joiner of the earlier hire still open is closed `superseded`). The same gate, mass limit and start-date hold apply. Revival closes the earlier employment's provisioning entries (`DEPROVISIONED`, writeback undone), and for a rehire joiner a `DEPROVISIONED` entry last written before `rehiredAt` does not count as onboarded, so onboarding provisions every target again and writes the new accounts back. Its timeline entry reads "Rehired in the <source> sync" (`identity.joiner_onboarding_started` carries `rehire: true`). Rehires revived before 2.8 have no marker and stay with the Users page.

**Starting.** A full run of a source (rows fetched, none skipped, none failed; the rule the leaver and mover use) then looks at every `waiting` joiner of that source, oldest first (`joiner-candidates.ts`, first match wins):

| Finding                                                                                                                                                                                                                        | Outcome                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| The identity is gone or soft-deleted                                                                                                                                                                                           | closed `superseded`                               |
| It already has provisioning entries (an operator onboarded it, or a run is under way)                                                                                                                                          | closed `superseded`                               |
| Its status is `TERMINATED` or `DELETED`; its HR record's status word is one of the leaver policy's `terminatedStatuses`; its HR end date is over; an HR leaver event is open or started for it (a rejected one does not count) | closed `superseded`: left in HR                   |
| No email                                                                                                                                                                                                                       | closed `superseded`                               |
| Status `SUSPENDED` or `INACTIVE`                                                                                                                                                                                               | waits                                             |
| This full run did not deliver the person                                                                                                                                                                                       | waits                                             |
| The HR start date is after today                                                                                                                                                                                               | waits: due at the first sync on or after that day |
| HR sent a start date that is not a date (`customAttributes.startDateUnreadable`)                                                                                                                                                | waits, also at a batch approval: until a sync reads a valid date, or an operator provisions by hand |
| Otherwise                                                                                                                                                                                                                      | due                                               |

The HR record read is the joiner's own source record (`identity.sources[].rawData` of the source that minted it), as leaver detection reads end dates. Start and end dates are calendar days in the leaver policy's `timezone`: a date-only HR value (`2026-12-01`, stored as UTC midnight) keeps its day, a timestamp is read in that zone (`leaver-signals.ts`, `calendarDay`).

**Start dates.** CSV HR maps the `Start Date` column to `startDate` (`csv-hr.interface.ts`), JSON API HR the keys `start_date`, `startDate`, `hire_date` and `hireDate` (`json-api-hr.interface.ts`; a custom `fieldMap` may map any key to `startDate`). Both parse it the same way (`hr/hr-lifecycle-fields.ts`), and it is kept in the row's `rawData` and in the profile. A value that is not a date no longer fails the row (which made the whole sync partial, so no joiner started in it): the row is ingested without `startDate` and the text HR sent is kept in `customAttributes.startDateUnreadable`. Its joiner waits (above), and when it starts waiting for that reason `identity.joiner_onboarding_waiting` puts "Onboarding waits: start date unreadable" on the identity timeline once (`joiner_events.waitReason` remembers it). Onboarding it at once would give access before the real start.

**Gate.** Due joiners start only while the tenant's pipeline is `DEPLOYED` (`PipelineService.getPipelineStatus`, the status the onboarding workflow's pipeline guard reads). In `DRAFT` or `SIMULATED` (before Deploy), `PAUSED` or `STOPPED`, nothing starts and nothing is lost: the joiners stay `waiting` and the first full sync after Deploy (or Resume) starts them. Deploy itself starts no workflow. The summary carries the `pipelineStatus` the run read.

**Execution.** Each due joiner's onboarding starts through `IDENTITY_PROVISION_REQUESTED` (`JoinerExecutionService`) with `reason: joiner:hr-sync:<source>`, which `OnboardingService` keeps in the workflow memo, and no email (the onboarding handler reads it from the identity by the event's aggregate); the workflow input and the workflow are unchanged, so everything onboarding does applies: already `SYNCED` targets are skipped, Entra ID without a configuration is left out, the write-back runs at depth 1, a pipeline that is not `DEPLOYED` skips provisioning. The joiner becomes `started` with the workflow id. An onboarding run already in progress for the identity (`WorkflowExecutionAlreadyStartedError`) closes it `superseded`; any other failed start (Temporal down) leaves it `waiting` with `startError`, and the source's next full sync tries again.

A joiner whose onboarding started is done for this module: a run that fails in a target system is retried from the Users page ([Provision]), as before.

**Other starts wait for an open joiner.** An identity edit of a trigger attribute (`OnboardingEventHandler.handleIdentityUpdated`) and a new HR source on the identity (`SourcesChangedHandler`) start onboarding for an identity that is not provisioned yet, but not for an open joiner (`waiting` or `pending-approval`, `open-joiner.ts`, read only from the onboarding module): its onboarding starts through this module, when its start date, the HR leaver check and the mass-joiner limit allow. Before, such an edit onboarded a joiner whose start date was ahead, or one waiting in a batch for an admin. [Provision] (`POST /onboarding/start`) is an operator's explicit decision and still starts at once. Whatever starts it, the onboarding workflow provisions only while the pipeline is `DEPLOYED`, before the person's admin accounts too (patch `onboarding:pipeline-guard-deployed`).

## Mass-joiner safety

`massJoinerAllowance = max(massJoinerMinCount, min(massJoinerMaxCount, floor(activeIdentities * massJoinerMaxPercent / 100)))`, the leaver and mover shape; active identities are the tenant's non-deleted identities whose status is not `TERMINATED` or `DELETED` (the joiners of the run included). A full run with more due joiners than the allowance stores one `joiner_batches` document (`pending`), moves every due joiner to `pending-approval` and starts nothing. With the defaults a sync onboards up to 2 people on its own below 60 active identities, 5 % of them from 60 and 10 from 200 on, so the first import of a whole company waits for a person.

- `POST /joiners/batches/:id/approve` is refused with 409 while the pipeline is not `DEPLOYED` (the batch stays pending). Otherwise it moves the batch to `approved` (only from `pending`, else 409), makes every member a `waiting` joiner with the approver as `decidedBy`, emits `joiner.batch_approved` and answers. The onboardings start after the answer (`JoinerBatchService.startAfterAnswer`, in the tenant context): each member still waiting is read again; one that left, was deleted or is onboarded otherwise is closed `superseded`, one that is suspended or inactive keeps waiting, the rest start with the approver as actor; then the batch's `startedCount`. Each start waits at most `HR_START_TIMEOUT_MS` (default 10 s); a start that fails or times out leaves the member `waiting` with the error. Because the members are waiting joiners, the source's next full sync starts any the approval run did not (a failure, or a process that stopped midway). A run and a sync that start the same joiner at once start one onboarding (deterministic workflow id), and a started joiner is never closed or sent back to waiting. Before, the approval waited for every start, 30 to 45 s per member with Temporal down.
- `POST /joiners/batches/:id/reject` closes the members `rejected`. The joiner path never onboards them; an operator still can, one by one.
- While a batch waits, its members are `pending-approval`, so further syncs neither start them nor create another batch.

## Policy (per tenant)

Stored in `joiner_policies` (one document per tenant), `GET/PUT /joiners/policy`. A tenant without one gets the defaults:

| Field                  | Default                     | Env                       |
| ---------------------- | --------------------------- | ------------------------- |
| `massJoinerMaxCount`   | `10`                        | `JOINER_MASS_MAX_COUNT`   |
| `massJoinerMaxPercent` | `5`                         | `JOINER_MASS_MAX_PERCENT` |
| `massJoinerMinCount`   | `2` (never above the count) | `JOINER_MASS_MIN_COUNT`   |

`PUT` refuses a floor above the count (400). The time zone and the "left" status words come from the tenant's leaver policy (`modules/leavers`).

## Tenancy, actors, audit, timeline

- The tenant is the sync's context (request tenant for a manual ingest, the scheduled-sync activity's tenant), taken from the event metadata; every query names it on top of the tenant plugin. API routes take tenant and actor from the authenticated user; bodies are strict Zod objects.
- Domain events (audited by the wildcard `AuditEventHandler`): `connector.hr_sync_joiners_requested`, `identity.provision_requested` (with the reason), `identity.joiner_onboarding_started` (`{ identityId, joinerEventId, sourceName, workflowId, batchId?, rehire? }`, actor `system:hr-sync` or the approving admin), `identity.joiner_onboarding_waiting` (`{ identityId, joinerEventId, sourceName, reason: 'start-date-unreadable' }`, actor `system:hr-sync`), `joiner.batch_paused`, `joiner.batch_approved` / `joiner.batch_rejected` (actor, comment; an approval since 2026-11-24 carries no `started` count, each start being its own `identity.joiner_onboarding_started`), `joiner.policy_updated` (changed fields). The onboarding run itself is audited as before (`PROVISIONING_EXECUTED`). Joiner and batch payloads carry ids and counts only.
- Identity timeline (`JoinerTimelineHandler`): "Onboarding started by HR sync" (`WORKFLOW_STARTED`), "New in the <source> sync" ("Rehired in" for a rehire), noting an approved batch, with the actor. A joiner whose start date is unreadable gets "Onboarding waits: start date unreadable" (warning) once; any other waiting or paused joiner has no joiner entry. Before it, "Created via <source>": `HrIngestionService` emits `identity.created` (ids and the source only) for each identity a row mints, waiting or paused joiners included. The onboarding run adds "Policy evaluated" (the evaluation it provisions from, `policy.evaluated` with `forProvisioning`) and one entry per target: "Provisioned to <target>" (a target that keeps no account says what it did) or "Provisioning failed to <target>" with the reason (`UserTimelineHandler`, all keyed by the identity id). A target the run left out because nothing is configured for it (Entra ID without a config) gets "Not provisioned to <target>: not configured" (warning, written by onboarding's `getIdentityByEmail` lookup).

## API

All routes require `policy-admin` (or `super-admin`).

| Method | Path                                                         |                                                                                                                              |
| ------ | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/v1/joiners/batches?status=pending\|approved\|rejected` | Newest 50 batches with their identities (name, email, department, job title, status, workflow id, close reason, start error) |
| POST   | `/api/v1/joiners/batches/:id/approve`                        | Body `{ comment? }`. Answers with the members waiting; their onboardings start right after. 404 for another tenant's batch, 409 when already decided or the pipeline is not deployed |
| POST   | `/api/v1/joiners/batches/:id/reject`                         | Body `{ comment? }`                                                                                                          |
| GET    | `/api/v1/joiners/policy`                                     | The policy, `configured: false` while on the defaults                                                                        |
| PUT    | `/api/v1/joiners/policy`                                     | The whole policy                                                                                                             |

`POST /connectors/:name/ingest` answers `joiners` (`JoinerSyncSummary`: `fullSync`, `detected`, `started`, `pending`, `waiting`, `startFailed`, `closed`, `pipelineStatus?`, `pausedBatchId?`) next to `leavers` and `movers`.

UI: Governance > Joiners, movers and leavers (`frontend/src/features/leavers/`), tab HR joiners: pending batches with each identity and the departments, approve / reject behind a confirmation, decided batches, and the mass-joiner limit.

## Limits

- Detection runs when a source syncs. A start date that passes is picked up by the next full sync of the source, not on the day itself.
- Waiting joiners are not listed in the UI; the sync summary counts them (`waiting`) and the scheduled-sync log names them.
- Identities minted before this module existed, created by hand or by SCIM, and rehires revived before 2.8 are not joiners.

## Files

| File                                                              | Role                                                                                                 |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `joiner-candidates.ts`                                            | Pure: due, waiting or closed for one identity                                                        |
| `joiner-detection.service.ts`                                     | One sync: record minted identities, gate, start or pause                                             |
| `joiner-execution.service.ts`                                     | Check one joiner against the hub; start it through `IDENTITY_PROVISION_REQUESTED`                    |
| `joiner-batch.service.ts`                                         | List, approve (starts after the answer), reject joiner batches                                       |
| `joiner-policy.service.ts`, `joiner-policy.defaults.ts`           | Per-tenant mass-joiner policy, env defaults, allowance                                               |
| `joiner-sync.handler.ts`                                          | `HR_SYNC_JOINERS_REQUESTED` listener                                                                 |
| `joiners.controller.ts`, `dto/joiner.dto.ts`                      | HTTP API and Zod schemas                                                                             |
| `schemas/`                                                        | `joiner_policies`, `joiner_events`, `joiner_batches`, `joiner_sources` (recording cursor per source) |
| `../../infrastructure/events/handlers/joiner-timeline.handler.ts` | Identity timeline                                                                                    |

Tests: `joiner-candidates.spec.ts` (rules, allowance, env defaults, unreadable start dates, a rehire's earlier targets), `joiner-detection.integration.spec.ts` (in-memory MongoDB: minting, gate, start dates, partial syncs, left in HR, pause, approve, reject, failed starts, re-ingest, policy, tenant isolation, rehires, unreadable start dates), `joiner-event-index.integration.spec.ts` (one joiner per hire, migration `20261123000000-joiner-events-one-per-hire`), `joiners.controller.spec.ts` (HTTP, roles, validation, tenant and actor), `../../infrastructure/events/handlers/joiner-timeline.handler.spec.ts`, `backend/test/workflows/jml-end-to-end.workflow.e2e-spec.ts` (Temporal time-skipping, `TEMPORAL_E2E=1`: first import before Deploy, Deploy, a batch of three approved, re-ingest, a new hire paused then started by the sync itself, a deleted leaver rehired and onboarded again).
