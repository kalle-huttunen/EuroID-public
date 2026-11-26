# Mover (`modules/mover`)

> **Related:** [Temporal workflows, Mover Workflow Flow](../../../../../docs/architecture/infrastructure/TEMPORAL_WORKFLOWS.md) · [HR leavers](../../leavers/docs/ARCHITECTURE.md) · [HR joiners](../../joiners/docs/ARCHITECTURE.md) · [Multi-HR ingestion](../../identity/docs/MULTI_HR_INGESTION.md) · [Event bus](../../../../../docs/architecture/core/EVENT_BUS_ARCHITECTURE.md) · [User flows, Flow 12](../../../../../docs/USER_FLOWS.md)

Changes the access of an identity that is already provisioned (has an account in a target system, the rule below) when its attributes change. Every start goes through `MoverService.triggerMover`, which starts `moverWorkflow` (workflow id `t-{tenant}-mover-{identityId}`, one run per identity at a time). An identity edit (`PATCH /identity/:id`, a control, SCIM) goes through `MoverService.startOrQueueMover`: while a run for the identity is open, the edit is queued on it (signal `reevaluate`, `workflows/mover-reevaluation.ts`) and that run, once it has recorded its outcome (also a failed one), continues as new with the queued edits: one more evaluation, whose "before" is what the first run applied for its own fields and the baseline values the edits sent for the others (patch `mover:reevaluate-queued-edit`). Only a run that answers the query `acceptsQueuedEdits` (patch `mover:queued-edit-query`) gets the signal: an open run started before that patch would drop the edit, so `MoverService.startAfterOpenRun` waits in the API until it has ended and then starts the edit's own run. The PATCH answer's `workflow` says `queued: true`. The workflow evaluates the policies for the old and the new profile and applies the difference: group memberships in Entra ID, Active Directory, Okta and SCIM (in Entra ID also directory roles and licenses), each on the connector's own task queue; what it does per target system is in the Temporal doc above.

## What reaches workflow history

The input names the identity by id: `MoverService` passes no email, and of `previousAttributes` only the keys the access baseline keeps (`toAccessBaseline`: no names, contact data or identifiers). The activities read the rest: `evaluateMoverChange` (`activities/mover.activities.ts`) loads the identity, evaluates the policies and returns entitlement ids and the changed attributes' current values; `applyMoverAccess` (`activities/mover-access.activities.ts`, on the connector queues) gets `{ identityId, connector, operations }` and reads the identity, its account and the connector config. Its failures are masked before they reach history (`asDeprovisionFailure`: emails and LDAP DN names, message and stack trace). What stays in history: identity id, attribute names, the before and after values of the changed policy attributes (a manager change carries the manager's email; a move that changed the HR contracts carries their title, department and HR employee id), entitlement ids and policy names. Runs started before the patch `mover:identity-by-id` carry the email and the full profile until they age out of Temporal's retention.

## Per target system (`mover-target-access.service.ts`)

| System | Account | Applies |
|---|---|---|
| Entra ID | The written-back object id, else the account with the profile's UPN, email (as mail or UPN) or employee id; never created (no match fails the system, 422 not retried; `ENTRA_DEEP_DIVE.md`, Must exist) | `provisionUserToEntra` with the policy profile and the identity id (its `provisioning.completed` / `.failed` go under the id and add "Provisioned to entra-id" to the timeline): attributes updated, groups, directory roles and licenses added and removed; a change Graph refuses, or a group name no group has, fails the system after the other changes were made |
| Active Directory | Written-back DN (`sources[]`, role `target`), else the `mail` / `userPrincipalName` lookup | `addUserToGroup` / `removeGroupMember` on the group DN; DNs compared without case and spacing |
| Okta | Written-back Okta id, else login = email | `addGroupMember` (PUT) / `removeGroupMember`; a non-`OKTA_GROUP` removal fails (422) |
| SCIM | Written-back SCIM id, else `userName` (UPN, email) and `emails` lookup | PATCH `add members` / `remove members[value eq ...]`; a nested (`indirect`) removal fails (422); 409 on add is already a member |

AD, Okta and SCIM change groups only (`MOVER_OPERATION_TYPES`, `shared/utils/entitlement-delta.ts`); any other kind of entitlement for them, and every change for another system, is reported "Not updated by the mover" with the reason. A membership already as the policies want it is left alone. A system the identity has no account in is not attempted: the timeline shows "No account: <system>" with the reason, and the run goes on with the next system. A system counts as provisioned once provisioned, until a deprovision, also while a later run there is in ERROR, so a change that failed there is tried again by the next run (`hasProvisionedAccount`, `modules/identity/identity-provisioning.service.ts`): its provisioning entry is SYNCED, or has `provisionedAt` (recorded when the entry is SYNCED, or was SYNCED before the write; a deprovision sets it to null). An entry no write has touched since 2.0dq counts with `writebackComplete` (onboarding sets it only with SYNCED) or as ERROR with the account id the target wrote back; an entry that went to ERROR before 2.0dq with neither counts as never provisioned, like an onboarding that failed before the account was created. Where the identity is provisioned, no account found is a failure (422, not retried): the account may exist under another name. An HR source's id never counts as an account. The same rule (`provisionedSystems`, next to `hasProvisionedAccount`) decides whether a mover run starts at all: the re-evaluation route (409 without such a system), HR mover detection and an edit's `identity.updated` (`isProvisionedForMover`, which the onboarding handler also asks before it defers an edit to the mover). Until the final sweep of 2026-11-23 these three asked for a SYNCED entry, so an identity whose only system was in ERROR after a failed mover run got 409 on re-evaluate, HR detection skipped it, and its edit went to onboarding, which only adds access.

| Trigger            | Started by                                                                                  | `previousAttributes` (the "before" profile)                    | Actor                                    |
| ------------------ | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------- |
| `attribute-change` | `PATCH /identity/:id`, or a department or job title control set, removed or expired (`PATCH /identity/v2/:id/controls`, the hourly expiry run), changing a trigger attribute's value (`MoverEventHandler`) | The access baseline's values of the changed trigger attributes (without a baseline: the values before the PATCH, the old manager masked, below) | Who saved the change                     |
| `re-evaluate`      | `POST /identity/:id/access/re-evaluate` (`AccessReevaluationService`)                       | The access baseline's values of every attribute that changed   | The operator                             |
| `hr-sync`          | An HR sync (`HrMoverDetectionService`), or approving a paused batch (`HrMoverBatchService`) | The access baseline's values of the changed trigger attributes | `system:hr-sync`, or the approving admin |

Trigger attributes: `departmentName`, `jobTitle`, `location`, `managerEmail` (`CRITICAL_FIELDS`, `modules/identity/identity.constants.ts`). The access baseline (`identity.accessBaseline`, `shared/utils/access-baseline.ts`) is the profile access was last applied with: recorded at the first SYNCED target, advanced by each completed mover run for the attributes it evaluated. It is the "before" of every run, an edit's run included (`moverPreviousAttributes`, `mover.handler.ts`): a change not applied yet (a paused or rejected HR batch, a failed run) is applied by the next run of that attribute. Until 2.0dq an edit's run evaluated the values the edit replaced, so such a change was skipped while the baseline advanced past it. An identity without a baseline keeps the values before the PATCH, and its completed run records the first baseline. An edit's `identity.updated` and `identity.move_requested` reach the audit log, the analytics index and the websocket, so they carry the old `managerEmail` masked (`m•••@example.com`, plan 2.0dn): they still show that the manager changed. With a baseline the run does not need the masked value. Without one the masked value stays (`evaluateMoverChange` finds no baseline manager to put in its place), so no policy rule on the old manager matches the "before" side: access a rule on the old manager gave is not removed by that run.

The policy profile also carries one HR contract per HR source (its title and department, which the policies evaluate as well). An edit of the department or job title overrides the value of the HR contracts that held the replaced value (`metadata.manualOverrides`, `identity/manual-contract-overrides.ts`, plan 2.8): the contract takes the edited value until that HR source sends another one, so the edit's run removes the old department's access. Until 2.8 the contract kept the old department and the run only added the new department's access. Since 2026-11-24 `PATCH /identity/:id` refuses (409) an edit of a field an HR source masters, so such an edit is only possible where no HR source masters the field; before, the next HR sync reconciled the profile back to the HR value and HR mover detection moved the access back. An HR-mastered department or job title is overridden through an attribute control (`PATCH /identity/v2/:id/controls`, `identity/attribute-controls.ts`): the profile and the primary HR contract take it whatever HR sends meanwhile, so HR mover detection sees no change while it is set. Setting, removing and the expiry of the control (the hourly expiry run, actor `system:control-expiry`) emit `identity.updated` with the value replaced, which starts the mover through `MoverEventHandler` from the access baseline, as an HR change is moved from it.

## HR-driven mover

An HR sync writes the Golden Record through `saveOrUpdate` and emits no `identity.updated`, so it never started the PATCH path. After each HR ingest, HR mover detection compares the identities the sync delivered with their access baseline instead.

```mermaid
sequenceDiagram
    participant S as HR sync (HrIngestionService)
    participant L as LeaverSyncHandler
    participant H as HrMoverSyncHandler
    participant D as HrMoverDetectionService
    participant M as MoverService
    participant T as Temporal
    S->>L: HR_SYNC_COMPLETED (emitAndWait)
    L-->>S: LeaverSyncSummary (this run's leavers recorded)
    S->>H: HR_SYNC_MOVERS_REQUESTED (emitAndWait, same counts-only payload)
    H->>D: evaluateSync(tenant of the sync context)
    alt movers <= mass-mover allowance
        D->>M: triggerMover(trigger hr-sync, actor system:hr-sync)
        M->>T: start moverWorkflow (t-{tenant}-mover-{id})
    else above the allowance
        D->>D: mover_batches (pending) + mover_batch_items, event mover.batch_paused
        Note over D: admin approves -> answer, then each member re-read and started; rejects -> closed
    end
    H-->>S: MoverSyncSummary (IngestResult.movers)
```

Then HR ingestion emits `HR_SYNC_JOINERS_REQUESTED` (same payload) for HR joiner detection (`modules/joiners/docs/ARCHITECTURE.md`). Its identities have no provisioning yet, so no mover run concerns them, and mover detection never sees an onboarding the same run started.

### Who gets a mover run

After a **full** sync of a source (rows fetched, none skipped, none failed; the rule leaver detection uses), every identity that:

1. the sync delivered (`sources[]` of that source with `lastSync` at or after the run start), is not soft-deleted, and has an account in at least one target system (`provisionedSystems`, above: also a system in ERROR after a failed run);
2. is not `TERMINATED`, `SUSPENDED` or `DELETED`, and has an email;
3. has an access baseline (without one it is counted in `withoutBaseline`, not failed);
4. has at least one trigger attribute whose profile value differs from the baseline (a cleared value counts as a change to null);
5. is not being offboarded by an HR leaver: no open leaver event (`pending-approval`, `queued`) and no started one whose offboarding has not reported its result (`offboardingFinishedAt` unset; read from `leaver_events`; HR ingestion asks for mover detection only after leaver detection answered, so this run's leavers are there);
6. is not waiting in a pending mover batch, and its changes are not ones an admin rejected (same `changeKey`).

The run gets `changedFields` = those trigger attributes and `previousAttributes` = their baseline values; the policies are evaluated against the profile with and without them. The policy profile also carries the identity's HR contracts (one per HR source with its title and department, which the policies evaluate as well), and the HR data moved them too: `evaluateMoverChange` puts the baseline's contracts on the "before" side and the run advances them, so the new department's access is added and the old one removed. Changes outside the trigger attributes are not applied (the access preview shows them; an operator re-evaluates). A partial or failed sync starts nobody: a failed fetch emits nothing, a partial run returns `fullSync: false` with every count 0. A failed leaver detection skips mover detection for that run.

Comparing with the baseline, not with the previous sync, means a run that failed, was skipped (pipeline paused) or never started (`startFailed`) is tried again by the next full sync of the source, and a change made while the identity was not yet provisioned is applied once it is.

### Mass-mover safety

`massMoverAllowance = max(massMoverMinCount, min(massMoverMaxCount, floor(activeIdentities * massMoverMaxPercent / 100)))`; active identities are the tenant's non-deleted identities whose status is not `TERMINATED` or `DELETED`. A sync with more movers than the allowance stores one `mover_batches` document (`pending`) and one `mover_batch_items` document per identity (`pending-approval`, with the changes as detected) and starts nothing. The floor keeps a small tenant from pausing on every move.

- `POST /movers/batches/:id/approve` moves the batch to `approved` (only from `pending`, else 409), records the approver on every member (`decidedBy`), emits `mover.batch_approved` and answers with the members pending. The runs start after the answer (`HrMoverBatchService.startApproved` for the batch, in the tenant context): each member is claimed (`claimedAt`, abandoned after `HR_START_CLAIM_TIMEOUT_MS`, default 10 minutes) and read again: one whose access now matches, that was deleted or deprovisioned, or that an HR leaver is offboarding is closed `superseded`; a mover run already in progress for it closes it `superseded` too (the next sync checks it again); the rest start with their changes as they are now (`started`, the approver as actor). Each start waits at most `HR_START_TIMEOUT_MS` (default 10 s); a start that fails or times out is `failed` with the reason, and the next sync detects it again. Then the batch's `startedCount`. A full sync of the source also starts the members an approved batch still has pending and unclaimed (an approval run whose process stopped). Before, the approval waited for every start, 30 to 45 s per member with Temporal down.
- `POST /movers/batches/:id/reject` closes the members `rejected`. The same changes (same fields, before and after values) are not raised again; a further HR change is.
- While a batch waits, its members are open items (one per identity, partial unique index), so further syncs neither raise them again nor create another batch.

## Policy (per tenant)

Stored in `mover_policies` (one document per tenant), `GET/PUT /movers/policy`. A tenant without one gets the defaults (the owner's decision for 2.0cl: the shape of the 2.1 leaver limit with a floor of 2):

| Field                 | Default                     | Env                      |
| --------------------- | --------------------------- | ------------------------ |
| `massMoverMaxCount`   | `10`                        | `MOVER_MASS_MAX_COUNT`   |
| `massMoverMaxPercent` | `5`                         | `MOVER_MASS_MAX_PERCENT` |
| `massMoverMinCount`   | `2` (never above the count) | `MOVER_MASS_MIN_COUNT`   |

With the defaults a sync may start 2 mover runs up to 59 active identities, 5 % of them from 60, and 10 from 200 on. `PUT` refuses a floor above the count (400).

## Tenancy, actors, audit, timeline

- The tenant is the sync's context (request tenant for a manual ingest, the scheduled-sync activity's tenant), taken from the event metadata; every query names it on top of the tenant plugin. API routes take tenant and actor from the authenticated user; bodies are strict Zod objects.
- Domain events (audited by the wildcard `AuditEventHandler`): `connector.hr_sync_movers_requested`, `mover.batch_paused`, `mover.batch_approved` / `mover.batch_rejected` (actor, comment; an approval since 2026-11-24 carries no `started` count: the batch's `startedCount` has it), `mover.policy_updated` (changed fields), and per run `mover.started` / `mover.completed` / `mover.failed`. Batch payloads carry counts and ids only.
- Identity timeline (`MoverTimelineHandler`): "Access change started by HR sync" with the changed fields and the actor, then the run's per-system entries and summary. Entra ID's provisioning call adds its own "Provisioned to entra-id" (or "Provisioning failed to entra-id") entry (`UserTimelineHandler`). A paused member has no timeline entry until its run starts; the Access tab preview shows its pending change.
- Batch items store the before and after values of the trigger attributes (department, title, location, manager email) so the approver can judge the batch; the API lists them with each identity's name and email (policy-admin only).

## API

All routes require `policy-admin` (or `super-admin`).

| Method | Path                                                        |                                                                                                   |
| ------ | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| GET    | `/api/v1/movers/batches?status=pending\|approved\|rejected` | Newest 50 batches with their identities (name, email, changes, status, workflow id, close reason) |
| POST   | `/api/v1/movers/batches/:id/approve`                        | Body `{ comment? }`. Answers with the members pending; their runs start right after. 404 for another tenant's batch, 409 when already decided |
| POST   | `/api/v1/movers/batches/:id/reject`                         | Body `{ comment? }`                                                                               |
| GET    | `/api/v1/movers/policy`                                     | The policy, `configured: false` while on the defaults                                             |
| PUT    | `/api/v1/movers/policy`                                     | The whole policy                                                                                  |
| POST   | `/api/v1/identity/:id/access/review-exclusions/:exclusionId/lift` | Lifts an access review exclusion and starts the identity's re-evaluation (an account: onboarding): `{ exclusion, run }` |

`POST /connectors/:name/ingest` answers `movers` (`MoverSyncSummary`: `fullSync`, `detected`, `started`, `alreadyRunning`, `startFailed`, `withoutBaseline`, `pausedBatchId?`) next to `leavers`.

UI: Governance > Joiners, movers and leavers (`frontend/src/features/leavers/`), tab HR movers: pending batches with each identity's change and approve / reject confirmation, decided batches, and the mass-mover limit.

## Limits

- The mover changes group memberships in Entra ID, AD, Okta and SCIM, and directory roles and licenses in Entra ID; anything else is reported "Not updated by the mover" with the reason. GitHub, ServiceNow and the no-account targets get no access change.
- Entra ID keeps its provisioning path, so its attributes are updated with the access change. Each group, directory role and license change is reported (`ENTRA_DEEP_DIVE.md`, Change Results); a change not made fails the system with the reasons ("Access update failed: entra-id"), while the changes that were made stay made (until 2.0dm a refused change was logged only and a license removal was not applied).
- A run started by `PATCH /identity/:id?syncToEntra=true` (input `syncToEntra`, patch `mover:sync-to-entra`) updates the Entra ID account also where it has no change for Entra ID, a run without any access change included: the timeline shows "Access updated: entra-id" with that reason, or "No account: entra-id" when the identity has no Entra ID account. Other runs update Entra ID attributes only together with an access change there.
- A system the identity is not provisioned to gets no access change: the run reports it ("No account") and completes, so the access baseline advances.
- Access an active access request also grants is not removed (`withoutRequestGrants`, `shared/utils/entitlement-delta.ts`; the requests read only through `access-requests/active-request-grants.ts`): a removal of an entitlement that one of the identity's `ACTIVE` requests, or `PROVISIONING` ones not older than `PROVISIONING_STALE_AFTER_MS` (`access-requests/held-requests.ts`), (as its target, or as requester of a request without one) gives, with the same type and native id in a system the removal is for, is left out of the run and of the access preview. The request's own end (expiry, revoke) removes it. Before, a department move removed a group the person had also been granted on request, while the request stayed `ACTIVE`.
- Access an access review revoked (an active review exclusion, `modules/policy/docs/ARCHITECTURE.md`, Access Review Exclusions) is left out of both evaluations, the access preview's too: a move never adds it back. The "before" side also leaves out what an exclusion lifted after the access baseline took away, so the run after a lift adds it; lifting one (`POST /identity/:id/access/review-exclusions/:exclusionId/lift`, policy-admin, `review-exclusion-lift.service.ts`) starts that re-evaluation at once (an account exclusion: onboarding, since the mover creates no account), and the answer says why when it cannot. The access preview is evaluated also when no attribute changed, for such an add.
- Identities provisioned before the access baseline existed have none and are skipped (`withoutBaseline`) until their next SYNCED provisioning records one.
- A run that keeps failing for an identity (the target rejects it) is started again by every full sync of its source, each with its timeline entries, until the cause is fixed or the HR data matches the baseline.

## Files

| File                                                                                 | Role                                                                       |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `mover.service.ts`                                                                   | `triggerMover`: the one place that starts `moverWorkflow`                  |
| `mover-target-access.service.ts`                                                     | The change per target system: account lookup, group add and remove         |
| `access-reevaluation.service.ts`, `access-reevaluation.controller.ts`                | Access preview and re-evaluation (`/identity/:id/access/*`)                |
| `hr-mover-changes.ts`                                                                | Pure: trigger attributes against the baseline, candidate rules, change key |
| `hr-mover-detection.service.ts`                                                      | One sync: find movers, start them or pause a batch                         |
| `hr-mover-execution.service.ts`                                                      | Start one HR mover run; who is being offboarded by a leaver                |
| `hr-mover-batch.service.ts`                                                          | List, approve (runs start after the answer, or at the next sync), reject mover batches |
| `hr-mover-policy.service.ts`, `hr-mover-policy.defaults.ts`                          | Per-tenant mass-mover policy, env defaults, allowance                      |
| `hr-mover-sync.handler.ts`                                                           | `HR_SYNC_MOVERS_REQUESTED` listener                                        |
| `hr-movers.controller.ts`, `dto/hr-mover.dto.ts`                                     | HTTP API and Zod schemas                                                   |
| `schemas/`                                                                           | `mover_policies`, `mover_batches`, `mover_batch_items`                     |
| `../../infrastructure/events/handlers/mover.handler.ts`, `mover-timeline.handler.ts` | PATCH trigger; identity timeline                                           |

Tests: `mover-target-access.service.spec.ts` (per target, mocked connectors), `../../activities/mover-access.activities.spec.ts`, `../../activities/mover.activities.spec.ts`, `../../activities/mover-provisioned.integration.spec.ts` (in-memory MongoDB: which systems count as provisioned through ERROR and deprovision), `../../infrastructure/events/handlers/mover.handler.spec.ts` (an edit's run moves from the baseline), `backend/test/workflows/mover-outcome.workflow.e2e-spec.ts` (Temporal time-skipping, `TEMPORAL_E2E=1`: per-queue changes, no PII in history, failure, the Entra ID sync of a `syncToEntra` run, replay of older histories), `hr-mover-changes.spec.ts`, `hr-mover-detection.integration.spec.ts` (in-memory MongoDB), `hr-movers.controller.spec.ts` (HTTP, roles), `backend/test/workflows/hr-mover.workflow.e2e-spec.ts` (Temporal time-skipping, `TEMPORAL_E2E=1`: CSV sync to a started mover workflow, a leaver not moved, a paused reorganisation approved).
