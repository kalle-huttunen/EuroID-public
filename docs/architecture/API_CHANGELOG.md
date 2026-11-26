---
Last updated: 2026-11-25
---

# 📡 API Changelog

> **For Frontend Agents:** Swagger (`swagger-spec.json`) tells you *what* the API is. This changelog tells you *what to fix* and what's new.

## v2.0 Roadmap

> The following items were planned for v2.0. Items marked with a checkmark are now implemented.

* **Breaking:** `Identity` schema split into Write/Read models. (I-04, I-05: not implemented; there is one `identities` collection and no identity read model or projection; only the audit-event and analytics read models in ElasticSearch exist)
* ~~**New:** `/api/v2/agents` endpoints for Remote Agent registration.~~ (A-13, A-14 — implemented as `/api/v1/agents`)
* ~~**New:** `/api/v2/analytics` backed by ElasticSearch.~~ (implemented as `/api/v1/analytics/v2/*`)
* ~~**Deprecated:** Direct `PolicyEngine` execution (replaced by OPA).~~ (A-01, A-02: the OPA client, Rego compiler and `OpaEvaluatorService` exist, but `PolicyEngineService` never calls them; policies are always evaluated in TypeScript)

---

## [Unreleased]

> Keep this section small. Cut a dated release (e.g., `[2026-04]`) at least monthly.

### Changed: final review fixes (2026-11-26)

- `tenant.identity_limit_exceeded`: an identity created inside a database transaction no longer raises the event (or sets the tenant's `identityLimitExceededAt`) at once; the hourly sweep raises it from the committed count. Before, a transaction that aborted after the check (a duplicate email) left an alert for an identity that never existed.
- `POST /api/v1/auth/register` and `GET /api/v1/auth/setup-status`: first-admin setup (with `SETUP_TOKEN` where required) stays open until an active super-admin exists. Before, any admin closed it, so a SAML user signing in before anyone registered (JIT creates a viewer) left the deployment with no way to create a super-admin. `setup-status` answers `hasAdminUsers: false` until an active super-admin exists. A first-admin registration with an address that is already an admin account answers `409`.
- `POST /api/v1/auth/login`: the failed sign-in lockout (`LOGIN_MAX_FAILURES_PER_ACCOUNT`, 429 "Too many failed sign-ins for this account") counts per address and client IP. Before, it counted per address alone, so anyone who knew an admin's email could lock that admin out from anywhere. The per-IP throttle is unchanged.
- Inbound SCIM (`/scim/v2/Users`, `/scim/v2/Groups`): a token of a suspended or deprovisioned tenant now gets a SCIM error `403` ("This tenant is suspended. Contact your platform administrator."). Before, the IdP of a suspended tenant kept creating, changing and deactivating its identities and groups.
- Inbound SCIM: migration `20261126000009-scim-token-default-scopes` gives every stored SCIM token that holds none of `Users:read`, `Users:write`, `Groups:read`, `Groups:write` those four, so a token stored before scopes were enforced (no scopes, or `scim`) keeps working instead of answering 403 on every route after the deploy.
- Access requests: fulfilment and removal look an Entra ID account up by the person's UPN, email or employee id only when the person's Entra ID provisioning entry says an account was provisioned. A person with no such entry (created through SCIM, say) gets the existing no-account outcome (`REJECTED` with "No Entra ID account is recorded for this person ..."). Before, a foreign account carrying their email (a guest, a shared mailbox) could be matched, changed and recorded as theirs.
- Impact analysis (`POST /api/v1/blueprints/impact-analysis` and the Deploy gate): on a canvas saved before nodes had a `role`, every node with a type except the hub counts as a target system. Before, such a canvas had no target, the analysis fell back to Entra ID and reported deltas for a system the canvas may not have.
- Distributed transactions (`POST /api/v1/reconciliation/distributed-transaction`): a retried CREATE keeps the Entra ID account an earlier attempt made also when Graph's `createdDateTime` is up to 5 seconds before `preparedAt` (Graph gives whole seconds, and its clock is not the worker's). Before, such an account counted as pre-existing: the system ended `FAILED` with no `createdAccountId`, and the rollback left the account in Entra ID.
- Access anomalies (`GET /api/v1/anomalies`): an anomaly whose evidence names no events or entitlements is raised again by the next analysis after it was dismissed or resolved. Before, one decision kept such an anomaly type from ever being raised again for the identity.
- `POST /api/v1/compliance-reports/generate` (ISO27001): the GDPR erasure figure counts erasure requests. The linked admin identities erased with a person each write their own `GDPR_ERASURE_EXECUTED` entry (with `metadata.parentIdentityId`) and are no longer counted, so one person with two admin identities counts once, not three times.
- `DELETE /api/v1/identity/:id/gdpr-erase`: on each NHI agent the erased person owns, `createdBy` and `revokedBy` become `(erased)` when they are the owner's email (any case), as `owner.email` does; another admin's email there stays. `GET /api/v1/identity/:id/dsar-export` gives `createdBy` and `revokedBy` in `records.agent_identities` in that case, and leaves them out otherwise as before.
- `POST /api/v1/bulk-provisioning/start`: a `correlationId` (or `nationalIdHash`) in an operation's `user` is now always removed before the workflow starts. Before, it was kept when the tenant had no Hashed National ID rule at the batch start, and if the rule was added while the batch ran, the client's value was matched on as the national ID hash. The hash EuroID computes travels in its own field and is the only one matched on.
- `PATCH /api/v1/identity/:id`: an edit that meets an open mover run started before the worker upgrade (or run by a worker of the old build during a rolling deploy) is no longer signalled to that run, which would have dropped it; the API starts the edit's own run once that run has ended. The answer is still `workflow.queued: true` with the open run's `workflowId`, and the audit entry `MOVER_CHANGE_QUEUED` says the change runs after the run in progress ends.
- Bulk provisioning (`POST /api/v1/bulk-provisioning/start`): a successful Entra ID CREATE or UPDATE marks the identity's Entra ID provisioning entry `SYNCED` only when the account's object id is now recorded on that identity (or the operation returned none). When another live identity already holds the id, a deprovision removed the identity's account, another id is recorded, or the identity is not found, the entry is left as it is and the worker logs why. Before, the entry became `SYNCED` in those cases too, so offboarding and the mover treated the identity as owning an account that was not its own.
- `POST /api/v1/access-reviews/campaigns/:id/activate`: an activation running longer than `ACCESS_REVIEW_ACTIVATION_CLAIM_MS` keeps its claim (renewed before each batch of items), and an activation that lost its claim to another (its process stalled past the claim) stops with `409` and changes neither the campaign nor the items of the activation that took over. Before, the stalled one went on making items and, when it failed, deleted the other's items and put the running campaign back to `DRAFT`. The campaign document carries the claiming activation's `activationId`.
- `GET /api/v1/access-requests?removalFailing=true` also lists a request whose removal at its end date fails on an answer retrying can fix (Graph 5xx, 429, no answer): the revoke records `statusReason` "Removing the access from Entra ID failed and is being tried again: ..." with the error, and the next removal that succeeds clears it, as for a refusal. Before, only a refusal set `statusReason`, so a removal failing for days on 5xx never appeared in the list.

### Changed: final leftovers (frontend, platform, bulk Entra ID state, compliance)

Deploy the API and the worker together. The migrations, workflow patches and env vars are in `docs/DEPLOYMENT.md` ("Upgrading to the 2026-11-25 release").

- `DELETE /api/v1/identity/:id/gdpr-erase`: each NHI agent of the erased owner that was not marked ownerless before (at the owner's offboarding) and is not revoked now gets the warning audit entry `AGENT_IDENTITY_OWNERLESS` and the event `nhi.owner_lost` with `reason: "erased"` (`agentId`, `ownerIdentityId`; no email or name), as offboarding writes them. Before, the erasure marked the agents without either, so a webhook subscriber to `nhi.owner_lost` missed them. A dry run writes neither.
- `GET /api/v1/identity/:id/dsar-export`: new fields `records` and `linkedAdminIdentities`. `records` holds the subject's documents in every other collection a GDPR erasure reaches (`credential_inventory`, `identity_risk_scores`, `risk_scores`, `anomalies`, `joiner_events`, `leaver_events`, `offboarding_records`, `mover_batch_items`, `upcoming_offboardings`, `drift_records`, `access_requests`, `agent_identities`, `peer_groups`, `policy_suggestions`), keyed by collection, each with its fields minus tenant and version fields and other people's personal data (who decided or approved, a manager who requested, other group members) and never credential material. `linkedAdminIdentities` lists the person's linked admin identities, each with its document and the same sections as the person. The `DATA_EXPORTED` audit entry's metadata gains `recordCounts` and `linkedAdminIdentityCount`.
- `GET /api/v1/access-requests` takes `removalFailing=true|false` (another value: 400). With `true` (policy-admin; any other role: 403) it lists every `ACTIVE` request of the tenant whose end date has passed and whose removal failed (`statusReason` set), ordered by `expiresAt`, paged by `page` and `limit` as before, with `status` ignored; without it, or with `false`, it lists the caller's own requests as before. The console's Access requests page offers it to a policy-admin as the tab Removal failing, with a link to each request.
- `provisioning.failed` from access request fulfilment and from the removal at the end date carries `accessRequestId`, the request whose change Entra ID refused.
- Bulk provisioning (`POST /api/v1/bulk-provisioning/start`): a successful Entra ID CREATE or UPDATE now marks the operation's identity's Entra ID provisioning entry `SYNCED` (the identity the Golden Record write saved, else by source key, else email; nothing is created), as onboarding does, so the identity's Access tab and `provisioning[]` show Entra ID and the mover and offboarding reach the account. A rollback puts the entry back as it was before the operation. Migration `20261126000007-entra-provisioning-backfill` adds a SYNCED `entra-id` entry to live identities that have an Entra ID account id recorded and no Entra ID entry.
- New event `tenant.identity_limit_exceeded` (`limit`, `count`; aggregate id the tenant id), which webhooks can subscribe to and the audit log records: the tenant has more live identities than `settings.maxIdentities` allows, because creates running at the same moment passed the count. Raised once per overshoot, after a create and by the hourly expiry sweep; once the count is back within the limit, the next overshoot raises it again.
- New event `admin_account.activation_pending` (`parentIdentityId`, `targetSystem` `okta`, `targetStatus`, `pendingSince`, `alertAfterDays`; no login or email), which webhooks can subscribe to and the audit log records: an Okta linked admin account has waited `PAM_ACTIVATION_PENDING_ALERT_DAYS` (default 7) for its owner to finish the activation Okta emailed. Raised once per wait by the hourly PAM sweep, which no longer starts a failing disable-only run each hour for such an account (`PROVISIONED` or `STAGED` in Okta, last disable failed in Okta only). New optional env var `PAM_ACTIVATION_PENDING_ALERT_DAYS` (worker).

### Changed: audit and compliance leftovers

Deploy the API and the worker together, after the migration `20261126000006-nhi-ownerless-backfill`. The workflow patch (`archival:empty-batch-skipped`) and the deploy notes are in `docs/DEPLOYMENT.md` ("Upgrading to the 2026-11-25 release").

- Orphan delete of an Entra ID account (`POST /api/v1/reconciliation/orphans/:driftId/signal` with `{ action: 'DELETE' }`, and the auto-delete after the extended grace): the account is deleted by the object id detection recorded (the drift's `orphanDetails.externalId`), no longer by its UPN or mail, so an orphan renamed after detection is deleted too and a UPN another account took over is never deleted in its place. Cleanups started before the deploy still delete by the UPN or mail.
- Cold-storage archival (`archival-nightly`): a batch whose documents were all deleted before the export read them (the TTL index, once archival lags) no longer fails the run with "Cannot export empty batch". It is skipped, nothing is recorded in `archival_records` for it, and the run goes on with the next batch (patch `archival:empty-batch-skipped`).
- `POST /api/v1/compliance-reports/generate` (ISO27001): "Connector Config Changes": counts connector configuration changes only. Before, it counted every `CONFIG_CHANGED` audit entry, so every Design studio canvas save counted, also one that only moved a node. It now counts the connector store's configuration updates (`PATCH /api/v1/connectors/:name`), a node's connector settings saved with settings (`PATCH /api/v1/blueprints/:id`), and canvas saves that changed a connector's settings. The canvas save's `CONFIG_CHANGED` entry (resource type `blueprint`) has a new `payload.metadata.connectorConfigChanges`: the connectors whose settings the save changed (a canvas node's `data.config`, or a `connectorConfigs` entry of a registered connector; the Brain's `euroid-core` correlation settings are none), empty when it changed none. Canvas saves audited before the deploy carry no such field and are not counted, so a report over a period before the deploy can show a lower figure than before.
- `GET /api/v1/identity/:id/dsar-export`: new field `consents`, the subject's consent records, one per purpose: `purpose`, `status` (`granted`, `revoked` or `expired`, a granted one past its expiry marked expired as the consent list does), `grantedAt`, `revokedAt` (when withdrawn), `expiresAt`, `method`. The `DATA_EXPORTED` audit entry's metadata gains `consentCount`. The GDPR requests page lists "Consent records" among the export's counts.
- Non-human identities page: a revoked or killed agent whose cascade stopped part way (delegated agents still active) offers a super-admin [Finish cascade], which calls `POST /api/v1/nhi/:agentId/revoke` (`/kill` for a killed agent) again; the API already completed the cascade on such a call. Opening a revoked agent's detail as super-admin now sends that route's `?dryRun=true` once. No API change.
- `DELETE /api/v1/identity/:id/gdpr-erase` (and its `?dryRun=true`): the person's linked admin identities (identities whose `parentIdentityId` is the person) are erased in the same run with the same scope, before the person; before, they were left with the person's name and admin UPN. New attestation field `linkedAdminIdentities`: `[{ identityId, adminTier, collectionsAffected, documentCounts, notReached }]`, empty when the person has none; the top-level `notReached` includes the stores not reached for them. Each admin identity gets its own `GDPR_ERASURE_EXECUTED` audit entry (metadata `parentIdentityId`), written before the person's, whose metadata gains `linkedAdminIdentityIds`.
- Non-human identities whose owner left: when the owner's offboarding has run, the identity is deleted from the hub, or the owner is erased, the owner's agents that are not revoked get `ownerlessSince` and `ownerlessReason` (`offboarded` or `erased`) in every agent response. **Behaviour change:** `POST /api/v1/nhi/:agentId/credentials` for such an agent answers 409 "Agent x has no owner (the owner was offboarded): give it a new owner or revoke it"; a credential issued before keeps verifying (`POST /api/v1/nhi/credentials/verify`) until it expires. New route `POST /api/v1/nhi/:agentId/owner` (super-admin) `{ ownerIdentityId }`: a new owner, who must be an active identity of the tenant (400 otherwise); it clears both fields and answers the agent. A revoked agent answers 409. `GET /api/v1/nhi` takes `ownerless=true|false` (another value: 400). New events `nhi.owner_lost` (`agentId`, `ownerIdentityId`, `reason`) and `nhi.owner_changed` (`agentId`, `previousOwnerIdentityId`, `ownerIdentityId`), which webhooks can subscribe to; audit actions `AGENT_IDENTITY_OWNERLESS` (warning) and `AGENT_IDENTITY_OWNER_CHANGED`. Migration `20261126000006-nhi-ownerless-backfill` marks the agents of owners who left before the deploy (`docs/DEPLOYMENT.md`, "Before the deploy", item 19).

### Changed: distributed transaction, impact preview and SCIM orphan leftovers

Deploy the API and the worker together; no migration, no new env var. The workflow patch (`orphan-cleanup:delete-by-external-id`) and the deploy notes are in `docs/DEPLOYMENT.md` ("Upgrading to the 2026-11-25 release", "Deploy").

- `POST /api/v1/reconciliation/distributed-transaction` with `operation: "CREATE"` never takes over an existing Entra ID account. Prepare now resolves the UPN the account will get (the UPN pattern included) and refuses the transaction (`prepareSuccess: false`; the Transaction Viewer shows `FAILED` with `error: "Prepare validation failed on entra-id: An Entra ID account already has the UPN, email or employee id of this user: a CREATE never takes over an existing account"`) when any account has that UPN, the user's own UPN, the email (as mail or UPN) or the employee id; a UPN that cannot be resolved (no default domain, every candidate taken) refuses it too, with the reason. The commit creates the account under that UPN only: an account in the way since fails the system (`FAILED`, nothing created or changed). Before, prepare checked only that the email was free as a UPN, the commit updated an account with the user's UPN or email and reported it as `createdAccountId`, and a rollback deleted that pre-existing account. A CREATE's rollback now deletes only `createdAccountId`; a CREATE committed without one (before this release) is `ROLLBACK_FAILED` with nothing deleted (it was deleted by the email). A CREATE prepared before the deploy and committed after it is not committed (`FAILED`, "... prepared without the UPN of its account ...: Start the transaction again"). The resolved UPN is kept in the encrypted snapshot store (`systems["entra-id"].previousState` is `{ snapshotRef }`), never in the result.
- A distributed-transaction commit that Temporal retries after its outcome was lost no longer makes a second Entra ID account for a CREATE: it looks the account up by the UPN prepare resolved (it looked by the user's UPN or email, which missed an account whose UPN the UPN pattern generated) and keeps it as `createdAccountId` only when Entra ID created it after the prepare (`createdDateTime` after `preparedAt`). An account with that UPN created earlier, or with no creation time, fails the system (`FAILED`, `error: "... a CREATE never takes over an existing account"`), and nothing is deleted on rollback.
- `POST /api/v1/blueprints/impact-analysis`: `entraMetadata[].upn` is `null` (with `upnStatus: "unknown"` and a `notKnown` sentence starting "UPN: not known") when the canvas has no Entra ID config with a default domain, or the person has no first and last name; it was `firstname.lastname@euroid.com`, an invented domain, marked `valid`. `upnStatus` is `valid`, `conflict` or `unknown` (`invalid` was never sent). New `entraMetadata[].roles`: the directory roles the policy assigns, by catalog name; they were listed in `groups`. In `deltas`, an entitlement change of a directory role is typed `role` (it was `group`), so its warning reads `add role: <id>`; a delta's `upn` is the person's UPN, else their email.
- Orphan delete of a SCIM account (`POST /api/v1/reconciliation/orphans/:driftId/signal` with `{ action: 'DELETE' }`, and the auto-delete after the extended grace): the user is deleted by the SCIM id detection recorded (the drift's `orphanDetails.externalId`), no longer only found by its userName or email, so a SCIM orphan without such a match is deleted too. Cleanups started before the deploy still find it by userName or email.

### Changed: reconciliation and operations leftovers

Deploy the API and the worker together; no migration, no new env var. The workflow patches (`risk-score-calculation:per-tenant`, `reconciliation:orphan-detection-heartbeat`, `orphan-cleanup:ad-never-deleted`) and the steps after the deploy are in `docs/DEPLOYMENT.md`.

- `GET /api/v1/analytics/license-forecast` and `.../:system/:license`: `currentCount` is now the units in use that Entra ID discovery last read (`subscribedSkus` `consumedUnits`), no longer EuroID's net adds minus removes in the 6-month window (which started at 0). New fields `capacity` (units enabled, `prepaidUnits.enabled`, else the `LICENSE_CAPS` entry) and `countsObservedAt`. `currentCount`, `capacity` and `projectedCount` are `null` until discovery has read the license (run the Entra ID discovery once after the deploy); `daysToCapacity` counts from the real consumption and is 0 for a license with no unit left.
- `GET /api/v1/blueprints/latest` answers `revision`, the canvas revision (0 when nothing is saved). `POST /api/v1/blueprints/save` takes it back as `revision` (whole number from 0) and answers the new one: a save whose `revision` is no longer the stored one (someone saved the canvas after it was loaded) answers **409** "The canvas was saved by someone else after you loaded it (...). Nothing was saved. Reload the canvas ..." and stores nothing. A body without `revision` is still saved, unchecked (audited with `revisionChecked: false`); clients must send it, as the next release will require it. A `revision` that is no whole number from 0 is 400.
- `POST /api/v1/blueprints/impact-analysis`: `entraMetadata[]` no longer carries invented data. **Breaking:** `securityGroups`, `o365Groups` and `conditionalAccessPolicies` are removed; new `groups` (the groups the policy assigns the person in Entra ID, by their entitlement catalog name, else as the policy names them) and `notKnown` (sentences saying what the answer cannot tell: conditional access policies, which EuroID does not read; a group not in the catalog; a license whose units discovery has not read). `licenses` are the licenses the policy assigns (`assigned: true`), `available` the units left from the last Entra ID discovery, `null` until it has read them. Before, every person got "O365_E3, 250 available", "All-Staff" and two CA policies.
- `GET /api/v1/reconciliation/result/:workflowId` (a daily run's report): new optional `orphanDetectionFailures: [{ system, error }]`, the target systems whose orphan detection failed (or whose orphan's cleanup could not be started) and why; absent when none did. Before, such a failure only reached the worker log.
- Orphan delete per system: `POST /api/v1/reconciliation/orphans/:driftId/signal` with `{ action: 'DELETE' }` now deletes a SCIM orphan (`DELETE /Users/{id}` of the user with its userName or email); for an Active Directory orphan it answers **422** "EuroID never deletes an Active Directory account: ..." and signals nothing (ADOPT is unchanged). `GET /api/v1/reconciliation/orphans/:driftId/simulate-delete` gains `deletable` (false for AD, `impact` then gives the reason). An orphan drift's `orphanDetails` gains `keptReason`, set when a cleanup kept an AD account instead of auto-deleting it.

### New: close an access request whose removal keeps failing as removed by hand

Deploy the API and the worker together (workflow patch `access-request-approval:revoke-closable-continue-as-new`); no migration, no new env var.

- New route `POST /api/v1/access-requests/:id/removed-manually` (policy-admin), body `{ note }` (1 to 500 characters, required; no other field). For an `ACTIVE` request whose end date has passed, after an admin removed the access in the target by hand: the request becomes `EXPIRED` with `removedManually` (`by`: the admin from the token, `at`, `note`, `failureReason`: the `statusReason` it had) and `statusReason` "An admin removed the access by hand and closed the request: <note>", and its approval workflow stops retrying the removal. Answers 200 with the request; 400 for a missing note or another field; 403 below policy-admin; 404 for a request not in the tenant; 409 for a request not `ACTIVE`, before its end date, or changed meanwhile; 503 when the workflow cannot be reached (nothing changed). Before, a removal Entra ID refused for good was retried every 6 hours forever and nothing could close the request.
- `access_request.closed` gains `removedManually: true` for such a closure, with the admin as the event's actor and the note as `reason`.
- `GET /api/v1/access-requests/:id` opens any request of the tenant for a policy-admin (it answered 403 to anyone but the requester and the request's approvers).
- The approval workflow continues as new after 20 retries of a failing removal, so its history no longer grows without end.

### Fixed: access requests for people whose Entra ID account bulk provisioning made

Deploy the worker; no migration, no new env var, no workflow change.

- Since fulfilment and expiry change the entitlement only (below), a request for a person with no recorded Entra ID object id ended `REJECTED` ("No Entra ID account is recorded"), which hit everyone whose account bulk provisioning made: it recorded no object id. Fulfilment and expiry now look such an account up read-only by the person's UPN, email (as `mail` or UPN) and employee id, and use it only when exactly one account matches, no other identity has it recorded, and the person's Entra ID provisioning entry does not say a deprovision removed it. The account is then recorded for the person (its target source only: no profile write, no provisioning entry added) and the entitlement changed on it. No match, or several, keeps the refusal; the `statusReason` now reads "No Entra ID account is recorded for this person, and no single account has their UPN, email or employee id. ...".
- A bulk CREATE or UPDATE now records the object id of the Entra ID account it provisioned for the operation's identity (the one its Golden Record write saved, else the one with its source key, else its email), so new bulk accounts need no lookup. Besides it, only the identity's Entra ID provisioning entry is written (marked SYNCED, see "Changed: final leftovers" above); a recorded id is never replaced, an account another identity has is not recorded, a rollback that undoes the Golden Record write removes it again, and a failure to record is logged and leaves the operation's result as it was.
- The same lookup in the mover and a `syncToEntra` edit (identities whose entry says they have an account but no object id is recorded) now refuses an email two accounts carry as `mail` or UPN with 422 "More than one Entra ID account has the email of this identity: link the right account to the identity.", as it did for an employee id; before it took whichever account Graph listed first.

### Fixed: My Reviews matches the reviewer without case

Migration `20261126000005-review-item-reviewer-lowercase`; no new env var.

- `GET /api/v1/access-reviews/my-reviews` matched each item's `reviewerId` exactly against the signed-in email, while `POST /api/v1/access-reviews/items/:itemId/decide` compared without case, so a reviewer whose address was stored in another case never saw those items. Review items now store `reviewerId` trimmed and lower-cased (an email or an admin id), so responses carry it lower-cased; My Reviews and the `reviewerId` filter of `GET /api/v1/access-reviews/campaigns/:id/items` match it without case. The migration lower-cases the ids stored before.

### Fixed: an access review finds a manager known only by employee id

Migration `20261126000004-identity-employee-id-index` (an index, no document changes); no new env var.

- Activating a campaign (`POST /api/v1/access-reviews/campaigns/:id/activate`) gave the items of a person whose HR record has `managerId` (an employee id) and no `managerEmail` to the entitlement owner or the default reviewer. The manager is now the live identity of the tenant whose `profile.employeeId` is that id, and the item's `reviewerId` is that identity's email; an id no live identity has, or two have, falls back as before.

### Fixed: onboarding and mover SoD compare entitlements by catalog id

No migration, no new env var.

- The policy engine's SoD check (onboarding, the mover, risk scoring's SoD factor) compared a rule's target and an SoD policy's entitlement by their ids exactly, so a policy naming a group by its native id (GUID) never met a rule naming it by display name, and a joiner could get both sides of a BLOCK policy. Both sides are now compared as their entitlement catalog native id, as the access request check already did; a target the catalog does not know, or names twice, keeps its own id. Expect onboarding and mover runs to fail with `SoDViolation` (and risk scores to count the conflict) where such a policy matches.

### Fixed: access request fulfilment and expiry change the entitlement only

Deploy the worker; no migration, no new env var, no workflow change.

- Fulfilling an access request, and removing its access at its end date, PATCHed the person's Entra ID attributes from a profile built by hand (`officeLocation` from `location`, empty `givenName`/`surname` when the profile had none) and, when no Entra ID object id was recorded for the person, created an account. Both now add or remove only the group membership, directory role or license, on the account recorded for the person (`backend/src/activities/entra-entitlement-changes.ts`).
- A request whose fulfilment fails ends `REJECTED` as before, and `GET /api/v1/access-requests/:id` now carries why in `statusReason`: no Entra ID account recorded for the person (onboarding creates it), the recorded account no longer in Entra ID, Graph's refusal, or a system other than Entra ID. A Graph failure retrying can fix (a 5xx, no answer, a 429) no longer rejects the request: the worker retries the fulfilment and the request stays `PROVISIONING` meanwhile.
- At the end date, no recorded account, an account Entra ID no longer has, a group that no longer exists and a license whose SKU the tenant no longer has count as removed. A removal Graph refuses in a way retrying cannot fix keeps the request `ACTIVE` with the reason in `statusReason` (the request page shows "Access not removed yet") and emits `provisioning.failed` (`retryable: false`) once per reason; the removal is still tried again at most every 6 hours, and the attempt that succeeds clears the reason before the request ends `EXPIRED`.
- The Entra ID connector reports the removal of a license whose SKU the tenant does not have as `unchanged` (no user can hold it); it was a failed change. This applies to every caller (mover, reconciliation).

### Fixed: an identity edit during a mover run is queued on it, and the PATCH says so

Deploy the API and the worker together; no migration, no new env var.

- An edit that moved a mover trigger attribute (`departmentName`, `jobTitle`, `location`, `managerEmail`) of a provisioned identity while its mover run was open was logged and dropped (without `syncToEntra`), or answered "already in progress" (with it): the access change waited for the next HR sync. Now the edit is queued on the open run, which evaluates the identity once more when it ends, also after a failure.
- `PATCH /api/v1/identity/:id` now asks the mover itself for such an edit and reports it in `workflow` also without `syncToEntra` (was always `null` there): `{ triggered: true, workflowType: "mover", workflowId, trackingUrl }` for a run it started, or `{ triggered: false, queued: true, workflowType: "mover", workflowId, trackingUrl, message }` with the open run's id for a queued change (with `syncToEntra=true` too, instead of the "already in progress" `error`). An edit that moves no trigger attribute still answers `workflow: null` without `syncToEntra`.

### Fixed: a bulk DISABLE or DELETE marks the identity's provisioning entry

Deploy the API and the worker together; no migration, no new env var.

- A bulk DISABLE or DELETE (`POST /api/v1/bulk-provisioning/start`) changed the Entra ID account and left the identity's provisioning entry `SYNCED` until reconciliation found the drift, so `GET /api/v1/identity/:id` and offboarding took the account for active. At the end of the run, the entry of each account it removed and did not roll back is now `DEPROVISIONED` (the identity found by the operation's `sourceSystem` and `sourceUserId`, else its email). No identity is created or changed otherwise; an operation whose identity is not found changes nothing in the Hub.

### Fixed: cancelling a bulk run rolls back what it changed and keeps its results

Deploy the API, the worker and the frontend; no migration, no new env var.

- `POST /api/v1/bulk-provisioning/cancel/:workflowId` signalled the run and then terminated it: an operation in flight was left half done, the completed ones stayed in place and `GET /api/v1/bulk-provisioning/results/:workflowId` had nothing to return. Now the run stops before its next batch or delete, rolls back what it changed (as a failed fail-fast run does; a DELETE cannot be undone) and completes with result `status: "CANCELLED"` (new value), its operation results, `errors` and `summary.rolledBack`. The workflow's Temporal status is `COMPLETED`. The answer's `message` is `Cancel requested` (was `Workflow cancelled`), and a batch that is not running answers `409`. The Bulk operations results step says the batch was cancelled and how many operations were rolled back.

### Fixed: a new record of a raised mixed-case email pair is held, not minted

Deploy the API and worker after migration `20261126000003-identity-open-conflict-index` (DEPLOYMENT.md "Before the deploy", item 16); no new env var.

- Two live identities stored before the email was lower-cased, with one address in different cases, are left as they are by migration `20261125000003-identity-email-lowercase` and raised as a correlation conflict. Until they are merged, a new record of that person (an HR ingest, SCIM `POST /scim/v2/Users`, `POST /api/v1/identity`, a bulk CREATE) minted a third identity, since every lookup compares the lower-cased address exactly. Such a record is now held on that conflict: `POST /api/v1/connectors/:name/ingest` counts it as held for review and creates nothing, as for any record whose email a live identity has, and the next sync after the merge correlates it.

### Fixed: a status PATCH while the kill switch is on is kept for its release

Deploy the API; no migration, no new env var.

- `PATCH /api/v1/identity/:id` with a `status` while the identity's kill switch (`isLoginDisabled`) is on wrote that status to the profile, which lifted the suspension until the next reconcile, and that reconcile suspended it again and kept the status from before the PATCH; turning the switch off then undid the operator's change. Now the identity stays `SUSPENDED` and the PATCHed status becomes the one the switch keeps (`metadata.statusUnderKillSwitch`) and gives back when it is turned off. The response's `status` stays `SUSPENDED`; `changedFields` names `status` when the kept status changed.

### Changed: the tenant's Max Identities is enforced where an identity is created

Deploy the API, the worker and the frontend; no migration, no new env var. Check each tenant's limit first (DEPLOYMENT.md, "What clients and admins will notice").

- `settings.maxIdentities` of `PATCH /api/v1/tenants/:id` was stored and never read. Now a record that would create an identity while the tenant has that many live (not soft-deleted) identities creates none: `POST /api/v1/identity` answers `409` "The tenant's identity limit (N) is reached: no identity was created. ...", `POST /scim/v2/Users` answers the SCIM error `{ status: "409", detail }` with no `scimType`, and a bulk or batch provisioning row fails with that message. Updates, rehires and correlations onto an existing identity are never refused. Unset (or an empty console field, sent as `null`) is no limit.
- `POST /api/v1/connectors/:name/ingest` answers a new count `rowsHeldForIdentityLimit` (always present) and `identityLimit` (when rows were held): rows of new people the limit held, neither `ingested` nor `errors`. Every sync reads them again, so the first sync after the limit is raised creates them.

### Added: `webhook.subscription_updated` event

Deploy the API; no migration, no new env var.

- `PATCH /api/v1/event-subscriptions/:id` emitted no event, so pointing a subscription at another receiver left no entry in the audit log. It now emits `webhook.subscription_updated` `{ subscriptionId, name, changed, webhookHost? }`: `changed` lists the fields the PATCH set (`name`, `status`, `filters`, `webhook.url`, `webhook.headers`, `webhook.signingSecret`), and `webhookHost` (host and port) is present only when the URL changed. Like the other `webhook.*` events it reaches the tenant's websocket and the audit log (`GET /api/v1/audit`) and is never delivered to webhooks; it carries no URL, header value or secret.

### Fixed: tenants whose settings were stored with a wrong type can be edited again

Run migration `20261126000002-tenant-settings-types` before the deploy (DEPLOYMENT.md, "Before the deploy", item 15); no new env var.

- `PATCH /api/v1/tenants/:id` answered 400 to every console edit of a tenant whose settings were stored with a wrong type before settings were validated (`mfaRequired: "false"`), because the edit form sends the stored settings back. The migration stores each known setting as its type, and removes a value it cannot read (logged). `GET /api/v1/tenants` then answers those settings typed: `mfaRequired` and `features` flags as booleans, `maxIdentities` and `retentionDays` as numbers, `allowedConnectors` as an array.

### Fixed: `POST /api/v1/tenants/migrate` looks at every tenant collection

Deploy the API; no migration, no new env var.

- The migration moved unassigned documents only in a hand-kept list of 17 collections, so access requests, the outbox, consents, joiner and leaver records and the other newer tenant collections kept documents without a tenant. It now covers every collection whose model carries the tenant plugin, plus the old names; `collections` in the answer (dry run or not) lists each of them. The audit chain (`audit_events`, `audit_chain_heads`, `audit_roots`) is never moved.

### Changed: SAML creates admins only in allowed tenants, and never above `SAML_JIT_MAX_ROLE`

Deploy the API; no migration. New optional env vars `SAML_JIT_MAX_ROLE` (default `viewer`) and `SAML_ALLOWED_TENANT_IDS` (default: only the default tenant); DEPLOYMENT.md, "Before the deploy", item 9.

- A first SAML sign-in created the admin with any role up to `super-admin` from `SAML_ROLE_ATTR` and in any tenant from `SAML_TENANT_ATTR`, an unknown tenant included, so an IdP admin of one tenant could create a super-admin in another. The role is now the asserted one (or `SAML_DEFAULT_ROLE`) held to `SAML_JIT_MAX_ROLE`, `super-admin` never. A tenant the assertion names must be on `SAML_ALLOWED_TENANT_IDS` and be an active tenant; otherwise no admin is created and the callback redirects to `/login?saml_error=...`.
- An existing SAML admin keeps the role and tenant stored, whatever later assertions say (unchanged, now tested).

### Fixed: a SAML sign-in code works only in the browser that started the sign-in, and keeps the page asked for

Deploy the API and the frontend together; no migration, no new env var. A SAML sign-in that is in progress during the deploy (between the IdP page and the console) is refused once and has to be started again.

- `GET /api/v1/auth/saml/login` sets an HttpOnly `SameSite=Strict` cookie `saml_binding` (path `/api/v1/auth/saml`, 15 minutes) and sends the IdP a random RelayState id. `POST /api/v1/auth/saml/exchange` answers `401` "This sign-in was started in another browser" when the request lacks the cookie of the sign-in that made the code, and the code is used up. A link `/auth/saml-callback?code=<another person's code>` no longer signs the opener in as that person (login CSRF). The exchange clears the cookie.
- `POST /api/v1/auth/saml/callback` refuses a response whose RelayState the API did not issue or has seen used (redirect to `/login?saml_error=...`), unless `SAML_VALIDATE_IN_RESPONSE_TO=ifPresent`, where such a response is an IdP-initiated sign-in with a code bound to no browser.
- `GET /api/v1/auth/saml/login?returnUrl=` was sent to the IdP as RelayState and never read back. A console path (one leading `/`, no `//`, backslash, colon or control character, up to 2048 characters) now comes back on the callback redirect as `/auth/saml-callback?code=...&returnUrl=...`, and the console opens it after the sign-in. Anything else is dropped.

### Changed: the access graph keys an entitlement by its system and its id there

Deploy the API, the worker and the frontend together, then resync each tenant's graph (DEPLOYMENT.md, "After the deploy", item 1); no migration, no new env var.

- An `:Entitlement` node was keyed by its native id and the tenant, while the entitlement catalog is unique on tenant, system and native id, so one native id in two systems (`admin`, a numeric group id) was one node: `GET /api/v1/access-explorer/entitlement/:id/holders` mixed the holders of both, `/path` led to the wrong system and `/identity/:id/sod-violations` raised a conflict from entitlements in different systems. A node's `id` is now `<system>::<native id>`, the system as the catalog names it (`entra-id`, `ad`, `okta`, ...), and the node carries `nativeId` and `system`. Every answer's entitlement node ids and relationship `targetId`s use the new key.
- `GET /api/v1/access-explorer/entitlement/:id/holders` and `GET /api/v1/access-explorer/path?toEntitlement=` take that key and answer `400` for a bare native id ("must be <system>::<id in that system>, as the graph answers it, ..."), since it can name entitlements in two systems. The access explorer page sends the key; its typed entitlement id needs the kind of entitlement first.

### Fixed: one access graph resync per tenant across API replicas

Deploy the API; no migration, no new env var. Several API replicas need `REDIS_URL` (as for the other cross-replica locks).

- `POST /api/v1/access-explorer/resync` refused a second resync of a tenant (`409`) only on the same API process. Two replicas could run one each, and each run removed the nodes and edges the other had written. The lock is now held in the shared lock store (Redis with `REDIS_URL`), so a resync started on any replica answers `409` while one runs for that tenant.

### Fixed: cold-storage archival runs, archives every old document and keeps documents out of workflow history

Deploy the worker; no migration, no new env var. Applies only where `ARCHIVAL_ENABLED=true`.

- The nightly `archival-nightly` run failed at its first step: the activity that lists the tenants was not registered on the worker. It is.
- Archival skipped every document inside the date range of a batch it had archived before, so rows that shared the last timestamp of a full batch, and events written late with an old timestamp, were never exported and the audit TTL deleted them. It now archives whatever is still older than the cutoff (an exported batch is deleted by id). A batch that was uploaded but not deleted is exported again, so an archive can hold a document twice but never miss one.
- A run passes document ids between its steps instead of up to `batchSize` documents (patch `archival:ids-not-documents`), records each batch in `archival_records` under the export object's own name as `batchId` (unique; it was `batch-<collection>-<n>`, restarting at 0), and reports the totals of the whole run in its result, not only of its last continued part.

### Fixed: GDPR erasure reaches every record of the person, the access graph and the Elasticsearch index

Deploy the API; no migration, no new env var.

- `DELETE /api/v1/identity/:id/gdpr-erase` deleted the identity, its timeline, audit entries, review items, exclusions and published outbox events, and left the person's data elsewhere. It now also deletes the person's `consents`, `credential_inventory`, `identity_risk_scores`, `risk_scores`, `anomalies`, `joiner_events`, `leaver_events`, `offboarding_records`, `mover_batch_items`, `upcoming_offboardings`, `drift_records` and the `access_requests` for them, and takes the person out of the records that stay: an NHI agent they own keeps its owner id with `owner.email` `(erased)`, and their id leaves `peer_groups` and `policy_suggestions`. It deletes their access graph node (Neo4j) and their documents in the Elasticsearch audit index (the erasure entries stay, as in MongoDB), so `GET /api/v1/analytics/v2/search` no longer finds them; `POST /api/v1/analytics/v2/backfill` does not index them again.
- The attestation's `documentCounts` has a key for each of these (`access_graph`, `elasticsearch_audit_events` included; a dry run counts them too), and a new field `notReached` lists a store the API could not reach (Neo4j configured but not connected, no Elasticsearch connection): the rest is erased, and a graph resync or an index rebuild removes what is left there. The erasure audit entry records the same.

### Fixed: one consent record per identity and purpose, and expired consents read as expired

Run migration `20261126000001-consent-unique-per-purpose` before deploying the API; no new env var.

- `POST /api/v1/identity/:id/consent` sent twice at once could store two records for one purpose; `DELETE /api/v1/identity/:id/consent/:purpose` then revoked one and `GET /api/v1/identity/compliance/consent-report` still counted the other as granted. `consents` is unique per tenant, identity and purpose; the migration keeps the record changed last of each duplicated purpose.
- A consent past its `expiresAt` stayed `granted` in `GET /api/v1/identity/:id/consent` and in the consent report. Both now mark such records `expired` before they answer (status `expired`, counted under `expired`). A grant again with a new expiry makes the record granted again.

### Fixed: the DSAR export holds the subject's access, not the tenant's catalog

Deploy the API; no migration, no new env var.

- `GET /api/v1/identity/:id/dsar-export`: `entitlements` held the entitlement catalog entries of the systems the person was provisioned in, and the tenant's whole catalog when they had no provisioning state, so the package carried far more than the subject's data. It now holds the person's own grants as `GET /api/v1/identity/:id/entitlements` lists them (`entitlement`, `type`, `targetSystem`, `source`, `grantedBy`, `status`, `expiresAt` for a time-bound request); empty for a person with none or a deleted identity. The `DATA_EXPORTED` audit entry's `entitlementCount` counts those.

### Fixed: SOX and ISO 27001 report figures count what the period holds

Deploy the API; no migration, no new env var. Reports generated before keep their figures.

- `POST /api/v1/compliance-reports/generate` (ISO27001): "Policy Changes" counted audit actions nothing writes and was always 0; it now counts `policy.created`, `policy.updated`, `policy.deleted`, `sod_policy.created`, `sod_policy.updated` and `sod_policy.deleted` in the period. "GDPR Erasures" counted dry runs too; it counts executed erasures only.
- Campaign figures (SOX and ISO27001) were today's state of at most the newest 100 campaigns, whatever the period. Now: campaigns completed within the period; in progress and overdue as they stood at the period's end (created by then and not completed by then; overdue past their deadline then). Pending reviews and auto-revoked items are those campaigns' counters as stored now.

### Fixed: a witness that does not answer no longer holds a Merkle checkpoint open

Deploy the API and the worker; new optional env var `AUDIT_ANCHOR_WITNESS_TIMEOUT_MS` (default 10000).

- With `AUDIT_ANCHOR_WITNESS_URL` set, the delivery of a signed checkpoint to the witness had no timeout, so a witness that never answered held `POST /api/v1/audit/merkle-roots` (super-admin) and the daily checkpoint run open. A delivery not answered within `AUDIT_ANCHOR_WITNESS_TIMEOUT_MS` is logged as failed, as a refused one was, and the checkpoint is stored signed, without the witness's answer.

### Fixed: an NHI revoke or kill switch reaches every active delegated agent, also on a retry

Deploy the API; no migration, no new env var.

- `POST /api/v1/nhi/:agentId/revoke` and `/kill` ran the cascade only when the agent itself changed, so after a call that failed part way through (an audit write) a second call answered success and left delegated agents active. The cascade now runs on every call: on an agent already revoked the call still revokes its delegated agents that are active, and `?dryRun=true` answers `changes: true` with them in `reached`.
- The cascade also reaches active agents below a delegated agent that is revoked or expired; before, the walk stopped there.
- `POST /api/v1/nhi/:parentAgentId/delegate` whose parent is revoked while the child is being stored answers `409` ("Parent agent 'x' was revoked while the delegated agent was created; 'y' is revoked too.") and the child is stored revoked (its kill switch engaged when the parent's is); before, the child stayed active outside the cascade that had already run.

### Fixed: a credential policy PATCH changes only the settings it sends

Deploy the API; no migration, no new env var.

- `PATCH /api/v1/credential-lifecycle/policies/:id` with part of a settings object (`targetScope`, `passwordPolicy`, `rotationPolicy`, `mfaRequirement`) replaced the whole stored object and filled the fields it did not send with their create defaults: `{ "rotationPolicy": { "notifyDaysBefore": 3 } }` switched rotation off and set the interval back to 90 days, and a `targetScope.connectorTypes` change emptied `employmentTypes`. Now only the fields sent change; the others keep their stored values. A settings object the policy did not have is stored with the defaults a create gives it. The body is validated as before.

### Fixed: the impact analysis counts the canvas's target systems only

Deploy the API; no migration, no new env var.

- `POST /api/v1/blueprints/impact-analysis` without `connectors` treated every canvas node but the hub as a target system, so each HR source node added a `CREATE` delta per user, which raised `affectedPercentage` and the risk level that gates Deploy. Only the nodes with `data.role: 'target'` count now. A connector or node type is read as Active Directory only when it is `ad` or `active-directory` (`workday` and `adp` were AD before), and `entraMetadata` is generated only for an Entra ID connector.

### Changed: connector status answers only what it checked

Deploy the API; no migration, no new env var.

- `GET /api/v1/blueprints/connector-status/:connectorId` answered a fixed `rateLimit` (5000 of 10000) and a `credentials.expiresIn` from `CREDENTIAL_EXPIRY_DAYS` (default "45 days") for every connector, values never read from the target. Both are gone; the answer has `health`, `credentials.valid` and, when offline, `errorMessage`. The Design studio's connector manager no longer shows them. `CREDENTIAL_EXPIRY_DAYS` is no longer read.

### Fixed: who changed a canvas, a node's connector settings or an anomaly is recorded

Deploy the API; no migration, no new env var.

- `POST /api/v1/blueprints/save` wrote its audit entry with the actor `admin` whoever saved; it is the signed-in user now. `PATCH /api/v1/blueprints/:id` (a node's connector settings, secrets included) wrote no audit entry; it writes `CONFIG_CHANGED` (resource type `blueprint-node`) with the actor, the node type and the names of the settings saved, never their values.
- `POST /api/v1/anomalies/:id/dismiss` and `/resolve` record who did it: anomalies (`GET /api/v1/anomalies`) gain `resolvedBy`.

### Changed: Deploy needs a current impact analysis, and a confirmed critical one

Deploy the API and the frontend together; no migration, no new env var.

- `POST /api/v1/blueprints/readiness-check`: the "Impact Analysis" check fails ("The canvas was saved after the last impact analysis: run it again") when the canvas was saved (`POST /api/v1/blueprints/save`, which now stamps `pipelineConfig.canvasSavedAt`) after the last impact analysis; one old simulation unlocked any later deploy. A canvas saved before this release has no stamp and keeps passing until its next save.
- A critical-risk impact analysis is a warning with `acknowledgementRequired: true` (new optional field of a check) and the message "Impact analysis reviewed (critical risk): confirm it to deploy". `POST /api/v1/blueprints/deploy` takes an optional body `{ acknowledgeCriticalRisk: boolean }`; without `true` such a deploy answers `422` ("Deploying with a critical-risk impact analysis needs its confirmation", the readiness result in the body). Another field, or another type, is `400`. `pipeline.deployed` carries `acknowledgedRisk: 'critical'` for a confirmed deploy. The Deploy modal asks for the confirmation.

### Changed: reconciliation test routes removed; start and bulk answers

Deploy the API; no migration, no new env var.

- Removed `POST /api/v1/reconciliation/test/sample-daily` and `POST /api/v1/reconciliation/test/sample-transaction` (operator, every environment): the first started a real reconciliation with auto-correction on, the second created `tx.test@test.com` in the tenant's Entra ID. They answer `404`.
- `POST /api/v1/reconciliation/start-daily` while the tenant's run is still open answers `409` ("A daily reconciliation of this tenant is already running"), not `500 Operation failed`.
- `POST /api/v1/reconciliation/drifts/bulk-correct` and `bulk-ignore` answer `400` naming each `driftIds` entry that is not a drift id (24 hex characters); before, one such entry failed the whole request with "Invalid ID format".

### Fixed: dead-letter dismiss and list paging

Deploy the API; no migration, no new env var.

- `POST /api/v1/dead-letter/:id/dismiss` dismissed any entry, so a replayed one (or one already dismissed) got a new status, `resolvedBy` and `resolvedAt`. Only an open entry (pending, retrying, failed permanently) is dismissed now; any other answers `409` naming its status and is left as it is.
- `GET /api/v1/dead-letter?offset=abc` or a negative offset answered `500`; it answers `400` now.

### Fixed: the Elasticsearch audit index keeps one document per event

Deploy the API; no migration, no new env var. Where Elasticsearch is used, rebuild the index once (`docs/DEPLOYMENT.md`, After the deploy).

- `GET /api/v1/analytics/v2/search` and `v2/seasonal-patterns` undercounted: live indexing stored each domain event under its request's correlation id, so the events of one request (an HR sync's `identity.created` events) overwrote one another. Each event is now its own document (`_id` its `eventId`), with `correlationId` as a field; a backfill writes the same ids.

### Fixed: license forecast rate and days to capacity

Deploy the API; no migration, no new env var.

- `GET /api/v1/analytics/license-forecast`: `daysToCapacity` was 30 times too large (10 licenses left at 5 a month gave 1800 days, not 60), so the capacity warning almost never showed. `monthlyRate` divided the change by the months that had license changes, not by the calendar months of the 6-month window; it now counts every month. `currentCount` is unchanged: the net change EuroID recorded in the window, starting at 0.

### Fixed: upcoming offboardings list every leaver, counted today

Deploy the API; no migration, no new env var.

- `GET /api/v1/analytics/upcoming-offboardings` answered the cached entries whenever any existed, and nothing recomputed them: a leaver whose end date was set after the first compute never appeared, one whose end date changed dropped out, and `daysRemaining` stayed as first computed. The identities ending in the window are now read on every call, `daysRemaining` is counted at the call, and only the blast radius comes from the cache (recomputed when the entry is stale or its end date differs).
- `refresh=true` (a policy evaluation per leaver) is honoured for a super-admin only, as `POST /api/v1/analytics/refresh` is; for other roles it is ignored, and the list they get is current anyway.

### Fixed: a dismissed anomaly stays dismissed, and risk scores come down

Deploy the API and the worker; no migration, no new env var.

- An analysis (`POST /api/v1/anomalies/analyze`, and the one a provisioning or drift event starts) re-created a dismissed, resolved or acknowledged anomaly, with a new `anomaly.detected` event, because it de-duplicated only against an open one. It now adds no anomaly of a type the identity has open or acknowledged, nor one whose evidence (its events, or the entitlements it names) a dismissed or resolved anomaly already covers: only new evidence makes a new anomaly.
- `GET /api/v1/anomalies/risk-scores`: an identity's score was written only when a rule found something, so it never came down. It is now the score of the identity's open and acknowledged anomalies (each type once), recomputed by every analysis and by dismiss and resolve; an identity with none open is no longer listed.
- The nightly identity risk score (`GET /api/v1/risk-scores/...`) counts only open and acknowledged anomalies, and writes no new score when the policy evaluation fails (before, it wrote a low score with trend `DECREASING`).

### Fixed: a cancelled or half-made distributed transaction leaves no account behind

Deploy the worker; no migration, no new env var.

- A distributed transaction cancelled while it committed (Temporal UI or CLI) left the systems that had committed in place: the rollback activity, scheduled in the cancelled scope, never ran, and the systems were reported PREPARED. Prepare and commit now run to their end, the rollback runs after a cancel whatever `autoRollback` says, and the result (`GET /api/v1/reconciliation/result/:workflowId`) has the phase (`ROLLED_BACK`, `ROLLBACK_FAILED` or `FAILED`), each system's state and an `error` saying it was cancelled; the run completes rather than ending cancelled.
- A CREATE whose Entra ID provision failed after the account was made (a refused group, role or license change) was `FAILED` and skipped by the rollback, so the account stayed. The system keeps the account's `createdAccountId`, and the rollback deletes it (`ROLLED_BACK`, or `ROLLBACK_FAILED` when the delete fails).

### Fixed: a distributed transaction keeps no national ID in its workflow input

Deploy the API and the worker; no migration, no new env var.

- `POST /api/v1/reconciliation/distributed-transaction` passes unknown `user` fields through, so a national ID sent as `hetu`, under the tenant's Hashed National ID field or in `customAttributes` went into the workflow input and its Temporal history; only the Hub write removed it. It is now taken out before the workflow starts, and with the tenant's Hashed National ID rule its hash goes in as the user's `correlationId` (a `correlationId` in the body is dropped under the rule), which the Hub save matches on. When the correlation settings cannot be read, the route answers `500` and starts nothing.

### Fixed: a resumed pipeline is not paused again by the outcomes that tripped the breaker

Deploy the API; no migration, no new env var.

- `POST /api/v1/blueprints/resume` kept the hour's provisioning metrics, so the next outcome (a success too: 1 failure in 6 is 16.7%, over the 5% default) recomputed the same error rate and the circuit breaker paused the pipeline again until the hour rolled over. Resume now starts the window afresh.

### Fixed: a connector whose sync worker died is synced again on schedule

Deploy the API and the worker; no migration, no new env var.

- `GET /api/v1/connectors`: a connector's `lastSyncStatus` could stay `running` for good after the process running its sync died, and the hourly scheduler skipped it, so HR joiners and leavers were no longer detected until someone ran the sync by hand. A running sync now renews its lock every 5 minutes; a lock not renewed for 30 minutes is taken over by the next scheduled sync. An ingest longer than 30 minutes no longer loses its lock to the retry of its own activity, which then ran a second ingest alongside.

### Fixed: an orphan cleanup acts only on an account that is still an orphan

Deploy the API and the worker together; no migration, no new env var.

- After the grace period the cleanup disabled the account without checking that its drift was still open or the account still an orphan, so an employee whose identity HR created during the grace was disabled, and later deleted with `ORPHAN_AUTO_DELETE_AFTER_EXTENDED`. It now asks before every disable and delete; an account an identity has now gets its `ORPHAN_ACCOUNT` drift closed `corrected` (`drift.resolved`, `resolutionAction: no_longer_orphan`) and is left alone.
- AD and SCIM orphan accounts are disabled (before, nothing changed and the drift's `orphanDetails.disabledAt` was set anyway). `disabledAt` is set only after a disable that happened; a failed delete leaves the drift quarantined.
- `POST /api/v1/reconciliation/orphans/:driftId/signal`: the drift's `orphanDetails.decidedBy` is the operator who sent ADOPT or DELETE, not `workflow-signal`. A `:driftId` that is not a drift id answers `400` here and on `GET /api/v1/reconciliation/orphans/:driftId/simulate-delete`.

### Fixed: orphan detection quarantines only accounts nobody owns

Deploy the API and the worker; no migration; new optional env var `ORPHAN_EXCLUDED_ACCOUNTS` (API and worker).

- An account was matched to an identity by its UPN only (its mail only when it had no UPN), case-sensitively, so an employee whose UPN differed from the stored email in case, or whose mail was the stored email, got an `ORPHAN_ACCOUNT` drift (`GET /api/v1/reconciliation/drifts?type=ORPHAN_ACCOUNT`) and a cleanup that disabled the account after the grace period. The UPN and the mail are both matched now, in any case.
- Entra ID guest accounts (`#EXT#` in the UPN) and the accounts named in `ORPHAN_EXCLUDED_ACCOUNTS` (UPNs or mails, `*` for any text: break-glass and service accounts) are never orphans.

### Fixed: a large tenant's reconciliation batch stays within Temporal's payload limit

Deploy the worker; no migration; new optional env var `RECONCILIATION_PAGE_SIZE` (worker, default 200).

- A batch fetched up to 5000 identities with their whole profile and metadata in one activity result, several MB on a tenant of a few thousand people, over Temporal's 2 MB payload limit: the batch failed and the run reported 0 scanned. It now fetches pages of `RECONCILIATION_PAGE_SIZE` identities with the fields drift detection reads.
- `GET /api/v1/reconciliation/result/:workflowId`: a report's `drifts[].hubState`, and a correction's `user`, hold those fields only (`_id`, `email`, `status`, `displayName`, `firstName`, `lastName`, `sourceSystem`, `sourceUserId`, `employmentType`, `tenantId`), never the whole profile. A correction re-reads the stored identity first, and an identity no longer in the hub is not corrected.

### Fixed: reconciliation raises drifts only for what the target account carries

Deploy the API and the worker; run migration `20261126000000-close-false-positive-drifts` (`docs/DEPLOYMENT.md`, item 13); no new env var.

- A run compared hub fields (`firstName`, `lastName`, `email`, `jobTitle`, `departmentName`, `mobilePhone`, `officeLocation`) with account fields the Entra ID, AD and SCIM lookups never return, so an account that matched its identity raised a `FIELD_MISMATCH` per field on every run (auto-corrected by re-provisioning). It now compares the display name (when the identity has one and the target reports one) and the enabled state only. A display name `FIELD_MISMATCH` is auto-correctable in Entra ID only.
- `STATUS_MISMATCH` compared the hub status with `ACTIVE` and `DISABLED`, so every TERMINATED, SUSPENDED, INACTIVE or PENDING identity raised a CRITICAL drift that never closed. The account's enabled state is now compared with the one provisioning writes for the status: enabled for `ACTIVE` and `PENDING`, disabled for every other status, a linked admin account only during its session. Its drift record (`GET /api/v1/reconciliation/drifts`) holds `hubValue` `ENABLED` or `DISABLED` (expected) and `targetValue` the account's, both written the same way; a record stored before keeps its old values until the next run updates or closes it.
- A `STATUS_MISMATCH` that disables the account (a leaver's account still enabled) is marked auto-correctable (`autoCorrectEligible: true`); one that enables an account is not.
- Correcting a `STATUS_MISMATCH` (`POST /api/v1/reconciliation/drifts/:id/correct`, bulk correct, a run's auto-correction) sets the state the hub status expects, in Entra ID, AD (by the DN of the account the email finds) and SCIM (by userName or email); before, AD and SCIM answered `400 Correction failed`, and a PENDING identity's account was disabled. The correction's `action` is `DISABLE` or `ENABLE`.

### Fixed: an IdP retrying a SCIM group create makes no duplicate group

Run migration `20261125000004-scim-group-unique-name` before the new API starts (`docs/DEPLOYMENT.md`, item 12); no new env var.

- `POST /scim/v2/Groups` checked for a group with the display name and then inserted one, so two creates at once (an IdP retry) made two groups. A tenant's SCIM group names are now unique in the database: the create that loses answers `409` `uniqueness`, as a create of an existing name did, and renaming a group (`PUT`/`PATCH`) to another group's name answers `409` `uniqueness`. The migration merges existing duplicates into the oldest group of each name.

### Fixed: policy suggestions stay decided

Deploy the API; no migration, no new env var.

- `POST /api/v1/policy-suggestions/analyze` created a new pending copy of a suggestion an admin had dismissed or accepted, on every run. A suggestion with the same type and title that is pending, dismissed or accepted is no longer made again.
- `POST /api/v1/policy-suggestions/:id/accept` and `/dismiss` read the suggestion, checked it was pending and wrote it later, so two accepts at once created two DRAFT policies. Each now claims the pending suggestion first: of two accepts, or an accept and a dismiss, at once one goes through and the other answers `400` ("is not pending"). A policy that could not be created leaves the suggestion pending.

### Fixed: a policy condition group without conditions no longer matches everyone

Deploy the API and the worker; no migration, no new env var.

- `POST /api/v1/policy` and `PATCH /api/v1/policy/:id` accepted a condition group with an empty `conditions` list, and the engine read an empty AND group as true: once activated, such a policy granted its actions to every identity. An empty group is now refused (`400`, "A condition group needs a condition"), and a stored one matches nobody.

### Fixed: a campaign created through the API reviews the employment types it names; `deadline` is validated

Deploy the API; no migration, no new env var.

- `POST /api/v1/access-reviews/campaigns` accepted `targetEmploymentTypes` and dropped it, so every campaign made through the API reviewed only the default human types and never `SERVICE_ACCOUNT` or `ADMIN_ACCOUNT` identities. It is now passed on; it must be a non-empty list of `FULL_TIME`, `PART_TIME`, `CONTRACTOR`, `INTERN`, `CONSULTANT`, `SERVICE_ACCOUNT`, `ADMIN_ACCOUNT` (`400` otherwise).
- `deadline` must be an ISO 8601 date-time in the future (`400` otherwise). Before, an unreadable one failed when stored, and a past one expired every item at activation (and revoked them with `autoRevokeOnExpiry`). Without `deadline` the campaign is due in 30 days, as before.

### Changed: activating a campaign while Temporal is unreachable answers 503

Deploy the API; no migration, no new env var.

- `POST /api/v1/access-reviews/campaigns/:id/activate` answered `400` "Temporal is not connected. Start the Temporal server and restart the backend." while the API had no Temporal connection. The API reconnects on its own, so the answer is now `503` "Temporal cannot be reached right now. The API reconnects on its own; try again in a moment.", and the campaign stays `DRAFT` with no items.

### Fixed: two decisions on one review item at once record one

Deploy the API; no migration, no new env var.

- `POST /api/v1/access-reviews/items/:itemId/decide` read the item, checked it was pending and saved it, so two decisions at once both went through (the last write won, both were audited). The decision is now written only on a pending item; the other gets `400` ("already decided"). The campaign `stats` move by each decision instead of being rewritten from a snapshot of every item, so concurrent decisions no longer leave them stale.

### Fixed: one failed activation no longer ends a recurring review series

Deploy the worker; no migration, no new env var.

- The daily recertification run cloned a due recurring campaign, stopped the source's recurrence, then activated the clone. When the activation failed (Temporal or Entra ID briefly down), the clone stayed `DRAFT` and the series ended without a trace. The source now stops recurring only after the clone is activated; a `DRAFT` clone left by a failed run is activated on the next run, and the failure counts in the run's `errors`.

### Fixed: activating a campaign twice, or again after a failure, no longer duplicates its review items

Deploy the API and the worker; no migration. New optional env var `ACCESS_REVIEW_ACTIVATION_CLAIM_MS` (default 3600000).

- `POST /api/v1/access-reviews/campaigns/:id/activate` created the review items one by one and, when the Temporal start failed or an error came partway, only put the campaign back to `DRAFT`: the items stayed, and the next activation made a second set. Two activations at once both made a set. An activation now claims the campaign (a second one at the same time answers `409`), clears what an earlier attempt left, and on any failure deletes its items and leaves the campaign `DRAFT`. A claim older than `ACCESS_REVIEW_ACTIVATION_CLAIM_MS` (its process stopped) is taken over.
- Items of a `DRAFT` campaign are no longer in `GET /api/v1/access-reviews/my-reviews`, and deciding one answers `409` (before: accepted, though no workflow acted on it). Any campaign that is not `ACTIVE` now refuses decisions with `409`.

### Changed: any signed-in approver can decide their access request step

Deploy the API; no migration, no new env var.

- `PUT /api/v1/access-requests/:id/approve`, `/reject` and `/delegate` required the `operator` role, while MANAGER and OWNER steps go to ordinary employees: a manager with a `viewer` account saw the request in Pending approvals and got `403` deciding it. The routes now need `viewer`; who may decide a step is unchanged (the step's approver, or a holder of a ROLE step's role, checked by the service).
- `POST /api/v1/access-requests` and `POST /pre-check-sod` by a requester without an identity (an admin known only by their email) and without `targetIdentityId` answer `400` with a message naming `targetIdentityId`; before, the email was looked up as an identity id and the answer was `400` "Invalid ID format".

### Fixed: the pending approvals list and its badge agree

Deploy the API; no migration, no new env var.

- `GET /api/v1/access-requests/pending-approvals` listed every pending request with a step naming the caller, also one whose step they had already decided while a later step waited for someone else, while `GET /pending-approvals/count` counted only requests whose current step was theirs. Both now answer the requests whose current step is the caller's. A `ROLE` step is no longer shown to the person the access is for.

### Changed: who approves an access request

Deploy the API and the worker together; no migration, no new env var.

- A manager's request for a direct report (`POST /api/v1/access-requests` with `targetIdentityId`) is now approvable: the MANAGER step, whose approver is the requesting manager, is stored `APPROVED` by the request itself (`decidedBy` the manager, justification "Approved by the request: the requester is the approver of this step."), and the owner decides the rest. Before, nobody could decide that step (the self-approval guard refused the manager) and the request timed out `REJECTED` after `ACCESS_REQUEST_APPROVAL_TIMEOUT_DAYS`.
- `POST /api/v1/access-requests` answers `400` and stores nothing when a step would have no approver (the person has no `managerEmail`; an entitlement has no `owner`), when its approver would be the person the access is for, or when no step is left for anyone but the requester. Such requests were created and timed out `REJECTED`.
- Each requested entitlement's owner gets an OWNER step (before: only the first entitlement's owner), and every entry's approval chain counts (before: the longest one replaced the others).
- `PUT /api/v1/access-requests/:id/approve`, `/reject` and `/delegate` answer `403` to the person the access is for; `/delegate` answers `400` for a delegate who is the requester or that person.

### Fixed: a cancelled access request is never fulfilled

Deploy the API and the worker; no migration, no new env var.

- `PUT /api/v1/access-requests/:id/cancel` read the request as `PENDING_APPROVAL` and then wrote `CANCELLED` without a condition. Arriving just after the last approval, it overwrote the workflow's `PROVISIONING`, and the workflow still fulfilled the request and wrote `ACTIVE`. The cancel is now written only on a request still `PENDING_APPROVAL` (else `400` "Only pending requests can be cancelled"), and fulfilment claims only a request still waiting for approval: a cancelled one stays `CANCELLED` with nothing granted.

### Fixed: an expiring access request is EXPIRED only once its access is removed

Deploy the worker; no migration, no new env var.

- At a time-bound request's end date a revoke that failed (Entra ID unreachable) was ignored: the request was marked `EXPIRED` and the person kept the access. The approval workflow now tries the revoke again (after 5 minutes, doubling up to 6 hours) until it succeeds; the request stays `ACTIVE` meanwhile and is `EXPIRED` after the revoke that succeeded.

### Fixed: an expiring access request leaves access a rule or another request still grants

Deploy the API and the worker; no migration, no new env var.

- When a time-bound request expired, its entitlements were removed from Entra ID even when a role-based rule or another `ACTIVE` request of the person still granted them. Those are now left in place; the rest is removed as before.
- `POST /api/v1/access-requests` answers `400` ("access requests can grant Entra ID entitlements only") for a catalog entry of another system. Such a request used to be approved and end `ACTIVE` with nothing granted; a stored one now ends `REJECTED` at fulfilment without any part of it granted.

### Fixed: role bundles keep an action's time constraint, and an inherited bundle cannot be deleted

Deploy the API and the worker; no migration, no new env var.

- `POST /api/v1/role-bundles` and `PATCH /api/v1/role-bundles/:id` accepted an action's `timeConstraint` and `targetId` and dropped both on save. Both are now stored, and a bundle action's `timeConstraint` reaches the provisioning operation as a policy action's does.
- `DELETE /api/v1/role-bundles/:id` answers `400` ("inherited by N role bundle(s)") for a bundle another bundle inherits; before, it was deleted and the inheriting bundles lost its actions at the next evaluation.
- A role bundle that cannot be read during evaluation now fails the evaluation (the calling activity retries) instead of giving an intent without the bundle's operations.

### Changed: editing a role bundle sends the policies using it back to review

Deploy the API; no migration, no new env var.

- `PATCH /api/v1/role-bundles/:id` with `actions` or `inheritance` changed what every policy using the bundle grants without the second policy-admin review a policy edit needs. It now sets every policy that uses the bundle, directly or through a bundle that inherits it, to `draft` (an `active` or `disabled` one included) with the editor as `lastEditedBy`, so `POST /api/v1/policy/:id/activate` needs another policy-admin. Each status change emits `policy.updated` (`changedFields: ["status"]`, `previousStatus`, actor: the editor). A change of only the name, description, icon, color or tags keeps the policies as they are.

### Changed: an access request is refused only for a conflict it is part of

Deploy the API and the worker; no migration, no new env var.

- The SoD check of `POST /api/v1/access-requests`, `pre-check-sod` and the re-check before fulfilment refused a request whenever the person's held access plus the request matched a Block policy, also when the person already held both sides (through rules or older requests) and asked for something unrelated. Such a request was refused at creation, or a pending one `REJECTED` at the re-check. Now only a policy match that includes one of the requested entitlements counts; a conflict already held shows in `GET /api/v1/access-explorer/identity/:id/sod-violations` and in access reviews.

### Fixed: the access request SoD check matches a group named by display name or by native id

Deploy the API and the worker; no migration, no new env var.

- A role-based rule names a group by its display name, a request carries the catalog native id (a GUID for Entra ID), and an SoD policy may name either. The check compared the ids exactly, so a policy naming the GUID never saw the rule's birthright group, and a policy naming the display name never saw a requested or held GUID. `POST /api/v1/access-requests`, `pre-check-sod` and the re-check before fulfilment now compare both sides as the catalog entry's native id (the entry with that native id, else the only entry with that name on the system). An id the catalog does not know matches only itself, as before.

### Fixed: the access request SoD check sees birthright access from every attribute rule

Deploy the API and the worker; no migration, no new env var.

- `POST /api/v1/access-requests`, `POST /api/v1/access-requests/pre-check-sod` and the re-check when the last approval comes in counted the person's birthright access by evaluating the rules on a few profile fields only (a `department` the engine does not read, no department name or code, cost center, division, country, custom attributes or contracts). A rule on any of those gave nothing, so a request completing a Block SoD policy with such a rule's group was accepted and fulfilled. The rules are now evaluated on the profile onboarding evaluates, so such a request is refused (`400` with `sodViolations`) or rejected at the re-check.

### Fixed: delegating an access request approval from the console works

Deploy the API; no migration, no new env var.

- `PUT /api/v1/access-requests/:id/delegate` parsed the approve and reject body, whose `decision` is required, so the console's `{ stepIndex, delegateTo }` was answered `400` ("decision Required") and no step could be delegated from the UI. The route now takes `{ stepIndex, delegateTo }` (`delegateTo`: the new approver's email or identity id, not blank); a `decision` sent by an older client is ignored. `PUT /approve` and `PUT /reject` no longer accept a `delegateTo` field (it was ignored there).

### Fixed: `risk_scores.calculated` reports the tenant's average score

Deploy the worker; no migration, no new env var.

- The nightly `risk_scores.calculated` event (webhooks, the audit log) carried as `avgScore` the mean of the tenant's ten riskiest identities, which overstated the tenant's risk. It is now the average of every identity's score in the tenant, to one decimal, as `GET /api/v1/risk-scores/distribution` reports it. `top10IdentityIds` is unchanged.

### Fixed: a move keeps access an approved access request also grants

Deploy the API and the worker; no migration, no new env var.

- A mover run (an attribute edit, `POST /api/v1/identity/:id/access/re-evaluate`, an HR move) removed every entitlement the old attributes' policies gave and the new ones do not, also one the person holds through an `ACTIVE` or `PROVISIONING` access request, which then stayed `ACTIVE` without its access. Such a removal is now left out of the run, and of `GET /api/v1/identity/:id/access/preview` (`toRemove`); the request's own expiry or revoke removes the access.

### Changed: the audit archive run fails when a checkpoint is not exported

Deploy the worker; no migration, no new env var.

- With `AUDIT_ARCHIVE_ENABLED=true`, a checkpoint whose WORM export still failed after its retries was only logged: the daily run completed with `errors` in its result. The run now exports the other checkpoints and then fails (type `AuditArchiveExportFailed`, the failed checkpoint ids in the message, the counts in the details), so the schedule shows it. A run started before the worker runs the new code completes as before.

### Changed: a failed admin account no longer stops a person's onboarding

Deploy the worker; no migration, no new env var.

- Onboarding awaited each admin account child (PAM) before the person's own targets, so one failed tier (for example a second tier's admin UPN taken, 409, with an `ADMIN_UPN_PATTERN` without `{tier}`) left the person without any account and the later tiers without admin accounts. Now every tier is attempted and the person's own accounts are provisioned; a failed tier goes on the person's timeline ("Admin account not provisioned", with the reason) and the run ends failed with type `AdminAccountFailed`, naming the identity and the tier. A run started before the worker runs the new code behaves as before.

### Changed: an identity edit or a new HR source waits for an open HR joiner

Deploy the API; no migration, no new env var.

- `PATCH /api/v1/identity/:id` of `departmentName`, `jobTitle`, `location` or `managerEmail`, and an HR sync that adds a source to an identity, started onboarding for any identity not provisioned yet. For an HR joiner still waiting (its start date ahead, or in a mass-joiner batch waiting for approval) that gave access before the start date or past the admin's decision. Neither starts onboarding for such an identity now: the joiner flow starts it when its rules allow. `POST /api/v1/onboarding/start` ([Provision]) still starts at once.

### Changed: onboarding and the mover provision only while the pipeline is deployed

Deploy the worker; no migration, no new env var.

- The onboarding and mover workflows skipped a person only while the pipeline was `PAUSED` or `STOPPED`, and onboarding made the person's privileged admin accounts before that check. A pipeline never deployed (`DRAFT`, or `SIMULATED` after an impact analysis) provisioned real accounts for runs an identity edit, a new HR source, a manual link, `POST /api/v1/onboarding/start` or `PATCH /api/v1/identity/:id?syncToEntra=true` started, although HR joiners wait for Deploy. Now only `DEPLOYED` provisions, checked before the admin accounts. An onboarding run that provisioned nothing for that reason completes and its result ends with `1 of 1 not provisioned: the provisioning pipeline is not deployed (DRAFT).`; a mover run is reported `skipped` with the reason. A run started before the worker runs the new code keeps the old guard.

### Fixed: a target that did not provision is never SYNCED

Deploy the worker; no migration, no new env var.

- Onboarding and admin account provisioning marked a target SYNCED after any provision that did not throw. AD answers "skipped" without throwing when its config lacks a host or base DN, so the identity showed AD SYNCED with no account: the mover counted it as provisioned and offboarding failed on it for good. Such a target's provisioning entry is now `ERROR` with the target's reason (`errorMsg`), and the onboarding result ends with `Not provisioned to ad: <reason>.`. When writing the account id back to the identity answers that nothing was written, the entry stays `SYNCED` without `writebackComplete`, so the next run writes it back again. A run started before the worker runs the new code behaves as before.

### Fixed: onboarding with an Active Directory target

Deploy the worker; no migration, no new env var.

- Every onboarding run of a tenant with an AD node on the canvas failed at the health check (`HealthCheckFailed`, "Critical: ad is unreachable"), the Entra ID provisioning of the same run included: AD was checked without its config. It is now checked on the AD node's canvas config, the one provisioning uses. An AD node without a config is left out of the run, as an Entra ID without one: the run's result ends with `Skipped ad: not configured.` and the person's timeline says so. A run started before the worker runs the new code behaves as before.

### Fixed: an impact simulation no longer changes a live or paused pipeline's status

Deploy the API; no migration, no new env var.

- A dry-run `POST /api/v1/blueprints/impact-analysis` set the pipeline status to `SIMULATED` whatever it was. A `DEPLOYED` pipeline then refused HR joiners and joiner batch approvals until someone deployed again, and the circuit breaker stopped watching it; a `PAUSED` one (by an operator or the circuit breaker) provisioned again. Now `GET /api/v1/blueprints/pipeline-status` keeps `DEPLOYED` or `PAUSED` after a simulation; `lastSimulationAt` and `lastSimulationRisk` are recorded for every status. `DRAFT` and `STOPPED` become `SIMULATED` as before (a stopped pipeline goes back to Deploy this way).

### Fixed: the batch provisioning test endpoints bound their numbers

Deploy the API; no migration, no new env var.

- `POST /api/v1/batch-provision/entra` (operator) took any `batchSize`: `-1` made the bulk workflow loop without end (an empty batch and a pause per round) until Temporal's history limit. It must now be a whole number from 1 to 1000 (400 otherwise). `continueOnError` as the string `"false"` was read as true; it is false now, and a value other than true or false is 400.
- `POST /api/v1/batch-provision/seed` took any `count`; it must be a whole number from 1 to 10000.

### Fixed: a bulk DISABLE or DELETE writes no Golden Record from its body

Deploy the worker; no migration, no new env var.

- `POST /api/v1/bulk-provisioning/start` saved every operation's `user` to the Identity Hub first, a DISABLE or DELETE included: the identity was minted from the body or overwritten with it (its status too, for example `ACTIVE`), and `identity.created` was emitted for a minted one. A DISABLE or DELETE now changes only the target account; its result carries no `hubWrite`, so the rollback has no Golden Record to undo for it. CREATE and UPDATE are unchanged. A run started before the worker runs the new code keeps the old behaviour.

### Fixed: a bulk rollback undoes only what the batch changed

Deploy the worker; no migration, no new env var.

- A bulk DISABLE took no state before it, and its rollback enabled every account it had touched, also one disabled before the batch (a leaver, a security hold). An Entra account disabled before is now left as it is and reported `skipped`, and the rollback leaves it disabled.
- An Entra CREATE or UPDATE whose license or group step failed after the account was made or changed came back failed without its snapshot, so the rollback skipped it: the account stayed while the Golden Record write was undone. Such a result now keeps the snapshot and is undone like a successful one (a failed CREATE's account is looked up by email and disabled; "no account was created" when there is none). The bulk results show these as rolled back.

### Changed: bulk deletes wait for approval unless turned off, and the approval checks its batch

Deploy the API; no migration, no new env var.

- `POST /api/v1/bulk-provisioning/start` left `requireApprovalForDeletes` unset when the body did not send it, so an API caller deleted with no approval (the UI sends `true`). It now defaults to `true`; send `false` to run deletes without the gate.
- The batch's initiator was recorded as `admin` for a principal without an email (a service client), so the segregation of duties check could not tell it from its approver; it is recorded by its id now. `POST /api/v1/bulk-provisioning/approve-deletes/:workflowId` refuses (403) the initiator also in another case or by that id, and answers 409 when the batch is not waiting for delete approval (not at its deletes yet, or finished) instead of signalling it anyway (a finished batch answered 500).

### Fixed: SCIM inbound refuses a malformed email, and pages a large `count`

Deploy the API; no migration, no new env var.

- `POST`, `PUT` and `PATCH /scim/v2/Users` stored `emails[].value` (and a `userName` used as the email) without a format check, so a malformed address reached the target connectors. One that is no email address now answers 400 `invalidValue` and nothing changes. A valid one is stored lower-cased, as every identity email.
- `GET /scim/v2/Users?count=` above 100 answered 500 (a validation error the SCIM filter did not map). It now returns at most 100 resources, as RFC 7644 lets a server do, and a request value the route refuses (a `count` that is no number) answers 400 `invalidValue`.

### Fixed: revoking an unknown SCIM token answers 404

Deploy the API; no migration, no new env var.

- `DELETE /api/v1/scim-tokens/:id` answered 204 for an id the tenant has no token for, though the route documents 404, so a script that revoked a wrong id was told it succeeded. It answers 404 "SCIM token not found".

### Fixed: national IDs stored before a rule named their key are removed when it is saved

Deploy the API; no migration, no new env var.

- Correlation removes the Hashed National ID rule's field from every record it receives, but values HR delivered under that key before the rule named it (a rule added, or its field changed, after migration `20261125000000-strip-raw-national-id` ran) stayed raw in the identities' sources, profile and access baseline. `POST /api/v1/blueprints/save` with a rule whose field is new now removes them for the tenant in the background and sets the hash of each identity's value as its `correlationId` (one another identity has is logged, not set). The response is unchanged; the API log line `[national-id cleanup]` gives the counts.
- `PATCH /api/v1/identity/:id?syncToEntra=true` handed the run it starts (`identity.move_requested`) previous values it read from the stored profile, which could hold such a raw value; it now hands the values `identity.updated` reported, without national IDs, and the fields that update reported.

### Fixed: an open correlation conflict is not replaced by another record

Deploy the API and worker; no migration, no new env var.

- A second low-confidence or held record on an identity replaced its open conflict in `GET /api/v1/identity/conflicts`: the first held record was lost until its next sync, the identity minted for the first record was no longer named (`conflictDetails.incomingIdentityId`), two held records alternated at every sync, and each sync of a held record emitted `correlation.conflict` again. An identity now holds one open conflict at a time: another record leaves it as it is (a held one waits for its next sync after the review, a minted one is in the uncorrelated queue), and the same record syncing again refreshes the held record and its snapshot without a new event.

### Fixed: an identity is deleted once

Deploy the API and worker; no migration, no new env var.

- Soft-deleting an identity (offboarding's last step, or closing the last failed target by hand) found it whether or not it was already deleted, so a retried activity or a second close moved `deletedAt` later, replaced `deletedBy` and emitted `identity.deleted` again (a second audit and timeline entry). `deletedAt` is what rehire detection compares the HR start date with. The first deletion now stands and is reported once.

### Fixed: `GET /identity?filter=` filters by the bare keys it allows

Deploy the API; no migration, no new env var.

- `GET /api/v1/identity?filter=` allowed the keys `email`, `status`, `firstName`, `departmentName` and the others without `profile.`, but applied them to the document root, where no profile field is, so `{"status":"ACTIVE"}` returned nothing; a list value matched only an identical stored array. A bare key now filters by its profile field (`status` as `profile.status`), a list matches any of its values, and an email is compared lower-cased as stored. `$` operators are still refused (400).

### Fixed: HR source tags and the source priority are compared without case

Deploy the API and worker; no migration, no new env var.

- The reconciliation config (`PUT /api/v1/admin/reconciliation-config`, Admin > Reconciliation config) stored `hrSourceTags` and `sourcePriorityOrder` as typed, while every consumer compares them with lower-cased source names. A tag typed `Workday` matched no source, so that HR source was treated as a target (it only filled empty fields) and the primary-HR and contract-critical rules broke without a message. Both lists are now stored trimmed and lower-cased (the response shows them so), and a config saved before is read lower-cased.

### Fixed: profile writes stop when the correlation settings cannot be read

Deploy the API and worker; no migration, no new env var.

- When the Brain config (the blueprint's correlation settings) could not be read, a target system's write-back, `PATCH /api/v1/identity/v2/:id/controls`, Merge (`POST /api/v1/identity/:id/resolve-conflict`) and Link (`POST /api/v1/identity/:id/link`) reconciled with the default settings, which have no field mastery overrides, and stored the profile so. They now answer 503 "The correlation settings could not be read: nothing was stored. Try again." before writing anything (an activity is retried). `GET /api/v1/identity/:id/mastery` and `PATCH /api/v1/identity/:id`, whose HR-mastery 409 depends on the overrides, answer the same 503.

### Fixed: the email override is checked, and the kill switch and the override are audited

Deploy the API and worker; no migration, no new env var.

- `PATCH /api/v1/identity/v2/:id/controls` took any string as `overrides.email`, stored it, and then failed (500) when reconcile gave the profile an email another live identity has; the override stayed stored, so every later HR sync, merge or controls change of that identity failed until someone removed it. The override must now be an email (400 otherwise), is stored trimmed and lower-cased, and `""` or `null` removes it. An address another live identity has answers 409 and nothing changes. The controls and the profile they reconcile to are saved together, so a refused profile leaves the controls as they were.
- Turning the kill switch (`isLoginDisabled`) on or off and setting or removing the email override were not audited. They are now: `IDENTITY_LOGIN_DISABLED`, `IDENTITY_LOGIN_ENABLED`, `IDENTITY_EMAIL_OVERRIDE_SET` and `IDENTITY_EMAIL_OVERRIDE_REMOVED`, the admin as actor (`offboarding-workflow` when an incomplete offboarding suspends the identity), the address masked. A request that leaves them as they were writes no entry.

### Fixed: turning the kill switch off gives a non-HR identity its status back

Deploy the API and worker; no migration, no new env var.

- `PATCH /api/v1/identity/v2/:id/controls` with `isLoginDisabled: false` left an identity without an HR source (created by hand, SCIM inbound) SUSPENDED, since a target source only fills the status; onboarding then skipped it. The kill switch now keeps the status it replaced (`metadata.statusUnderKillSwitch`), and turning it off restores that status (an HR source still overwrites it). An identity whose login was disabled before this release has no kept status and stays SUSPENDED when the switch is turned off: set its status with `PATCH /api/v1/identity/:id`.

### Fixed: `contracts` in `PATCH /identity/:id` pass the HR-mastery check

Deploy the API; no migration, no new env var.

- The profile stores no contracts: a PATCH body's `contracts` only set the job title and department of the primary contract, after the HR-mastery check, which saw only the key `contracts`. So `{"contracts":[{"title":"X","department":"Y","isPrimary":true,...}]}` rewrote an HR-mastered title and department without the 409, and `identity.updated` named `contracts`, so the mover did not see the move. The primary contract's `jobTitle`, `departmentCode` and `departmentName` now stand in for `contracts`: an HR-mastered one answers 409 as a direct edit does, and `identity.updated` names the fields that changed.

### Fixed: `POST /identity` cannot write as an HR source

Deploy the API and the frontend; no migration, no new env var.

- `POST /api/v1/identity` (operator) took `sourceSystem` and `sourceUserId` from the body as they came. With an HR source's name (`csv-hr`) and an employee's HR id, it overwrote that employee's HR record, which reconcile then applied as HR (overwrite rule, primary contract), past the HR-mastery 409 that `PATCH /identity/:id` and SCIM give. A `sourceSystem` that is an HR source of the tenant (its HR source tags, an HR connector or a Design Studio source node) now answers 400 naming it, and nothing is created. The Create user form's Source System help says so.

### Fixed: `POST /identity` and `PATCH /identity/:id` answer refusals with their status

Deploy the API; no migration, no new env var.

- `POST /api/v1/identity` answered every error with 500 "Operation failed". It now keeps the status of a refusal: 409 for a record held for a correlation conflict review (the message names the identity), 400 for the source limit, 503 when the correlation settings cannot be read (nothing stored, try again), and 409 "Another identity has this email" when a unique index refuses the write. Only an unexpected error is still 500.
- `PATCH /api/v1/identity/:id` with an email another live identity has answered 500 (duplicate key); it answers 409 with the same message, and nothing changes. SCIM `PUT` and `PATCH` answer it 409 `uniqueness` as before.

### Changed: identity emails are stored lower-cased and compared without case

Deploy the API and worker; migration `20261125000003-identity-email-lowercase` (`docs/DEPLOYMENT.md`, Upgrading to the 2026-11-25 release, item 11). No new env var.

- Identity email matching compared the stored value exactly, so HR's `jane.doe@x.fi` and the IdP's `Jane.Doe@x.fi` became two identities, and the unique email index let both in. Every write now stores the email trimmed and lower-cased: `POST /api/v1/identity`, `PATCH /api/v1/identity/:id`, HR ingest, SCIM inbound, bulk provisioning and every other Hub write. Responses show the stored form, so a client that sent `Jane.Doe@X.fi` reads back `jane.doe@x.fi`. Correlation by email, the held-row check and `GET /api/v1/identity/v2/by-email` find an address in any case.
- Two live identities stored before with one address in different cases are listed in `GET /api/v1/identity/conflicts` (`conflictDetails.matchedBy: "email"`, `confidence: 0`, `incomingIdentityId` the other one) for a Merge.

### Fixed: SCIM inbound PATCH, create and error answers

Deploy the API; no migration, no new env var.

- `PATCH /scim/v2/Users/:id` sent the whole stored record back as the update, so every PATCH wrote and reported every profile field as changed (`identity.updated`), and `remove` changed nothing. A PATCH now changes only the attributes its operations name: `remove` clears an optional attribute (`title`, `displayName`, the enterprise `department` or `employeeNumber`), and removing `userName`, `emails`, `name.givenName`, `name.familyName` or `active` is 400 with `scimType: "mutability"`. An `add` on `emails` takes the primary email, as `replace` does.
- `POST /scim/v2/Users` checked only that no identity had the `userName` as its email, but stores the primary email (else the userName) as the email and the userName as the UPN. A body whose email belonged to another identity was correlated into it and answered 201. It now answers 409 `uniqueness` when another identity has the userName (as UPN or email) or the email, compared without case.
- A duplicate email on `PUT` or `PATCH` (a unique index) answered 500; SCIM routes now answer it 409 `uniqueness` without the value. An id that is no ObjectId on `/scim/v2/Users/:id` or `/scim/v2/Groups/:id` answered 500 and now answers 404. A 404 carries no `scimType` (it was `invalidValue`).
- `DELETE /api/v1/scim-tokens/:id` answers 400 for an id that is not 24 hexadecimal characters (it answered 500).

### Fixed (security): JSON API HR reads its feed with GET only

Deploy the API and worker; no migration, no new env var.

- The health check already refused a JSON API HR `method` other than GET, but ingest and the periodic probe sent a stored `method` as it was, so a config saved through the API could make every scheduled sync send PUT, PATCH or DELETE to the HR system with its credentials. Ingest and the probe now refuse any method but GET (any case, or none) before a request is made, and `POST /api/v1/connectors/json-api-hr/install` and `PATCH /api/v1/connectors/json-api-hr` answer 400 to such a config. A stored config with another method fails its syncs until the method is removed or set to GET.

### Changed: a failed scheduled sync shows a generic `lastSyncError`

Deploy the API and worker; no migration, no new env var.

- `GET /api/v1/connectors` (viewer) and `GET /api/v1/connectors/:name/sync-status` showed the raw error of a failed scheduled sync as `lastSyncError`, which can carry a server path or part of the HR feed. A scheduled ingest now stores "Data synchronization failed", as the manual ingest already did, and a scheduled entitlement discovery "Entitlement discovery failed". The API and worker logs keep the reason. Values stored before stay until the next sync.

### Fixed: connector audit entries name the signed-in user

Deploy the API; no migration, no new env var.

- `POST /api/v1/connectors/:name/install` took the audit actor of `CONNECTOR_INSTALLED` (and the stored `installedBy`) from the body's `installedBy` when one was sent, so a connector-admin could name anyone as the installer. The field is no longer read (a body that sends it is accepted, the value ignored); the installer is the signed-in user.
- `DELETE /api/v1/connectors/:name` (`CONNECTOR_REMOVED`) and `PATCH /api/v1/connectors/:name` (`CONFIG_CHANGED`) were audited with the actor `admin`; they now name the signed-in user.

### Fixed (security): the File outbound connector writes only inside its directory

Deploy the API and worker. **New env var `FILE_OUTBOUND_ALLOWED_DIR`**, required in production wherever the connector is used (`docs/DEPLOYMENT.md`, Upgrading to the 2026-11-25 release, item 10).

- `outputFilePath` was any path, so a tenant's connector-admin could make the worker append user data to any file it can write and the health check created directories anywhere. The path must now be inside `FILE_OUTBOUND_ALLOWED_DIR` (relative paths resolve against it; the working directory outside production), checked on the real path with symlinks resolved. A path outside fails provisioning with 400 "The output file path is outside the allowed directory (FILE_OUTBOUND_ALLOWED_DIR)" and the health check answers unhealthy; neither names a server path.

### Fixed: Okta provisioning finds an existing user, and admin accounts start STAGED

Deploy the worker; no migration, no new env var.

- Okta answers a create whose login another user holds with `400 E0000001` ("An object with this field already exists"), not 409, so a retried provision threw on its own user and onboarding kept failing. That answer now updates the existing user, as a 409 did; another validation error still fails.
- The connector's default group (`defaultGroupId`) is also added to a user that already existed, so a retry after a first attempt that created the user still puts it in the group.
- A linked admin account (PAM) is created `STAGED` instead of activated: before, it became `ACTIVE` outside any privileged session as soon as its owner finished Okta's activation. Its first session activates it (Okta emails the owner the activation link); later sessions unsuspend it. Regular joiners are created activated as before. Okta admin accounts created before this release keep their status.

### Fixed (security): the SCIM connector follows no redirect

Deploy the worker and the API; no migration, no new env var.

- The SCIM target connector used plain axios: a SCIM server or OAuth token URL that answered 302 sent the request on to any address, a private or cloud metadata one included, and a 307 or 308 from the token URL sent the client secret along. SCIM calls and the token request now follow no redirect, use no proxy from the environment and connect only to addresses the SSRF guard allows (checked at connect, so a DNS answer that changed is refused). A redirect answer fails the call with 400 naming the status: set the base URL or token URL to the final address.

### Fixed: a rolled-back distributed CREATE deletes the account it created

Deploy the API and worker; no migration, no new env var.

- A distributed transaction's CREATE makes the Entra ID account under the UPN EuroID picks, which is not the email when the email is outside the default domain or its UPN is taken. The rollback deleted by the email, found nothing and still reported the system `ROLLED_BACK`, leaving the account. The commit now keeps the account's object id (`systems["entra-id"].createdAccountId` in the result) and the rollback deletes by it. A transaction committed before this release is rolled back by the email as before, and an account not found that way is now `ROLLBACK_FAILED` (dead-letter entry), never `ROLLED_BACK`.

### Changed (security): the AD health check names no address

Deploy the API; no migration, no new env var.

- `POST /api/v1/connectors/ad/health-check` answered a failed check with the raw error, such as "Connector: Host dc.corp resolves to blocked IP 10.1.2.3" or the directory's LDAP diagnostics, so an operator could map internal names to addresses with the form's host field. `error` is now one of two messages: "The directory refused the service account sign-in: check the service account and password", or "Could not connect to the directory: check the host, port and LDAPS setting (EuroID connects only to public addresses)". The API log keeps the reason.

### Fixed (security): SCIM token scopes are enforced

Deploy the API; no migration, no new env var. Tokens keep their stored scopes: one created with all four (the default) works as before.

- A SCIM token's `scopes` were stored and never checked, so a token minted with `Users:read` could create, change and delete users and groups. Each SCIM route now needs its scope: `Users:read` for `GET /scim/v2/Users[/:id]`, `Users:write` for `POST`, `PUT`, `PATCH` and `DELETE` there, and `Groups:read` and `Groups:write` on `/scim/v2/Groups`. A token without it gets `403` in SCIM's error format, naming the scope.
- `POST /api/v1/scim-tokens` answers `400` to a scope other than `Users:read`, `Users:write`, `Groups:read` and `Groups:write` (compared exactly).

### Fixed: `GET /scim/v2/Users?filter=` finds the users it names

Deploy the API; no migration, no new env var.

- The filter compared `userName`, `emails.value`, `displayName` and `active` with fields an identity does not have at its top level, so `userName eq "..."` found no one, `co` and `sw` found no one and `ne` found everyone. An IdP that looks a user up before creating it then got a 409 on the create. A filter now matches the attribute as the SCIM response shows it: `userName` is the UPN, else the email; `emails.value` the email; `displayName` the stored display name; `active` is true for `ACTIVE` and `PENDING`. `eq`, `ne`, `co` and `sw` on text compare without case (RFC 7643, `caseExact: false`). `active` takes only `eq` or `ne` with `true` or `false` (400 `invalidFilter` otherwise).

### Fixed: smaller sign-in and platform points

Deploy the API; no migration. New optional env var `TRUST_PROXY` (default `1`, the behaviour so far).

- `POST /api/v1/auth/login` applied the password policy to the password it checks, so an account whose password predates the policy answered `400` and could not sign in. The sign-in now takes any password of 1 to 128 characters and answers `401` "Invalid credentials" to a wrong one; the policy applies when a password is set.
- Route ids checked as ObjectIds (`/auth/users/:id`, `/auth/revoke/:userId` and the other routes with `ParseObjectIdPipe`) accepted any 12-character string, which matches nothing; they now answer `400` unless the id is 24 hexadecimal characters.
- `GET /metrics` compares the `METRICS_TOKEN` bearer token in constant time.
- Express's `trust proxy` was always one hop, so without a reverse proxy in front a client could choose the address the IP rate limits count with `X-Forwarded-For`. `TRUST_PROXY` sets it: `false` (or `0`) for an API reached directly, a hop count, or a list of proxy addresses.
- The in-process security state store (no `REDIS_URL`) now drops expired counters as it writes, instead of keeping every counter of past windows.

### Fixed: `/tenants` and `/scim-tokens` run the token check once per request

Deploy the API; no migration, no new env var.

- Both controllers declared `JwtAuthGuard` and `RolesGuard` again on top of the global guards, so each request checked the token twice: a break-glass (`X-Emergency-Token`) request wrote two critical `EMERGENCY_ACCESS` audit entries and read the database twice. The global guards alone check them now; who may call them is unchanged (platform admin for `/tenants`, super-admin for `/scim-tokens`).

### Fixed (security): a SAML response signs in once, and only in answer to EuroID's own request

Deploy the API; no migration. New optional env var `SAML_VALIDATE_IN_RESPONSE_TO` (`always` by default, or `ifPresent`).

- `POST /api/v1/auth/saml/callback` checked no `InResponseTo` and kept no assertion ids, so a captured SAMLResponse could be posted again until its `NotOnOrAfter` to get a session, and an unsolicited response could sign a victim in as someone else (login CSRF). Now a response must answer an AuthnRequest this deployment sent within 15 minutes (the request ids are kept in the shared security state store), an assertion older than 10 minutes is refused, and each assertion signs in once. A refused response redirects to the sign-in page with the usual error. Sign-ins started from the identity provider (IdP-initiated) are refused unless `SAML_VALIDATE_IN_RESPONSE_TO=ifPresent`; then the assertion check alone stops a replay.
- The callback's rate limit was counted per API instance; it is now counted across instances, like `POST /api/v1/auth/login`, and answers `503` while the security state store is unavailable.

### Fixed: deactivating the last active super-admin is refused

Deploy the API; no migration, no new env var.

- `PATCH /api/v1/auth/users/:id` with `{ "isActive": false }` had no last-super-admin check (only a role change had one, though the route's `409` promised it for both): two super-admins deactivating each other at the same moment, or an OIDC super-admin or the break-glass token deactivating the only active one, left the tenant with none. It now answers `409` "This is the last active super-admin of the tenant. Make another admin a super-admin first." and leaves the admin active. Of two simultaneous deactivations at least one is put back; that admin's sessions have ended and it signs in again.

### Fixed (security): password sign-in locks an account after repeated failures

Deploy the API; no migration. New optional env vars `LOGIN_MAX_FAILURES_PER_ACCOUNT` (default 10) and `LOGIN_LOCKOUT_MINUTES` (default 15).

- `POST /api/v1/auth/login` was throttled per client IP only, so guesses spread over many addresses had no limit per account. After `LOGIN_MAX_FAILURES_PER_ACCOUNT` attempts without a correct password within `LOGIN_LOCKOUT_MINUTES`, the address now answers `429` "Too many failed sign-ins for this account. Try again later." until the window ends, the correct password included. An unknown address is counted and answered the same way, so the lockout tells nothing about which accounts exist. A correct password clears the count. While the security state store is unavailable the route answers `503`, as for the IP throttle.
- Anyone who knows an admin's address can keep that admin locked out of password sign-in for the window; SAML sign-in and existing sessions are not affected.

### Changed: staging, pre-prod and an unset NODE_ENV get the production rules

Deploy the API; no migration, no new env var. Check `NODE_ENV` of every non-production environment before the deploy (`docs/DEPLOYMENT.md`, Before the deploy, "Check the auth settings").

- Several checks compared `NODE_ENV` with `production` exactly, so `staging`, `pre-prod` and an unset `NODE_ENV` kept development behaviour: unsigned SAML assertions allowed (`SAML_WANT_ASSERTIONS_SIGNED=false`), SAML users created by default, auth cookies without `secure`, Swagger UI served unauthenticated at `/api/docs` (and `swagger-spec.json` written at start), `/metrics` open without `METRICS_TOKEN`, and a short or placeholder `JWT_SECRET` only logged. One allow-list (`isDevOrTest()`, `development` and `test`) now decides all of them, and the dev tools routes and the first-admin setup without `SETUP_TOKEN` (entries above).
- With `AUTH_DISABLED=true` the API refused to start in `production`, `staging` and `pre-prod` only, and an unset `NODE_ENV` counted as `development` for that check while the guard read it as production (`AUTH_DISABLED` silently did nothing). Now it refuses to start unless `NODE_ENV` is `development` or `test`. The SAML error message reads "SAML_WANT_ASSERTIONS_SIGNED cannot be false outside development and test".

### Changed: tenant settings are validated and merged, and the tenant data migration previews first

Deploy the API; no migration, no new env var. Platform admin routes only.

- `PATCH /api/v1/tenants/:id` replaced `settings` wholesale and took any value: a PATCH of `{ "settings": { "retentionDays": 30 } }` erased `mfaRequired`, and `"mfaRequired": "false"` (a string) turned MFA on. Settings are now merged key by key; a key sent as `null` is removed. Each known key has its type (`maxIdentities` and `retentionDays` positive whole numbers, `allowedConnectors` strings, `features` booleans by name, `mfaRequired` a boolean); a wrong type answers `400`, unknown keys are dropped. `name` must not be empty.
- `POST /api/v1/tenants` refuses a `tenantId` that is empty or holds anything but letters, digits, `.`, `_` and `-` (1 to 64, starting with a letter or digit) with `400`; `name` must not be empty.
- `POST /api/v1/tenants/migrate` moved every document without a tenant or tagged `default` into the target, `audit_events` included, without checking the target. `default` is also the real tenant of a deployment that leaves `DEFAULT_TENANT_ID` unset, so its live data and its audit chain moved to the target, and the move could not be undone. Now the target must be an existing tenant (`404` otherwise); the body takes `dryRun`, which defaults to `true` and answers the counts per collection without moving anything (`{ dryRun, targetTenantId, collections }`; it answered the moved counts as a flat object before); `audit_events` never moves; documents tagged `default` move only while `default` is not a tenant in `tenants`, not `DEFAULT_TENANT_ID` and not the target.

### Fixed (security): an MFA code works once, and parallel guesses get no extra tries

Deploy the API; no migration, no new env var.

- The MFA failure counter and the break-glass failure counter were read and then written, so a burst of parallel `POST /api/v1/auth/mfa/challenge` calls (or `X-Emergency-Token` guesses) all passed the 5-attempt limit before any was counted. Every MFA code check now takes its attempt first, atomically: of a burst, 5 codes are checked and the rest answer `429` "Too many MFA attempts. Try again later." The break-glass failures are counted atomically too. Counters written before the upgrade are not read again; they expire within 15 minutes.
- A TOTP code was accepted again within its 90-second window. Now a code whose 30-second step (or a later one) was already used answers as a wrong code; the code that set MFA up counts as used. A backup code presented by two requests at the same moment was accepted by both; now only one.
- New backup codes (`POST /api/v1/auth/mfa/verify-setup`, `POST /api/v1/auth/mfa/backup-codes`) have 10 characters of `A-Z` and `2-7` (50 bits; the old 8 characters had about 41, unevenly spread). Backup codes are accepted in lower case too. Codes issued before keep working until used or regenerated.

### Fixed (security): first-admin setup needs SETUP_TOKEN outside development, and registration reveals no accounts

Deploy the API; no migration. `SETUP_TOKEN` is now required to create the first admin when `NODE_ENV` is not `development` or `test` (see `docs/DEPLOYMENT.md`, Upgrading to the 2026-11-25 release, Before the deploy, "Check the auth settings").

- With no admin yet and no `SETUP_TOKEN`, any caller of the public `POST /api/v1/auth/register` became `super-admin` of the deployment. Outside development and test it now answers `403` "Initial setup is disabled until SETUP_TOKEN is set on the server. Set SETUP_TOKEN, restart the API and register with it as the invite token." A set `SETUP_TOKEN` is compared in constant time.
- `POST /api/v1/auth/register` answered `409` "This email address already has an admin account" before it looked at the invite, so anyone could test which addresses have an admin account in any tenant. It now answers `403` without an invite, `401` for an unknown invite and `400` for an invite of another address first; the `409` is given only to the holder of a valid invite for that address.
- The first admin registered with an upper-case address (`Admin@Example.COM`) was created and then answered `409`; the address is now trimmed and lowercased at the gate, and the registration answers `201`.

### Fixed (security): a refresh token works once, also for simultaneous refreshes

Deploy the API; no migration, no new env var.

- Two `POST /api/v1/auth/refresh` calls with the same refresh token at the same moment (a stolen copy racing its owner) both got a new session. Now only one does; the other answers `401` "Invalid refresh token".
- An admin still has one refresh token: a sign-in on a second browser or device replaces the first one's, whose next refresh answers `401` (sign in again there). This is unchanged and now documented.

### Fixed (security): signing out ends the refresh token, and revoked sessions lose their websocket

Deploy the API; no migration. New optional env var `REALTIME_SESSION_RECHECK_MS` (default 60000).

- `POST /api/v1/auth/logout` only cleared the cookies, so a copy of the refresh token kept working for up to 7 days after the sign-out. It now also unsets the refresh token it is sent (the `refresh_token` cookie, or `{ "refresh_token": "..." }` in the body for API clients); a later `POST /api/v1/auth/refresh` with it answers `401`. The route stays public and answers `{ "success": true }` with or without a token. A token that is not the account's current one changes nothing.
- A websocket (`/events`) was authenticated only when it connected, so after `POST /api/v1/auth/revoke/:userId`, a password change or reset, a deactivation or a tenant suspension it kept receiving the tenant's events. Connected sockets are now checked again every `REALTIME_SESSION_RECHECK_MS` and disconnected when the session no longer passes.

### Fixed (security): an unreadable break-glass expiry no longer keeps the token valid forever

Deploy the API; no migration, no new env var.

- An `EMERGENCY_TOKEN_VALID_UNTIL` that is not a date (for example `31.12.2026`) made the expiry check compare with `NaN`, so `X-Emergency-Token` never expired. The API now refuses to start with such a value ("Auth config validation failed: EMERGENCY_TOKEN_VALID_UNTIL: must be an ISO 8601 date-time"), and the guard refuses the token with `401` "Emergency token has expired" if it meets one. An empty value still means no break-glass token works.

### Fixed (security): a suspended tenant can no longer sign in or call the API

Deploy the API; no migration. New optional env var `TENANT_STATUS_CACHE_MS` (default 30000).

- A tenant whose status is `suspended` or `deprovisioned` (`DELETE /api/v1/tenants/:id`, `PATCH /api/v1/tenants/:id` with `status`) was skipped only by the readiness probe and the scheduled jobs: its admins kept signing in, refreshing and calling the API. Now `POST /api/v1/auth/login`, `POST /api/v1/auth/mfa/challenge` and `POST /api/v1/auth/refresh` answer `403` "This tenant is suspended. Contact your platform administrator." after the credentials check, the SAML callback redirects to the sign-in error, and every authenticated request of the tenant answers the same `403`; a websocket connection is disconnected. A platform admin (`PLATFORM_ADMIN_USER_IDS`) and the break-glass token are not refused, so tenant management keeps working.
- The status is cached per API process for `TENANT_STATUS_CACHE_MS`: the instance that suspends applies it from the next request, other instances within that time. A tenant without a `tenants` document (a single-tenant deployment) is active.
- Webhooks: a tenant that is not active gets no deliveries. Its events are not sent and no delivery attempt is stored for them (nothing is sent for them after a reactivation either); the retry poller leaves its due retries waiting with their attempts unchanged, and sends them once the tenant is active again (attempts expire after 30 days); a dead-letter retry of its delivery fails ("The tenant ... is not active") and counts as a DLQ attempt.
- A database error while an access token was checked (the admin's revocation state, now also the tenant status) answered `401` "Invalid token", which signs the browser out; it now answers `503`.

### Changed: embedded documents no longer carry a tenantId

Deploy the API and the worker; migration `20261125000001-drop-embedded-tenant-id` (`docs/DEPLOYMENT.md`, Upgrading to the 2026-11-25 release, item 7). No new env var.

- Responses that return embedded documents no longer carry a `tenantId` inside them: an identity's `sources[]`, `controls`, `provisioning[]` and `linkedAdminAccounts[]` (where a route returns them, e.g. `GET /api/v1/identity/uncorrelated` and `GET /api/v1/identity/:id/dsar-export`), a credential policy's `passwordPolicy`, `rotationPolicy`, `targetScope` and `mfaRequirement` (`GET /api/v1/credential-lifecycle/policies`), a policy's `conditionGroups[]`, `conditions[]` and `actions[]`, and the other embedded documents of every collection. The tenant plugin stamped the request's tenant on them (all of them before 2ae3a960, identity sources, controls and provisioning entries until this release); the migration removes the stored values. A document's own `tenantId`, and an identity's `profile.tenantId` (declared by the profile, deprecated), stay.
- The single-key indexes on a nested tenantId (`sources.tenantId_1`, `passwordPolicy.tenantId_1` and the like) are dropped and no longer built; no query used them.

### Fixed (security): raw national IDs are no longer stored, and no fixed-key hashes are made

Deploy the API and the worker; migration `20261125000000-strip-raw-national-id` (run it with `CORRELATION_HMAC_SECRET` and the encryption settings set: it fails before any change without the secret while a tenant has a Hashed National ID rule; `docs/DEPLOYMENT.md`, Upgrading to the 2026-11-25 release, item 6).

- Identity reads (`GET /api/v1/identity`, `GET /api/v1/identity/:id` and the other routes that return an identity's `sources` or `profile`) no longer return the raw national ID in `sources[].rawData` or `profile.customAttributes`: correlation removes the tenant's Hashed National ID field (`nationalIdSourceField`, default `hetu`) and `hetu` from every incoming record and its `customAttributes`, also for a tenant without the rule, and the migration removes what was stored, held conflict rows (`metadata.conflictDetails.incomingSource`) included. Only `profile.correlationId` (the hash) is kept.
- Without `CORRELATION_HMAC_SECRET` (or with one under 16 characters) nothing is hashed: national ID correlation is off and the value is dropped unhashed. Before, a fixed key from the source code, the same for every tenant, was used, so a stored hash could be reversed.
- `POST /api/v1/blueprints/save` (policy-admin) answers 400 for a correlation config with a `hashedNationalId` rule while the server has no usable `CORRELATION_HMAC_SECRET`, naming `connectorConfigs.euroid-core.correlationConfig.rules.<i>.strategy`; nothing is saved.
- When the tenant's correlation settings cannot be read (a blueprint read failure), a record is no longer stored with the default email rule, which kept a custom national ID field raw: the write through identity correlation fails and stores nothing (`POST /api/v1/identity` answers its usual 500 "Operation failed"; onboarding and bulk provisioning activities are retried by Temporal), and an HR ingest run fails as a whole (manual `POST /api/v1/connectors/:name/ingest` answers `success: false`; a scheduled sync records `lastSyncStatus: failed` and runs again at its next slot).
- A `hashedNationalId` rule without `nationalIdSourceField` (possible through the API) reads `hetu` and now matches: before, the record's hash was never stored, so the rule found nothing. A `correlationId` an incoming record (POST `/api/v1/identity`, bulk provisioning) brings is ignored when the tenant has the rule.
- `PATCH /api/v1/identity/:id` and SCIM inbound (`PUT`, `PATCH /scim/v2/Users/:id`) no longer store the national ID a body carries in `customAttributes` (the tenant's Hashed National ID field and `hetu`), and `identity.updated` (audit log, analytics, websocket) no longer carries one, neither as a changed value nor as the previous value of `customAttributes`. With the rule and `CORRELATION_HMAC_SECRET` its hash becomes the identity's `correlationId`; `PATCH /api/v1/identity/:id` answers 409 "Another identity has this national ID…" when another identity of the tenant has that hash, and nothing is changed. Under the rule a `correlationId` in the body is ignored. A body whose only change was the national ID changes nothing (no timeline entry). When the correlation settings cannot be read, such an update answers 503 and changes nothing.
- `POST /api/v1/bulk-provisioning/start` (operator) removes each user's national ID (the tenant's Hashed National ID field and `hetu`, top level or in `customAttributes`) before the workflow starts, so the workflow input and its Temporal history hold none; with the rule and `CORRELATION_HMAC_SECRET` its hash goes in as the user's `correlationId`, which the Golden Record save matches on, and under the rule a `correlationId` in the body is dropped. A target mapping that read `customAttributes.hetu` from a bulk user finds nothing, as for every other path. When the correlation settings cannot be read it answers 503 and starts nothing (before: 500 for any start failure).
- A bulk provisioning rollback no longer writes back a raw national ID a Golden Record snapshot taken before the cleanup holds (profile, sources, held conflict row); the migration also removes those values from the stored snapshots (`rollback_snapshots`). When the correlation settings cannot be read, that rollback step is not done and the operation's rollback result says it failed and why.

### Added: offboarding a person also offboards their linked admin accounts

Deploy the worker (it runs the new workflow code and the new activity `getLinkedAdminIdentities`) and the API; no migration, no new env var. Runs started before the worker runs the new code leave admin accounts alone (`docs/DEPLOYMENT.md`, Upgrading to the 2026-11-25 release).

- Offboarding (`DELETE /api/v1/identity/:id`, HR leavers) offboards each live linked admin identity of the person first, each by its own offboarding run (`t-<tenant>-offboard-<adminId>`, readable by the tenant), one after another, then the person's own targets. An admin account whose offboarding fails or leaves a target failed counts as a failure of the person's offboarding: `status: partial-failure`, `hubStatus: suspended`, and the failure message names `linked admin identity <adminId>`.
- Offboarding results gain `linkedAdmins: [{ identityId, workflowId, outcome, reason? }]`, `outcome` one of `offboarded`, `failed`, `running-elsewhere` (an offboarding of that admin identity was already running; not waited for, and finished by the time the person was deleted). A person is never deleted while one of their admin identities is live: right before the delete they are read again, and one still live (its offboarding elsewhere had not finished, or it was linked meanwhile) is `failed` with a reason saying to rerun the person's offboarding, which leaves the person `partial-failure` / `suspended`. `linkedAdmins` is in `identity.offboarding_completed`, the stored offboarding record and the `offboarding` of `GET /api/v1/leavers/batches` and `GET /api/v1/leavers/open-offboardings`. Absent when the person had none, and on records from before.
- `GET /api/v1/leavers/open-offboardings` also lists an offboarding whose only failure is a linked admin account. `POST /api/v1/leavers/offboardings/:workflowId/removed-manually` no longer deletes the Golden Record when the closed target was the last failed one while a linked admin account of that offboarding failed (`offboardingComplete: false`): close the admin account's failed target on its own offboarding, then offboard the person again. It answers 409 (the target stays failed, the message names them) when closing the last failed target would delete a person with a live linked admin identity.
- The identity timeline's offboarding summary says what became of the linked admin accounts.

### Changed: PAM deactivation no longer marks an admin identity's provisioning DEPROVISIONED

Deploy the API and the worker; no migration, no new env var.

- `PUT /api/v1/privileged-access/admin-accounts/:adminId/deactivate` (and the hourly expiry sweep) sets the admin identity and the parent's `linkedAdminAccounts` entry `INACTIVE` and leaves the admin identity's `provisioning[]` entries as they are. Deactivation removes or disables nothing in a target system, so `GET /api/v1/identity/:id` of the admin identity keeps showing the accounts there (`SYNCED`). The code meant to mark them `DEPROVISIONED`; with Mongoose 9 the update stored them unchanged, so stored data does not change.
- Offboarding an admin identity (one with `parentIdentityId`) also removes the accounts of entries marked `DEPROVISIONED` without EuroID's own deprovision (`provisionedAt` not null), as a PAM deactivation would have left them, when the account id is stored (Entra ID object id, AD DN, SCIM id); an entry without one (deprovisioned before the marker existed) is left out, since its deprovision could never find the account. A failed removal of such an entry is reported without the "provisioning to this target never completed" note.

### Fixed: a deleted linked admin account no longer raises its person's risk score

Deploy the API and the worker; no migration, no new env var.

- The `admin_tier` factor of `GET /api/v1/risk-scores` and `GET /api/v1/risk-scores/:identityId` counted a person's `ACTIVE` linked admin account entries even when the admin identity was deleted (offboarded), so a TIER_0 entry kept adding 100 to the factor. Such entries no longer count; the next calculation corrects stored scores, no migration needed.
- Deleting an admin identity sets its entry on the parent (`linkedAdminAccounts[]`) `INACTIVE` with `deactivatedAt`; an entry already `INACTIVE` keeps its time.

### Fixed: `requireApprovalForDeletes` holds deletes and removals for a person, never disables

Deploy the worker (new workflow code behind patches); no migration, no new env var. Runs and orphan cleanups started before the worker runs the new code behave as before.

- `POST /api/v1/reconciliation/start-daily` (operator) with `requireApprovalForDeletes: true` (what **Run daily reconciliation** sends): the run no longer auto-corrects `GROUP_MISMATCH` or `LICENSE_MISMATCH` (their correction would remove a membership or a license). The drift stays open for `POST /api/v1/reconciliation/drifts/:id/correct` (or bulk). Disables are corrected as without the flag, since disabling is the reversible containment step: `ORPHANED_USER` and `STATUS_MISMATCH` against an identity that is not `ACTIVE`, so a leaver's account still enabled in a target is disabled at once. `MISSING_USER`, `FIELD_MISMATCH` and the enabling `STATUS_MISMATCH` are corrected as before. The setting was required and never read.
- The orphan cleanups such a run starts never delete an account on their own: after the extended grace the account stays disabled even with `ORPHAN_AUTO_DELETE_AFTER_EXTENDED=true`, until [Delete] (`POST /api/v1/reconciliation/orphans/:driftId/signal`). With `requireApprovalForDeletes: false` nothing changes.

### Added: drift thresholds alert in the report, as an event and by mail; notifySlack is refused

Deploy the API and the worker (new workflow code behind a patch, new activity `notifyDriftThresholdExceeded`); no migration, no new env var. Runs started before the worker runs the new code read no threshold.

- `POST /api/v1/reconciliation/start-daily` (operator): `maxDriftsBeforeAlert` and `criticalDriftAlertThreshold` (0 = off) are read. A run that gathered at least that many drifts, or that many CRITICAL drifts (counted per drift), names each threshold in the report's new `alerts: [{ threshold, limit, found }]` (`GET /api/v1/reconciliation/result/:workflowId`); without a threshold reached `alerts` is absent. Orphan accounts are not counted.
- `notifyOnDrift: true`: such a run emits the new event type `reconciliation.drift_threshold_exceeded` once, payload `{ workflowId, runId, totalDrifts, criticalDrifts, alerts }` (no identity, account or address). Webhook subscriptions can name it (Admin > Webhooks offers it, and `reconciliation.*`). `notifyOnDrift: false`: the report names the alerts and nothing is sent.
- `notifyEmail`: the address of a user of the tenant (an active admin user or an identity) gets one mail per run (`drift-threshold-exceeded`, counts and a link to the Reconciliation page) when SMTP is configured; an address nobody in the tenant has gets none.
- `notifySlack` answers 400 `Validation failed` with the message "Slack delivery is not available: subscribe a webhook to reconciliation.drift_threshold_exceeded instead (Admin > Webhooks)", and starts nothing. It was accepted and never read.

### Changed: a reconciliation run honours its scan scope; a schedule in the start body is refused

Deploy the API and the worker (new workflow code behind patches, a new argument on three activities); no migration, no new env var. Runs started before the worker runs the new code scan every identity.

- `POST /api/v1/reconciliation/start-daily` (operator): `includedDepartments` limits the run to identities whose `profile.departmentName` or `profile.departmentCode` equals an entry, ignoring case. `excludedUsers` (identity ids, or email addresses matched ignoring case) are never scanned or auto-corrected, and orphan detection leaves their accounts alone. Both were accepted and never read: every identity was scanned and corrected. An `excludedUsers` entry that is neither an identity id (24 hex characters) nor an email address answers 400 `Validation failed` with "An excludedUsers entry is an identity id (24 hex characters) or an email address", an empty `includedDepartments` entry answers 400, and nothing starts. Entries are trimmed. An empty list is no filter.
- `enabled` and `cronSchedule` are optional (they were required and never read: nothing schedules a run). A body with `cronSchedule` or `enabled: false` answers 400 `Validation failed` with "Reconciliation runs start on request: scheduled reconciliation is not available, so leave out cronSchedule and enabled: false", and starts nothing. **Run daily reconciliation** and `POST /api/v1/reconciliation/test/sample-daily` send neither.

### Fixed: the webhook form offers every event type webhooks receive

Deploy the frontend; no migration, no new env var. The API does not change.

- Admin > Webhooks (create and edit) now offers the eleven event types it left out, though `POST /api/v1/event-subscriptions` accepted them and they were delivered: `admin_user.password_reset_requested`, `admin_user.password_reset_issued`, `admin_user.password_reset_completed`, `connector.hr_sync_joiners_requested`, `identity.joiner_onboarding_started`, `identity.joiner_onboarding_waiting`, `joiner.batch_paused`, `joiner.batch_approved`, `joiner.batch_rejected`, `joiner.policy_updated` (a new `joiner` group with `joiner.*`) and `provisioning.deprovisioned`. None is kept from webhooks: a delivery carries ids only, so the password reset events carry the admin user's id and never a token or link. `webhook.*` and `dlq.*` stay out (never delivered).

### Fixed: the reconciliation report counts drifts per severity

Deploy the worker (the `generateReport` activity); no migration, no new env var. A report of a run that already finished keeps its figures.

- `GET /api/v1/reconciliation/result/:workflowId` (viewer): `criticalDrifts`, `highDrifts`, `mediumDrifts` and `lowDrifts` count drifts, each once, so the four add up to `totalDrifts` and `criticalDrifts` equals the `found` of a `criticalDriftAlertThreshold` alert. Before, they counted identities by their worst drift: one identity with two CRITICAL drifts was `criticalDrifts: 1` next to an alert that found 2. No frontend reads these fields.

### Fixed: the health check answers for the HR sources and the other connectors that declare one

Deploy the API; no migration, no new env var.

- `POST /api/v1/connectors/json-api-hr/health-check` and `.../csv-hr/health-check` (connector-admin, operator, policy-admin, super-admin) answered 400 "Health check not implemented". They now answer `{ healthy, connected, capabilities, message?, error? }`. JSON API HR: the field map and the auth settings, then one GET to the configured URL as ingest makes it (SSRF guard, configured auth, no redirect) and the body read as ingest reads it, no row mapped (a `method` other than GET in the body answers 400); `error` names the HTTP status (`The endpoint answered HTTP 401`), the network error (`The endpoint could not be reached (ECONNREFUSED)`), `The response is not JSON`, the guard's reason (`The URL is refused: ...`) or the setting, never a credential or the body. CSV HR: the column map, and that `filePath` is inside `CSV_HR_ALLOWED_DIR` (symlinks resolved), exists, can be read and is within `CSV_HR_MAX_FILE_SIZE_MB`; no `error` names a server path.
- CSV HR ingest (`POST /api/v1/connectors/csv-hr/ingest`, scheduled syncs) and the check resolve symlinks before the inside-the-directory check, so a symlink in `CSV_HR_ALLOWED_DIR` that leads outside is refused. A path outside answers "CsvHrConnector: The file path is outside the allowed directory (CSV_HR_ALLOWED_DIR)" (was "Path traversal denied. Resolved path \"<absolute path>\" is outside allowed directory \"<directory>\""), a missing file "CsvHrConnector: File not found: <filePath as configured>" (was the absolute path).
- The same route for `okta`, `servicenow`, `github`, `google-sheets`, `discord-webhook` and `file-outbound` also answered 400. It now runs the connector's own health check, the one `GET /api/v1/reconciliation/connector-health` runs, with the saved config: `{ healthy, connected, capabilities, error? }`, and with a `config` in the body `message: "Checked with the saved config: this connector does not test unsaved settings"`.
- A masked secret in the body's `config` (the placeholder `GET /api/v1/connectors` returns) is replaced by the stored secret only while the body's destination fields equal the saved config's (AD `host`, `port`, `useLdaps`, `serviceAccount`; Entra ID `tenantId`, `clientId`; SCIM `baseUrl`, `oauth2TokenUrl`, `username`, `clientId`; JSON API HR `url`; Okta `orgUrl`; ServiceNow `instanceUrl`, `clientId`, `username`). Otherwise the route answers 400 "Type <secret> again to test a changed <field>: a stored secret is only sent to the saved destination" and sends nothing. Before, an operator or policy-admin could have the API send the stored HR token, SCIM token or client secret, or the AD bind password, to any host. This also applied to AD, Entra ID, SCIM and Okta before this release. The AD Test Connection button shows the API's message.

### Fixed: the Scheduled Sync readiness check follows the HR sources' sync interval

Deploy the API; no migration, no new env var.

- `POST /api/v1/blueprints/readiness-check` (and the readiness run by `POST /api/v1/blueprints/deploy`): the "Scheduled Sync" check always warned "No scheduled sync (manual only)". It now reads the saved `syncIntervalHours` of each source node's connector, which the hourly sync scheduler follows: `pass` with each source's schedule (`CSV HR: every 24 h, JSON API HR: manual only`) when one is above 0, else `warn` "No scheduled sync (manual only): set a Sync Interval on an HR source". It is still never a `fail`.

---

### Changed: PAM activation enables the admin accounts for a session; deactivation and expiry disable them

Deploy the API and the worker together (new workflow `privilegedSessionWorkflow`; new activities on the default queue and on the Entra ID, AD, SCIM and Okta queues); no migration. New optional env vars `PAM_ACTIVATION_WAIT_MS` (default 15000) and `PAM_STANDING_STATE_SWEEP_LIMIT` (default 50). Admin accounts provisioned before this release are disabled by the hourly sweep (`docs/DEPLOYMENT.md`, Upgrading to the 2026-11-25 release).

- `PUT /api/v1/privileged-access/admin-accounts/:adminId/activate` (viewer: the parent; connector-admin, super-admin) starts a privileged session (`t-<tenant>-pam-session-<adminId>`) that enables the admin identity's accounts in Entra ID, AD and SCIM (Okta: unsuspend) for the tier's `PAM_TIER*_MAX_HOURS`, then disables them. It answers 200 `{ state: "ACTIVE", expiresAt }` once every account is enabled, 202 `{ state: "ACTIVATING" }` when that takes longer than `PAM_ACTIVATION_WAIT_MS`, 502 with the reason when an account could not be enabled (every account is disabled again), and 409 while a session of the admin account runs. Before, it answered 200 with no body and changed MongoDB only; a second activation of an ACTIVE account reset its expiry, now it is a 409.
- `PUT /api/v1/privileged-access/admin-accounts/:adminId/deactivate` ends the session (with none running, a run disables the accounts) and answers 200 `{ state: "INACTIVE" }` (`"PENDING"` for an account never active) or 202 `{ state: "DEACTIVATING" }`. Before, 200 with no body, MongoDB only.
- `GET /api/v1/privileged-access/admin-accounts`: `status` can be `ACTIVATING`; rows gain `expiresAt`, `activationError` (why the last activation failed) and `disableError` (why disabling failed; retried hourly). The entries of `GET /api/v1/privileged-access/:parentId/admin-accounts` gain `sessionId`, `activationError` and `disableError`, and `status` can be `ACTIVATING`.
- The entry shows `ACTIVE` only once the accounts are enabled. `admin_account.activated` is emitted then (actor `privileged-session-workflow`); `admin_account.deactivated` gains `reason` (`expired`, `deactivated`, `offboarded`, `standing-state`) and `disableFailed: true` when an account could not be disabled.
- The hourly expiry sweep ends each ACTIVE session past its `expiresAt`, and starts disable-only runs for live admin identities whose accounts may be enabled outside a session (new identity field `pamTargetState`, unset for accounts provisioned before this release), at most `PAM_STANDING_STATE_SWEEP_LIMIT` per tenant and hour.
- Offboarding a person or an admin identity tells the admin identities' running sessions to end before their accounts are removed; a deleted admin identity is never enabled.

### Changed: privileged admin accounts stand disabled in the target systems

Deploy the API and the worker; no migration, no new env var.

- Admin account provisioning (`adminAccountProvisioningWorkflow`, from onboarding) creates a linked admin identity's accounts disabled: Entra ID `accountEnabled: false`, AD `userAccountControl` 514, SCIM `active: false`. An update of an existing one (onboarding, the mover, a `syncToEntra` edit, reconciliation) writes the same: enabled only while the admin identity's profile is `ACTIVE`, which a privileged session sets once its accounts are enabled. Before, they were created and kept enabled (`PENDING` counted as enabled), with their privileged roles and groups. A linked admin identity is one with `employmentType: ADMIN_ACCOUNT` and `sourceSystem: euroid-pam`; every other identity keeps today's mapping (Entra ID and SCIM enabled for `ACTIVE` or `PENDING`, AD always 512).

### Fixed: admin account provisioning leaves an Entra ID without config out instead of failing onboarding

Deploy the worker (new workflow code behind the patch `admin-account-provisioning:entra-not-configured`); no migration, no new env var.

- Onboarding left an Entra ID with no config anywhere (canvas, installed connector, `ENTRA_*`) out of the person's own run, but its admin account provisioning child still called Entra ID, failed, and failed the person's onboarding before any of their own accounts was provisioned. The child now asks `isEntraConfigured` first and, without a config, provisions the admin account to the other targets only (no Entra ID provisioning entry). Not taken from the bug report's N8: skipping targets already SYNCED, because a re-run is how a changed admin entitlement reaches an existing admin account.

### Fixed: onboarding provisions every admin tier a person's policies grant

Deploy the worker (new workflow code behind the patch `onboarding:provision-every-admin-tier`); no migration, no new env var. Onboarding runs started before the worker runs the new code behave as before.

- Onboarding (HR joiners, `PUT /api/v1/identity/:id` with `syncToEntra`, the onboarding routes) starts one admin account provisioning child per admin tier among the policy intent's `adminOperations`, each creating that tier's admin identity and given only that tier's operations. Before, it started one child with the first operation's tier and every operation: a TIER_0 role could land on a TIER_2 admin account, and the other tiers got none. The children are named `admin-provision-<onboarding workflow id>-<identityId>-t<n>` (before: without the tier); an operation without a tier counts as TIER_1, as before. A person's second tier needs `{tier}` in `ADMIN_UPN_PATTERN` (see below), otherwise its child fails with that 409.

### Changed: admin account UPNs are ASCII, a namesake gets a suffix, `{tier}` gives one per tier

Deploy the API and the worker; no migration. New optional env var `ADMIN_UPN_MAX_SUFFIX` (default 20); `ADMIN_UPN_PATTERN` accepts `{tier}` (`docs/DEPLOYMENT.md`, Upgrading to the 2026-11-25 release). Existing admin identities keep their UPN.

- `POST /api/v1/privileged-access/:parentId/admin-accounts` (and admin account provisioning from onboarding): the admin UPN writes letters with diacritics as their ASCII base letter (`Mäkinen`: `makinen`) and drops characters Entra ID does not allow in a UPN's local part. Before, `adm-jöns.mäkinen@...` reached Entra ID as is.
- When another person's live identity holds the UPN (two people with the same name), the next numeric suffix is used (`adm-ada.lovelace2@...`) instead of answering 409, up to `ADMIN_UPN_MAX_SUFFIX`; 409 when none is free.
- `ADMIN_UPN_PATTERN` gains the placeholder `{tier}` (`t0`, `t1`, `t2`). The default pattern has none, so a person's second admin tier would get the UPN of their first: that answers 409 with a message naming `ADMIN_UPN_PATTERN` and `{tier}` (before: 409 "Admin identity <UPN> already exists"). No 409 message names an address any more.

### Fixed (security): the webhook subscription event no longer carries the webhook URL

Deploy the API; no migration, no new env var.

- The `webhook.subscription_created` event (sent on the websocket to every signed-in user of the tenant, viewers included, and stored in the audit log that `GET /api/v1/audit` returns to viewers) carried `webhookUrl`, the receiver's full URL, which can hold its token in the path, the query or the user info. It now carries `webhookHost` (the URL's host and port) instead: `{ subscriptionId, name, webhookHost }`. `webhook.subscription_deleted` carries `{ subscriptionId, name }` as before, and an update of a subscription emits no event.
- Audit entries written before this release keep the URL: the audit log is hash-chained and is not rewritten. If a webhook was registered with a URL that holds a token, rotate that token at the receiver and update the subscription's URL (`docs/DEPLOYMENT.md`, Upgrading to the 2026-11-25 release).

### Fixed (security): the dev tools routes exist only in development and test

Deploy the API; no migration, no new env var.

- `GET /api/v1/dev/workflows`, `GET /api/v1/dev/workflows/:workflowId`, `GET /api/v1/dev/transactions` and `GET /api/v1/dev/transactions/:txId` (viewer) answered `404` only when `NODE_ENV` was exactly `production`, so a staging or pre-prod deployment, or one with `NODE_ENV` unset, let any viewer read decrypted workflow inputs and activity outputs. They now answer `404` unless `NODE_ENV` is `development` or `test`.
- `GET /api/v1/dev/workflows` writes the caller's tenant id into the Temporal list query as an escaped string literal, so a tenant claim with a double quote (an OIDC token's `JWT_TENANT_CLAIM`) can no longer change the query and list other tenants' workflows.

### Fixed: the API connects to Temporal after starting while Temporal was down

Deploy the API; no migration. New optional env vars `TEMPORAL_RECONNECT_MIN_MS` (default 1000) and `TEMPORAL_RECONNECT_MAX_MS` (default 30000) (`docs/DEPLOYMENT.md`, Upgrading to the 2026-11-25 release).

- An API started while Temporal was unreachable answered every route that starts or signals a workflow (onboarding, offboarding, PAM activation and deactivation, access requests, reviews, bulk provisioning, reconciliation) with "Temporal is not connected ... restart the backend" until it was restarted, and the hourly PAM sweep and orphan signals failed the same way. Such a route now starts a new connection attempt and answers the same error with "try again shortly" until an attempt succeeds; the requests after it work. Attempts are made only on use and at most once per backoff delay, which doubles from `TEMPORAL_RECONNECT_MIN_MS` up to `TEMPORAL_RECONNECT_MAX_MS`.
### Fixed: a webhook is posted once per event, also when two processes handle the event

Deploy the API; migration `20261125000002-webhook-delivery-unique-per-event` (`docs/DEPLOYMENT.md`, Upgrading to the 2026-11-25 release, item 8). No new env var.

- A domain event handled by two processes at once (an outbox reclaim while the first publish still ran, a dead-letter replay) could record two delivery attempts for one subscription and post the webhook twice, with two `X-EuroID-Delivery` ids. The `webhook_delivery_attempts {subscriptionId, eventId}` index is now unique and inserting the attempt is the claim, so a subscription gets one delivery per event id. The migration removes existing duplicate attempts, keeping the delivered one (else the one being sent, else the oldest). The routes and the delivery body do not change; `GET /api/v1/event-subscriptions/:id/deliveries` no longer lists a second attempt of one event.

### Fixed: outbox events are retried with a backoff and published once by one process

Deploy the API and the worker; no migration. New optional env vars `OUTBOX_SWEEP_INTERVAL_MS` (default 15000) and `OUTBOX_RETRY_BASE_MS` (default 5000) (`docs/DEPLOYMENT.md`, Upgrading to the 2026-11-25 release).

- Domain events published through the outbox (`identity.created` from `POST /api/v1/identity` on a replica set) whose handler failed were tried again at once, five times within milliseconds, then dead-lettered. A failed publish is now tried again after 5, 10, 20 and 40 seconds (`OUTBOX_RETRY_BASE_MS` doubled), then dead-lettered as before.
- A handler slower than `OUTBOX_CLAIM_TIMEOUT_MS` let another API or worker process take the event and publish it again (a second audit attempt, webhook post or email). The publishing process now renews its claim while the handlers run.
- On a replica set an event whose publishing process stopped, or whose retry fell due, waited for the next unrelated outbox change; a sweep every `OUTBOX_SWEEP_INTERVAL_MS` now takes it.


### Fixed: the webhook delivery list refuses an offset or limit that is not a whole number in range

Deploy the API; no migration, no new env var.

- `GET /api/v1/event-subscriptions/:id/deliveries` (super-admin) passed a negative `offset` to MongoDB as a negative skip (a `500`), and read a `limit` or `offset` that was text or a fraction as the default without saying so. It now answers `400` `Validation failed` for an `offset` that is not a whole number from 0 to 10000 or a `limit` that is not a whole number from 1 to 100 (a `limit` above 100 was cut to 100 before), and reads nothing. The defaults stay `limit` 50 and `offset` 0. The Admin > Webhooks delivery history sends `limit` 21 and is not affected.

### Fixed: scheduled jobs survive a key rotation and follow changed cron variables

Deploy the worker; no migration, no new env var. Key rotation step 2 gains a check (`backend/src/infrastructure/secrets/docs/ARCHITECTURE.md`, Key Rotation).

- The worker created its Temporal schedules once and left an existing one as it was. The server keeps a schedule's action args as they were encoded at creation, so after a key rotation removed `ENCRYPTION_KEY_PREVIOUS` every scheduled run (entitlement expiry, recertification, risk scores, intelligence, audit archive, archival, credential rotation) failed to decrypt its input and stopped, and a changed `RECERTIFICATION_CRON`, `RISK_SCORE_CRON`, `INTELLIGENCE_BATCH_CRON`, `AUDIT_ARCHIVE_CRON`, `ARCHIVAL_CRON` or `CREDENTIAL_ROTATION_CRON` (or the archival settings in its args) never reached it. The worker now updates each existing schedule at start: the spec from the variables, the args encoded under the current key, the policies and a paused state kept. A schedule whose args no configured key decrypts is deleted and created again.

### Changed (security): the public readiness probe counts connectors and names none

Deploy the API; no migration. New optional env var `HEALTH_CONNECTOR_CACHE_MS` (default 15000; `docs/DEPLOYMENT.md`, Upgrading to the 2026-11-25 release).

- `GET /api/v1/health/ready` (public, no throttle) answered `components.connectors` keyed by connector name with each connector's `status` and `lastSync`, merged across every tenant, so an unauthenticated caller learned which connectors the tenants installed and when they last synced; it also ran a query per tenant on every call. It now answers counts: `components.connectors: { ok, stale, unknown, checkedAt }` (`stale`: the last sync failed or is older than 24 hours, which still makes the probe `degraded` with HTTP 200; `unknown`: never synced). The counts come from one query, are cached for `HEALTH_CONNECTOR_CACHE_MS`, and are shared by probes that arrive during a read; `checkedAt` says when they were read. A tenant's own connector state stays on the authenticated routes (`GET /api/v1/reconciliation/connector-health`, `GET /api/v1/connectors/:name/status`).
- Connectors of a tenant without a `tenants` document (a single-tenant deployment's `DEFAULT_TENANT_ID`) now count; a suspended or deprovisioned tenant's do not.
- With MongoDB down the probe read the connectors first, waited for the query to time out and answered a generic `500`. It now answers its `503` report at once, with `components.connectors.checkedAt: null`; a connector read that fails also answers `checkedAt: null` and is tried again on the next probe.

## [2026-11-25]

Release of 2026-11-25: audit hash chain and Merkle checkpoints, credential inventory, NHI credential verification, access graph and intelligence fixes, HR-mastery enforcement, Temporal payload encryption, and the browser-pass fixes. Upgrade steps: `docs/DEPLOYMENT.md`, "Upgrading to the 2026-11-25 release".

### Fixed: a stored status in another case no longer fails Link with 500

Deploy the API and the worker (both reconcile); no migration, no new env var.

- `POST /api/v1/identity/:id/link` (operator) answered 500 when reconcile rebuilt the profile from a source record whose `status` (or `employmentType`, `priority`) is not an enum value as stored, such as the demo seed's `"active"`: the save failed with "profile.status: 'active' is not a valid enum value". Reconcile, wherever it runs (link, ingest, merge), now takes a value written in another case or with spaces or hyphens for underscores as the value it names (`active` is `ACTIVE`, `full time` is `FULL_TIME`) and leaves out one that names none, keeping the profile's value and logging a warning. HR ingest validates each row, so its records hold enum values only.
- `npm run seed:demo` writes the HR records' `status` as `ACTIVE` or `TERMINATED`, as HR ingest stores it. A database seeded before keeps `"active"` and `"terminated"`; reconcile now reads them as `ACTIVE` and `TERMINATED`.

### Fixed: the readiness probe reports a lost Neo4j connection

Deploy the API and the worker; no migration, no new env var.

- `GET /api/v1/health/ready` reported `components.graph.status` `ok` whenever the process had a Neo4j driver, so after Neo4j stopped it stayed `ok` (overall `ok`) for 40 s and more while every access explorer view answered 503. Now the first graph call or connectivity check that cannot reach Neo4j (the driver's `ServiceUnavailable` or `SessionExpired`) makes it `not-connected` (overall `degraded`, HTTP 200) until a graph call reaches Neo4j again or a check succeeds. The probe starts a check at most once per `NEO4J_RECONNECT_INTERVAL_MS` (30 s by default), also while connected, so a loss shows without graph traffic within that interval; it never waits for Neo4j. A query error of another kind (a Cypher error) leaves the status as it was.

### Added: HR column and field maps through the API and the Design studio

Deploy the API and the frontend together; no migration, no new env var.

- `POST /api/v1/connectors/:name/install` and `PATCH /api/v1/connectors/:name` (connector-admin) take a CSV HR `config.columnMap` and a JSON API HR `config.fieldMap`: a JSON object as text (config values stay strings), source column or key → the field it fills. A wrong map answers 400 naming the entry, for example `config.columnMap: "Staff No" maps to "employeeNo", which is not a field the HR mapping fills`; nothing is saved. Accepted values: `sourceUserId`, `email`, `firstName`, `lastName`, `jobTitle`, `departmentName`, `employeeId`, `employeeNumber`, `employmentType`, `mobilePhone`, `location`, `startDate`, `endDate`, `hrStatus` and `customAttributes.<key>`; one entry must fill `email`. The map replaces the connector's default map; an empty value means the default. It is stored encrypted with the rest of the config, as compact JSON, and `GET /api/v1/connectors` returns it as stored.
- `GET /api/v1/connectors/available` lists the new fields with the config field type `json` (`validationFn: "hrFieldMap"`). Before, neither manifest had a map field and the connectors always used their default maps, which fill no `employeeNumber`, so the Brain's Employee Number correlation rule got no value from these sources.
- The Design studio's CSV HR and JSON API HR drawers have a Column Map and a Field Map text area.

### Fixed: a credential policy can be edited; subdocuments no longer carry tenantId

Deploy the API and the frontend; no migration, no new env var.

- **The tenant plugin stamps only the top-level document.** Registered globally, it also stamped `tenantId` on every embedded subdocument, so responses carried it inside objects such as a credential policy's `passwordPolicy` and `rotationPolicy`, or an identity's `profile` and `sources`. Documents written from now on have no `tenantId` inside their subdocuments. Documents stored before keep it, and the API still returns it for them; a client that sends such an object back must leave the key out.
- `PATCH /api/v1/credential-lifecycle/policies/:id` (policy-admin) refused the Credential lifecycle page's edit with 400 "passwordPolicy: Unrecognized key(s) in object: 'tenantId'" (and the same for `rotationPolicy`), because the page sent the stored settings object back. The page now sends only the settings the route accepts, so the edit also works for a policy stored before this release. The route itself is unchanged.
- A subdocument no longer needs a request context: a document that names its tenant itself saves from a poller with its subdocuments, as the dead-letter entry's `error` already did through its own opt-out.

### Fixed: a deleted identity's admin account cannot be activated

Deploy the API and the frontend; no migration, no new env var.

- `PUT /api/v1/privileged-access/admin-accounts/:adminId/activate` (viewer: the parent; connector-admin, super-admin) answers 404 for a soft-deleted admin identity and 409 "cannot be activated: its parent identity ... is deleted" when the parent identity is deleted or gone; nothing is written. Before, it answered 200 and set a deleted admin identity ACTIVE. Deactivation (`PUT .../deactivate`) still works on both, and the hourly expiry sweep still ends their sessions.
- `GET /api/v1/privileged-access/admin-accounts` (viewer) leaves soft-deleted admin identities out, and its rows gain `parentDeleted` (true when the parent identity is deleted or gone). The Privileged access page shows "Parent identity deleted" on such a row and offers no Activate.
- `GET /api/v1/privileged-access/:parentId/admin-accounts` (viewer) leaves out the entries of soft-deleted admin identities and answers 404 for a soft-deleted parent. `POST /api/v1/privileged-access/:parentId/admin-accounts` (operator) answers 404 for a soft-deleted parent and creates nothing. The OpenAPI spec gains the 404 and 409 descriptions.

### Fixed: the access graph keys rule-given access by the catalog's native id

Deploy the API and the worker together (both run the graph's event sync); no migration, no new env var. Where the graph was loaded before, a super-admin runs the resync once per tenant after the deploy (`POST /api/v1/access-explorer/resync`): it moves rule-given access to the catalog's nodes and removes the nodes keyed by a rule's target id. Until then, holders and paths of the catalog's node miss the rule-given access granted before the deploy, and so does an SoD policy that names such a group by display name.

- **A group a role-based rule names by display name is one entitlement in the graph.** The resync and completed provisioning linked rule-given access to an `Entitlement` node keyed by the rule's target id (`SG-Sales`), while the catalog's node and request-granted access use the native id (`guid-sales`): `GET /api/v1/access-explorer/entitlement/:id/holders` of the catalog's entitlement missed every holder who got it from the rule, and `/path` and `/identity/:id/sod-violations` missed that access. Now a rule's grant links to the entitlement catalog entry of its target on that system, found by native id, else as the only entry with a native id that has the target as its name, as access intelligence names it (below). A target the catalog does not know, or names more than once, keeps its own id as its node's id.
- **Ids a client sees change.** In `GET /api/v1/access-explorer/identity/:id/graph`, a rule-given entitlement's node `id` and the relationships' `targetId` are now its native id, and its label the catalog's name. The holders and path routes for a rule's target id (`/entitlement/SG-Sales/holders`) answer `entitlementFound: false` once the resync ran, when the catalog has that entitlement: use the native id, as the page's picker does. `POST /api/v1/access-explorer/resync` counts such an entitlement once in `entitlements`; its first run after the deploy counts the old nodes and edges in `removed`.
- **A rule may name the system as the policy engine does.** The catalog lookup compares systems by one key per system, so a rule whose target is `entra` or `entraid` finds the catalog's `entra-id` entries and `active-directory` its `ad` entries, as SoD policies and review exclusions already treat them. The same applies to the peer baseline below.
- **An SoD policy's entitlement is matched the same way** in `GET /api/v1/access-explorer/identity/:id/sod-violations`: a policy that names a group by display name (as `SodService` matches it against a rule) is checked on the catalog's node.
- `provisioning.completed` that removes access removes it from the catalog's node and from a node under the rule's target id (written before the catalog knew it). A node provisioning creates before discovery reaches the graph carries the catalog entry's name. The OpenAPI spec is unchanged.

### Changed: rule-given access in peer groups is named by the catalog's native id

Deploy the API, the worker and the frontend; no migration, no new env var. Stored peer groups keep the old names until the next intelligence batch (04:00 UTC by default); to rebuild at once: `temporal schedule trigger --schedule-id intelligence-batch-daily`. Until then the check answers as before.

- **A requestable group most peers get from a role-based rule is no longer CRITICAL to request.** The peer baseline named an entitlement a rule gives `target::targetId`, so a rule that names a group by display name gave `entra-id::SG-Sales`, while the access request form's check (`POST /api/v1/intelligence/unusual-check`, operator) and request-granted access name it `system::nativeId`: the check answered "No peers in your group have this access." (CRITICAL). Now a rule-given entitlement is named by its entitlement catalog entry: `system::nativeId` and the entry's name, the entry found by native id, else as the only entry with a native id that has the rule's target as its name on that system. A group held by rule and by request is one entitlement, held both ways (`grantedBy: ["policy", "request"]`). A target the catalog does not know, or names more than once, keeps `target::targetId`.
- This applies wherever the baseline's ids show: `entitlementBaseline` of `GET /api/v1/intelligence/peer-groups`, `uniqueEntitlements` and `missingBaseline` of the outliers, and `entitlementId` of `GET /api/v1/intelligence/recommendations/:identityId`. The Peer groups page names an outlier's entitlements by the group's baseline ("entra-id: SG-Sales"), not by native id.

### Changed: a reviewer's score names the bulk approval rule it was computed with

Deploy the worker (it scores) and the frontend; no migration.

- `GET /api/v1/intelligence/reviewer-quality` (super-admin) rows gain `bulkApproveWindowCount` and `bulkApproveWindowMinutes`: the score lost 20 points when that many approvals fell within that many minutes (`INTELLIGENCE_BULK_APPROVE_WINDOW_COUNT`, default 10, within 5 minutes). The Reviewer quality tab names the rule ("4 approvals within 5 min (−20)"); it said "10 approvals within 5 min" whatever the variable was. A score from before has neither field and shows 10 within 5 minutes, which it was scored with.

### Removed: INTELLIGENCE_BASELINE_HOLD_RATE

- The variable was read and used by nothing: neither the peer baselines nor the recommendations have a threshold it was meant for (they use `INTELLIGENCE_OUTLIER_HOLD_RATE`, `INTELLIGENCE_MISSING_BASELINE_RATE`, `INTELLIGENCE_RECOMMENDATION_HOLD_RATE` and `INTELLIGENCE_UNUSUAL_REQUEST_THRESHOLD`). It is no longer read; remove it from a deployment's environment. Setting it changed nothing before and changes nothing now.

### Fixed: merging a correlation conflict reports the merged identity deleted

Deploy the API; no migration. An identity merged before keeps its graph node until the next resync (`POST /api/v1/access-explorer/resync`).

- `POST /api/v1/identity/:id/resolve-conflict` with `action: merge` (operator) soft-deletes the incoming identity and now emits `identity.deleted` for it (`reason: merged-into-target`, actor `merge-resolution`), as `POST /api/v1/identity/:id/link` does. Before it emitted none: the access graph kept the identity's node and access until a resync, and the audit log and the identity's timeline recorded no deletion. An incoming identity that offboarding had deleted was reported then and is not reported again; a refused merge (409) emits nothing.

### Changed: the access graph has a uniqueness constraint on each node label

Deploy the API and the worker; no migration, no new env var. At the first start after the deploy Neo4j builds each constraint's index over the existing nodes once. Then check the API log for "Could not create the uniqueness constraint" (below).

- **At each connection to Neo4j the API and the worker create, if missing, a uniqueness constraint on `(tenantId, id)`** for `:Identity`, `:Entitlement` and `:Application` (`identity_tenant_id_unique`, `entitlement_tenant_id_unique`, `application_tenant_id_unique`). Before, nothing created an index or a constraint: every MERGE of the event sync and the resync scanned all nodes of its label, so a resync slowed with the square of the tenant's size, and two MERGEs at once could write one node twice.
- **`POST /api/v1/access-explorer/resync` (super-admin) also removes the tenant's duplicate nodes** (two or more of a label with one id; one stays, with every edge the run wrote), counted in `removed.identities`, `removed.entitlements` and `removed.applications`, and then creates the constraints still missing.
- **A constraint that cannot be created** because the graph already holds duplicate nodes is logged as a warning that names the label, with Neo4j's message (it names one duplicate pair and its `tenantId`); the process goes on without it. A super-admin then resyncs that tenant (repeat for each tenant the log names after a restart): the resync removes the duplicates and creates the constraint.
- The OpenAPI descriptions of `GET /api/v1/access-explorer/identity/:id/graph` and `/identity/:id/sod-violations` now say "The graph holds no group nesting" (SCIM inbound groups record a member that is a group, below; nothing reads it into the graph). The spec needs regenerating.

### Changed: SCIM inbound groups keep each member's type

Deploy the API; no migration.

- `POST`, `PUT` and `PATCH /scim/v2/Groups` (SCIM bearer token) keep the `type` an IdP sends with a member (`User` or `Group`, in any case), and every answer with the group (those three, `GET /scim/v2/Groups` and `GET /scim/v2/Groups/:id`) returns a `Group` member as `type: "Group"` with a `$ref` to `/scim/v2/Groups/<value>`. Before, every member was stored as its value only and returned as a `User` with a `/scim/v2/Users/` `$ref`, so a group pushed as a member of another read back as a user. A member sent without a type (or with another) is a `User`, as before. Groups stored before keep their members as users until the IdP sends the members again. The types are stored on the group's catalog entry as `metadata.scimMemberTypes`; `entitlement.updated` still lists the member values.

### Changed: credential.inventory_updated is emitted

Deploy the worker; no migration.

- The nightly credential run (Temporal Schedule `credential-rotation-nightly`) emits `credential.inventory_updated` once per tenant and run, its aggregate id the tenant, with counts only: `{ refreshed, changed, unknown, removed }` (accounts read; rows whose password status changed, a new row included, and rows the run moved to `EXPIRED` without reading them; rows read and written `UNKNOWN`; rows of accounts the identity no longer has, deleted). Its payload schema keeps only those four counts. Before, the type was declared and offered on the Webhooks page, but nothing emitted it. A webhook subscription for it (or `credential.*`) now gets one delivery per tenant and night, and the audit log one entry.

### Fixed: a failed action stops loading at once (UI)

- Seven actions kept their button or dialog loading for about 3 s after a failure, until the error toast closed: create and activate a campaign (Access reviews), refresh the upcoming offboardings (Analytics), accept a policy suggestion, adopt and delete an orphaned account, and resolve a correlation conflict (identity profile). Deploy the frontend.

### Documented: the audit archive variables in backend/.env.example

- `AUDIT_ARCHIVE_ENABLED`, `AUDIT_ARCHIVE_CRON`, `AUDIT_ARCHIVE_S3_BUCKET`, `AUDIT_ARCHIVE_S3_REGION`, `AUDIT_ARCHIVE_S3_PREFIX`, `AUDIT_WORM_RETENTION_DAYS` and `AUDIT_ARCHIVE_INCLUDE_PAYLOAD` are listed with their defaults and what each does. Nothing changes in behaviour: with `AUDIT_ARCHIVE_ENABLED=true` and no `AUDIT_ARCHIVE_S3_BUCKET` the API and the worker still refuse to start (`AUDIT_ARCHIVE_S3_BUCKET is required when AUDIT_ARCHIVE_ENABLED=true`).

### Added: legacy Merkle checkpoints over the audit events written before hash version 2

Deploy the API and the worker together. No migration: Mongoose builds the new unique index `audit_roots { tenantId, legacyPart }` (partial on `legacyPart`) at start, over a small collection. No new env var; the checkpoints are made only where the daily audit archive run is scheduled (`AUDIT_ARCHIVE_ENABLED=true`).

- **The daily audit archive run checkpoints each tenant's older audit events once.** Events written before hash version 2 have no chain position (`seq`), so they were in no Merkle checkpoint, and the archive, which exports checkpointed events to WORM storage, never exported them. Now the run first makes legacy checkpoints over a tenant's events without `seq` up to its first chained event, by their stored `integrityHash` in `(timestamp, _id)` order, signed like the others when `AUDIT_ANCHOR_PRIVATE_KEY` is set. More events than `AUDIT_CHECKPOINT_MAX_EVENTS` (10000) go into numbered parts of whole milliseconds; a run that stops continues after the last part. A second run makes none. The next run archives them as it archives the others.
- **`GET /api/v1/audit/merkle-roots` rows gain `legacy: true` and `legacyPart`** (1, 2, ...) on a legacy checkpoint; it has no `firstSeq` or `lastSeq`. `POST /api/v1/audit/merkle-roots` still covers chained events only.
- **`POST /api/v1/audit/verify` answers `legacyCheckpointsChecked`** (always) and `legacyNote` when it is above 0. A legacy checkpoint is checked like the others: its root against its leaves, each covered event re-hashed by its own hash version against its leaf. The note says what that proves: the stored hashes, and the fields they cover, have not changed since the checkpoint was made. It cannot show a change made before then, and the old hash does not cover the payload, so a changed payload goes unnoticed.
- **`POST /api/v1/audit/verify-event/:eventId` answers `legacy`** (`true` when the checkpoint holding the event is a legacy one) and then `legacyNote`.
- The WORM export of a legacy checkpoint carries `legacy: true` and `legacyPart`.
- **The daily export to WORM storage now runs.** Its activity (`exportCheckpoint`) read the checkpoint by its `_id` outside any tenant context, so the tenant plugin refused the read ("Tenant context required for findOne") and every export failed: the workflow counted it in `errors` and logged a warning. It now runs in the checkpoint's tenant. Checkpoints that were not exported are still `archived: false`, and the next run exports them.

### Changed: correcting a drift that is no longer open answers 409

- `POST /api/v1/reconciliation/drifts/:id/correct` (operator) corrected a drift of any status: on a corrected drift it wrote the drift's stored, possibly stale value to the target again, and an ignored drift was relabelled corrected. Now only an open drift, or a quarantined orphan drift (its cleanup is stopped first, as before), can be corrected. A corrected or ignored drift answers `409` "Drift <id> is ignored: only an open drift, or a quarantined orphan drift, can be corrected", nothing is written to the target and the drift stays as it is. Bulk correct already skipped drifts that are not open. Deploy the API.

### Removed: `credential.rotated` and `credential.rotation_failed`, Okta's `credentialManagement` capability, the connector password resets

Deploy the API, the worker and the frontend; any order works, since nothing used what is removed. No migration, no new env var.

- **The event types `credential.rotated` and `credential.rotation_failed` are withdrawn**, with their payload types. Nothing emitted them since the nightly credential run stopped resetting passwords. A webhook subscription that names them keeps working: `filters.eventTypes` takes any event type name on create and edit (it is not checked against the event types), the subscription stays as it is, and its other names deliver as before; the two names match no event, so they deliver nothing, as before. `credential.*` matches `credential.expiring_soon` and `credential.inventory_updated`. The Webhooks page no longer offers the two types.
- **Prometheus: `euroid_credential_rotations_total` is gone.** Only those two events counted it, so a scrape had its `HELP` and `TYPE` lines and never a sample. Remove it from any dashboard or alert that names it.
- **Okta no longer advertises `credentialManagement`.** `GET /api/v1/connectors/available` (the Connector marketplace) lists Okta with `discover`, `provision`, `deprovision` and `healthCheck`, and its description no longer says "MFA queries, password management"; `POST /api/v1/connectors/okta/health-check` answers `capabilities` without it. No code path served it: Okta's credential state, MFA factor and password reset methods had no caller and are removed. Entra ID and AD keep the capability: the nightly run reads their credential state.
- **No connector resets a password.** `resetPassword` is removed from the Entra ID, AD and Okta services and clients and from `ICredentialManagement`, with the uncalled `CredentialInventoryService.markRotated`, `CredentialPolicyService.findActive` and `UpsertCredentialInventorySchema`. No route, workflow or activity called them, and none was in the OpenAPI spec. The admin console's own password reset (`/reset-password`) is unrelated and unchanged.

### Changed: the nightly credential run runs each tenant in its own call

Deploy the worker (no API change, no migration, no new env var). Runs already started finish the old way.

- **`credentialRotationWorkflow` (Temporal Schedule `credential-rotation-nightly`) lists the active tenants and runs each in its own activity call**, with its own 30-minute timeout and one retry (patch `credential-rotation:per-tenant`). Before, one call ran every tenant under one 30-minute timeout, so with many tenants a slow one could time out the call and the run retried every tenant from the start.
- **A tenant whose call fails, or times out, no longer stops the others.** The run goes on with the next tenant and, after the last one, fails with `The credential run failed for N of M tenant(s): <tenant> (<reason>); ...` (type `CredentialRotationTenantsFailed`, not retried), so the schedule still shows a failed run. The tenants that ran have their inventory and `credential.expiring_soon` events as usual. The workflow's result is unchanged when every tenant ran.

### Changed: the access graph connects on its own and follows discovery and deleted identities

Deploy the API and the worker together (both run the graph's event sync). No migration. If the graph was loaded before, run the resync once after the deploy (`POST /api/v1/access-explorer/resync`, super-admin): it removes the identities deleted since the last load, which the event sync removes only from now on. Where `NEO4J_PASSWORD` is empty, the default, only the readiness probe changes (`components.graph`).

- **An API or worker that could not reach Neo4j at start connects on its own.** Before, it stayed without a graph until restarted: the explorer routes answered `503` ("could not connect to Neo4j when it started ... restarts the API") and the event sync skipped every write. Now it tries again with a later graph call (a query, an event write, the readiness probe), at most once per `NEO4J_RECONNECT_INTERVAL_MS` (new, default `30000`, in `backend/.env.example`) and one attempt at a time; no request waits for it. Until it connects, the explorer routes answer `503` with a new message: the API is not connected to Neo4j, it connects on its own once Neo4j answers, what to check, and to load the graph again after an outage. The OpenAPI description of that `503` says so too.
- **`GET /api/v1/health/ready` gains `components.graph`** (`status`: `ok`, `not-connected` or `not-configured`). `not-connected` (Neo4j configured, not connected) makes the overall status `degraded` (HTTP 200).
- **`discovery.completed` is emitted.** The event type was declared and offered to webhook subscriptions, but nothing emitted it. Now every entitlement discovery written to the catalog (Entra ID, AD, Okta; scheduled syncs and `POST /api/v1/connectors/:name/discover`) emits it under the system with `{ system, discovered, removed }`: how many entitlements the discovery returned and how many of the system's catalog entries it removed. It reaches the audit log and webhook subscribers. The graph's event sync then writes the system's catalog entries that have a native id, with name and type, `BELONGS_TO` the system's `Application`, so entitlements that provisioning linked between resyncs no longer show as bare ids. Entries the catalog dropped stay in the graph until the next resync.
- **A deleted identity leaves the graph.** `identity.deleted` (offboarding, linking an uncorrelated identity, a bulk rollback) and `identity.offboarding_completed` with `hubStatus: deleted` remove the identity's node and its access in the tenant, as the resync leaves out soft-deleted identities. Before, holders, paths and SoD answers listed leavers until the next resync. An offboarding with a failed target (`hubStatus: suspended`) keeps the node: the account in that target still exists.
- **Group nesting is not modelled**, and the OpenAPI text of `GET /api/v1/access-explorer/identity/:id/graph` and `/identity/:id/sod-violations` now says so (their summaries no longer promise inherited or nested access): EuroID stores no group-in-group membership, so nothing writes `MEMBER_OF` and every path is one `HAS_ACCESS` step. The OpenAPI spec and the frontend's generated types need regenerating.

### Added: NHI credentials can be verified, and the signing key is published

- **New: `POST /api/v1/nhi/credentials/verify` (viewer)** takes the credential envelope `POST /api/v1/nhi/:agentId/credentials` answered (`{ payload, signature, keyFingerprint, algorithm }`, no other field) and answers 200 in the manner of OAuth token introspection (RFC 7662): `{ active: true, agentId, scope, expiresAt }` when the current signing key signed it unaltered, it is not past its own `expiresAt`, it was issued for the caller's tenant, and its agent is not revoked, killed or past its expiry. Otherwise `{ active: false, reason }`, the reason one of `credential signing is not configured`, `unsupported algorithm`, `signed with another key`, `malformed signature`, `invalid signature`, `credential expired`, `issued for another tenant`, `agent not found`, `kill switch engaged`, `agent revoked`, `agent expired`. A body that is not an envelope: 400 with the field. The tenant is the caller's, never the body's. Not audited; an inactive answer is logged with its reason.
- **New: `GET /api/v1/nhi/_/public-key` (viewer)** answers `{ algorithm: 'ed25519', keyFingerprint, trustDomain, publicKeyPem, jwk }` (the JWK has `kid` = the fingerprint, `alg: 'EdDSA'`, `use: 'sig'`) so a relying party can check signatures offline over the canonical payload (`backend/src/modules/nhi/docs/ARCHITECTURE.md`). An offline check cannot see a revoke, kill switch or expiry of the agent before the credential itself expires (at most 1 h); the verify route can. 404 when `NHI_SIGNING_PRIVATE_KEY` is not set.
- Before, nothing called `verify()`, no key was published, and a revoked or killed agent's credential stayed valid until its own expiry. `NHI_SIGNING_PRIVATE_KEY` and `NHI_TRUST_DOMAIN` are now in `backend/.env.example`. Deploy the API; no migration.

### Added: dry run of the NHI revoke and kill switch

- `POST /api/v1/nhi/:agentId/revoke?dryRun=true` and `POST /api/v1/nhi/:agentId/kill?dryRun=true` (super-admin) change nothing and answer `{ dryRun: true, agentId, killSwitch, changes, reached }`: `changes` false when the call would change nothing (a revoke of a revoked agent, a kill of a killed one), and `reached` the delegated agents it would revoke too (`agentId`, `displayName`, `kind`, `owner`, `parentAgentId`, `status`, `expiresAt`), depth first, walked by the same code as the real call. The reason may be left out in a dry run. `dryRun` other than `true` or `false`: 400 (so a typo never runs the real call). The NHI page's confirmation now shows this answer; before, it built the list in the browser from `GET /nhi?status=active`, at most 2000 agents. Deploy the API and the frontend together.

### Changed: NHI reads mark expired agents, and a delegated agent is stored with its parent at once

- `GET /api/v1/nhi`, `GET /api/v1/nhi/:agentId` (viewer) and every NHI write first mark the tenant's agents past their `expiresAt` `expired` (only agents still `active`; a revoked agent stays revoked). The list and the detail answer `expired` for them and `?status=expired` finds them; before, they listed as `active` until a write touched them. Credentials of such an agent no longer verify. No migration: the first list of each tenant converges its stored agents.
- `POST /api/v1/nhi/:parentAgentId/delegate` (super-admin) creates the child with its `parentAgentId` in the same write. Before, a second write added it, and a failure between them left an agent the parent's revoke or kill switch did not reach. The answer is unchanged.
- The OpenAPI spec now marks the list's six filters (`ownerIdentityId`, `kind`, `status`, `riskTier`, `page`, `limit`) and `dryRun` optional; before, a generated client sent every filter. The spec and the frontend's generated types need regenerating.

### Changed: peer groups count the access members hold, requests included

- The nightly intelligence batch built each peer group's baseline (`entitlementBaseline` of `GET /api/v1/intelligence/peer-groups`, policy-admin) from what the role-based rules would give the members, so access granted by request counted as held by nobody. `POST /api/v1/intelligence/unusual-check` (operator, the access request form) answered CRITICAL "No peers in your group have this access." for nearly every requestable entitlement, and recommendations offered only rule-given access. Now a member's access is what they hold, as their identity page calls it Active: the group, license and role grants of the rules on a target system where their account is `SYNCED` (access still pending no longer counts) and the entitlements of their `ACTIVE` access requests, named `system::nativeId` like the check names a catalog entry. Each baseline entry has `grantedBy`: `["policy"]`, `["request"]` or `["policy", "request"]`. Outliers and the risk score's peer deviation factor follow the same access.
- `GET /api/v1/intelligence/recommendations/:identityId` (operator) recommends what at least 70% of the peers hold and the identity does not have (what its identity page lists as Active or Pending counts as had), and each recommendation has two new fields: `grantedBy` (how the peers hold it; `[]` from a group built before this change) and `requestable` (a requestable catalog entry matches it). One with no catalog entry, or a not requestable one, comes with `requestable: false`; none was ever filtered out, although the module doc said so. The identity page's Recommendations tab shows both, and the peer group modal shows how members hold each entitlement.
- A build removes the tenant's peer groups it did not write: a group that fell below `INTELLIGENCE_PEER_GROUP_MIN_SIZE`, or one whose department and job title no identity has any more. Before, such a group kept its old members, so a mover could be matched to their old group by the recommendations, the unusual-request check and the risk score. A lookup by member takes the latest computed group.
- Deploy the API and the worker together; no migration. The stored groups keep their rule-only baselines (no `grantedBy`) until the next batch (04:00 UTC by default, `INTELLIGENCE_BATCH_CRON`). To rebuild at once, trigger the batch's Temporal schedule: `temporal schedule trigger --schedule-id intelligence-batch-daily`.

### Fixed: INTELLIGENCE_RUBBER_STAMP_THRESHOLD_MS sets the reviewer score's decision time threshold

- A reviewer's quality score (`GET /api/v1/intelligence/reviewer-quality`, super-admin) lost 25 points for an average decision under 30 s whatever `INTELLIGENCE_RUBBER_STAMP_THRESHOLD_MS` said. Now the variable sets the threshold (default 30000, unchanged), and each new score stores the one it used as `decisionTimeThresholdSeconds`, which the Reviewer quality tab names ("Decides in under 60 s"). Stored scores stay as they are (computed with 30 s). Deploy the worker (it scores) and the frontend.

### Changed: the intelligence.reviewer_quality_scored event says what was scored in the tenant

- The nightly scoring emits the event (audit log, webhook subscribers) once per tenant. `reviewersScoredCount` carried the number of campaigns scored so far in the run, added up across tenants, and `campaignId` only the tenant's first unscored campaign. Now `reviewersScoredCount` is the number of distinct reviewers scored in that tenant, the new `campaignIds` lists the campaigns scored there, and `campaignId` is the first of them (kept for subscribers that read it). A tenant where no campaign could be scored gets no event. Webhook subscribers see the new field and a different count. Deploy the worker.

### Fixed: a recurring access review campaign has one campaign per period

- The daily recertification scheduler cloned a completed recurring campaign and left it recurring next to its clone, which recurred too when it completed, so every recurring series doubled each period (and the reviewer mails with it). Cancelling a clone did not stop its source from cloning again. Now one campaign of a series clones the next one: once its clone exists the source gets `recurrence.enabled: false` and no `recurrence.nextRunAt`, and the clone carries the recurrence forward. A source cloned before the fix stops at its next due run without cloning again.
- `POST /api/v1/access-reviews/campaigns/:id/cancel` (super-admin) on a recurring campaign ends the recurrence: the cancelled campaign gets `recurrence.enabled: false` and no next campaign is created. The cancel dialog says so.
- Campaigns that already multiplied stay. They show as several campaigns of one series created in the same month: the same `templateCampaignId`, names that start with the series' name and end with the same `- YYYY-MM`. Cancel the extra active ones, which ends their series; an extra series whose latest campaign is completed clones once more at its `nextRunAt`, and that clone can be cancelled. Deploy the worker (the scheduler's activity) and the API; no migration.

### Fixed: a cancel during an access review's removals records the removals already made

- Cancelling a campaign (`POST /api/v1/access-reviews/campaigns/:id/cancel`) while its workflow removed revoked access turned the running removal and the rest of that batch into `failed` and recorded nothing for the batch, so access removed before the cancel had no `entitlements[].revocation` result and no timeline entry. Now the cancel stops the batch: the removals already made get their result, the removal that was running at the cancel gets none (whether it went through is unknown), and the rest is not attempted. Workflow patch `access-review-revocation:rethrow-cancellation`; it also applies to campaigns already running when it is deployed. Deploy the worker.

### Fixed: HTTP metrics count a failed request with its status code

- `euroid_http_requests_total` and `euroid_http_request_duration_ms` (`GET /metrics`) labelled every request that ended in an exception `status_code="200"`, so dashboards and alerts on 4xx and 5xx saw none. Now the label is the status the response got (a not found is `404`, a validation error `400`, an unhandled error `500`), recorded when the response is sent; the duration runs until then. Deploy the API.

### Changed: ignoring a drift that is no longer open answers 409

- `POST /api/v1/reconciliation/drifts/:id/ignore` (operator) set a drift of any status to `ignored`, a corrected one too; relabelled, a corrected drift that came back with the same values was never recorded again. Now only an open drift, or a quarantined orphan drift (still awaiting Adopt or Delete), can be ignored. A corrected or ignored drift answers `409` "Drift <id> is corrected: only an open drift, or a quarantined orphan drift, can be ignored" and stays as it is. Bulk ignore already skipped drifts that are not open. Deploy the API.

### Fixed: OPA_FALLBACK_ON_ERROR=false refuses an OPA error answer

- With `OPA_ENABLED=true` and `OPA_FALLBACK_ON_ERROR=false`, an OPA query that got an HTTP error or a result without `operations` (for example a wrong `OPA_POLICY_PATH`) still returned no result, the fallback to the TypeScript engine. Now it throws `OPA evaluation failed: <reason>`, as a network error or timeout already did; with `true` (the default) all of them return no result. Nothing calls the OPA query today (ROADMAP item 9), so a running deployment sees no change.

### Fixed: the NHI kill switch engages on an agent already revoked

- `POST /api/v1/nhi/:agentId/kill` (super-admin) on a revoked agent answered 200 with the agent unchanged: no `killSwitchEngaged`, no `AGENT_IDENTITY_KILL_SWITCH` audit entry and no `nhi.kill_switch_engaged` event, so webhook subscribers never got the kill signal. Now it sets the flag, writes the critical audit entry, emits the event and reaches any active delegated agent; the agent keeps its first revocation's `revokedAt`, `revokedBy` and `revocationReason`. A second kill, or a revoke of a revoked agent, still changes nothing. Deploy the API; no migration.

### Fixed: the analytics status counts only the caller tenant's audit events

- `GET /api/v1/analytics/v2/status` (viewer) answered `indexedEvents` as the number of audit events in the Elasticsearch index of every tenant, so any tenant's viewer learned how many events all tenants together had. It now counts the caller tenant's events, as the search and seasonal pattern routes already filter. Deploy the API; no migration, no reindex.

### Fixed: the time-based anomaly rule reads the hour on a 24-hour clock

- The TIME_BASED rule of the anomaly analysis (`POST /api/v1/anomalies/analyze` and the analysis after provisioning events) flags provisioning by a person outside business hours (`BUSINESS_HOURS_START` to `BUSINESS_HOURS_END` in `BUSINESS_HOURS_TZ`, default 07:00 to 19:00 UTC). It read the hour on a 12-hour clock, so changes from 13:00 to 18:59 were flagged as outside business hours, and changes from 19:00 to 23:59 and in the hour after midnight were not. Now the hour is read 0 to 23. Anomalies already stored stay as they are: afternoon TIME_BASED anomalies from before the fix can be dismissed. Deploy the API; no migration.

### Fixed: a record finds its identity by a source key that one source holds

- An HR row (HR syncs, `POST /api/v1/connectors/:name/ingest`) and a target account written back to the hub find their identity by source name and external id. The lookup took the name from one source of an identity and the id from another, so a record could update another person: one with, say, a `csv-hr` source of another employee and an account whose id is this employee number. Now one source must hold both, as the lookup of a deleted identity already required.

### Fixed: the access explorer answers 503 instead of empty data without a graph; Added: resync the graph from MongoDB, Neo4j compose profile, access explorer page

Deploy the API and the worker together and give both the same `NEO4J_URL`, `NEO4J_USER` and `NEO4J_PASSWORD` (the worker's provisioning events update the graph too). No migration. Nothing changes where `NEO4J_PASSWORD` is empty, the default, except that the explorer routes now say so.

- **Every `/api/v1/access-explorer` route fails closed.** With Neo4j not configured (`NEO4J_PASSWORD` empty), not connected when the API started, or a failing query, the four viewer routes answered empty data: "no access", "nobody holds this", no path, "no SoD violations". Now they answer `503` with what is wrong and what to do (configure Neo4j and restart the API, then run the resync; or check that Neo4j is reachable, with the cause in the API log). `GraphService.runQuery` and `runWriteQuery` stay fail-open for the event sync and the health check; the explorer reads through the new `readStrict`.
- **New: `POST /api/v1/access-explorer/resync` (super-admin)** loads the caller's tenant from MongoDB into the graph with the mapping the event sync uses: an `Identity` node per identity that is not soft-deleted (id = `_id`), an `Entitlement` node per entitlement catalog entry with a native id, linked `BELONGS_TO` its `Application` (the system), and `HAS_ACCESS` for the access the identity page shows as Active: policy grants on a target system where the identity's account is `SYNCED`, and the entitlements with a native id of its `ACTIVE` access requests. Each `HAS_ACCESS` carries `grantedBy` (`policy` or `request`) and `source` (the policy name or `Access request <id>`). Then it removes the tenant's `Identity`, `Entitlement` and `Application` nodes and `HAS_ACCESS` and `BELONGS_TO` edges MongoDB no longer has (`MEMBER_OF` is not in MongoDB and is left alone). Idempotent; other tenants are not touched. Answers `{ identities, entitlements, applications, grants: { policy, request }, removed: { identities, entitlements, applications, relationships }, durationMs }`; `409` while a resync of the tenant runs in that API process; `503` without a graph; a policy evaluation that fails stops it before anything is removed (`500` naming the identity). It runs in the request, one policy evaluation per identity with a synced account.
- `GET /identity/:id/graph` adds `identityFound` (false: the graph has no node for the identity, which is not the same as no access), `truncated` and `pathLimit` (at most 2000 paths), and the identity's own node; relationships' `sourceId` and `targetId` are now the node ids (`_id`, native id) instead of Neo4j element ids, so edges point at the answer's nodes.
- `GET /entitlement/:id/holders` adds `entitlementFound`, `entitlement` (the node, with its name) and `truncated` and `pathLimit` (at most 1000 paths). `GET /path` adds `identityFound` and `entitlementFound`. `GET /identity/:id/sod-violations` adds `identityFound` and `policiesChecked` (active SoD policies naming entitlements); with no node for the identity nothing is checked.
- **Access explorer page** (`/access-explorer`, Governance > Access explorer, every role; docs/USER_FLOWS.md Flow 24): an identity's access as a canvas (at most 60 nodes, nearest first) and a table with how each entitlement was granted, the holders of an entitlement, the access path, SoD violations through nested groups; the 503 shown with the API's message; [Load graph from MongoDB] for super-admins. The identity page's [Access graph] opens it on that identity.
- **Neo4j in Compose:** service `euro-neo4j` behind the profile `graph` (`docker compose --profile graph up -d euro-neo4j`, Bolt and Browser on 127.0.0.1 only); `docker compose up` starts the same services as before. `euro-api` and `euro-worker` get `NEO4J_URL` (default `bolt://euro-neo4j:7687`), `NEO4J_USER` and `NEO4J_PASSWORD` (default empty); `.env.example` documents `NEO4J_PASSWORD` and `NEO4J_HEAP_MAX_SIZE`. `docs/GETTING_STARTED.md` § Optional: the access graph.
- The OpenAPI spec needs regenerating (new route, changed Swagger summaries and responses).

### Fixed: the credential rotation run resets no password and fills the credential inventory; Added: credentials by status, credential lifecycle page

Deploy the API and the worker together (the worker runs the new rotation code, the API serves the new route and the `409`). No migration: the new fields are optional and the next nightly run fills the inventory. New optional env var `CREDENTIAL_INVENTORY_REFRESH_LIMIT` (worker, default 500).

- **The nightly credential rotation run resets no password.** It reset the Entra ID or AD password of every due credential under a policy with rotation on to a generated value and kept the value nowhere (`rotationPolicy.vaultStorage` is not implemented), locking a person out and breaking a service account's consumers. Now a due credential stays `EXPIRED` with its `nextRotation` unchanged, and each run emits `credential.expiring_soon` for it with `daysRemaining` 0 or less and the new optional payload field `reason` ("Not reset: automatic reset needs secret storage, which EuroID does not have. Change the password in the target system."). A person's password is never to be reset automatically, also once secret storage exists. The run no longer emits `credential.rotated` or `credential.rotation_failed`. `credential.expiring_soon` is emitted once per credential and run (before, once per active policy with rotation on), for every expiring credential (before, only while some policy had rotation on), and its `externalId` has the name in an AD distinguished name masked.
- **The run fills `credential_inventory` by reading the targets.** Nothing wrote it before, so `GET /api/v1/credential-lifecycle/expiring`, `/compliance` and `/inventory/:identityId` answered empty. Now each night, per active tenant, every live identity's `SYNCED` Entra ID or AD account is read (last password change; MFA methods for Entra ID) and gets one row (`targetSystem` `entra-id` or `ad`) with the status from the policy that applies (`passwordPolicy.maxAgeDays`, warning window `rotationPolicy.notifyDaysBefore`). An account that cannot be judged gets `UNKNOWN` with the new `password.statusReason`; each row gets the new `observedAt`. At most `CREDENTIAL_INVENTORY_REFRESH_LIMIT` accounts per tenant and night, the ones read longest ago first. Rows of accounts the identity no longer has are deleted.
- **The scheduled run covers every active tenant.** The schedule names no tenant and the run failed at once on the empty tenant id (`[SECURITY] tenantId is required`), so it never did anything.
- **New: `GET /api/v1/credential-lifecycle/inventory?status=&limit=` (operator)**: the credentials in one status (`COMPLIANT`, `EXPIRING_SOON`, `EXPIRED`, `UNKNOWN`), `limit` 1 to 1000 (default 100), earliest due first. A missing or other status, or a limit out of range: `400` with the field path.
- `GET /api/v1/credential-lifecycle/expiring` answers earliest due first (before, in no order, so `limit` could cut the most overdue).
- `POST` and `PATCH /api/v1/credential-lifecycle/policies` answer `409` "A credential policy named "X" already exists. Choose another name." for a name the tenant already has (before, `500`).
- **Credential lifecycle page** (`/credentials`, Governance > Credential lifecycle, operator; docs/USER_FLOWS.md Flow 22): due and overdue credentials, the ones that could not be checked with the reason, the note that automatic reset is off; for policy-admins the compliance summary and the policies (create, edit, delete). The identity page has a Credentials tab for operators. Governance > Joiners, movers and leavers is now shown to policy-admins and super-admins only, like its routes.
- The OpenAPI spec needs regenerating (new route, changed Swagger summaries).

### Changed: one audit hash chain per tenant, hash version 2, honest integrity checks; Added: create a Merkle checkpoint, audit integrity page

Deploy the API and the worker together: both write audit events, and an old process still running writes events without a chain position (they verify, as older events). No migration: the first audit write of each tenant creates its chain head, and Mongoose builds the new indexes at start.

- **One chain per tenant.** Every audit event written from now on gets `seq` (its chain position: 1, 2, 3 ...), `hashVersion: 2` and the `integrityHash` of the event before it as `previousHash`, through a per-tenant chain head (new collection `audit_chain_heads`; a unique `{ tenantId, seq }` index on `audit_events` keeps two writers apart). Before, each process (the API, the worker) cached its own last hash per tenant, so events written by both, or two at the same moment, linked to the same predecessor. The first write of a tenant continues from the newest event already in its log, not from a second genesis. Callers of `AuditService.log` are unchanged.
- **Hash version 2 covers every stored field**: `_id`, `seq`, `hashVersion`, `eventId` and the whole `payload` (canonical JSON, keys sorted at every depth), all but `integrityHash`, `previousHash` and Mongoose's `__v`, `createdAt`, `updatedAt`. Before, the hashed JSON kept only the top-level field names at every depth, so `payload` hashed as `{}` and a changed payload went unnoticed. Events written before keep their stored hashes and are checked by the old rule.
- **`GET /api/v1/audit/verify-integrity` (super-admin)** re-hashes every event of the window by its own hash version. Older events (no `seq`) come first, by time: their link may point to any earlier event of the log (their writers forked the chain), and a link to an event that is nowhere is `broken_link`. Chained events follow in `seq` order: each must link to the event at the position before it (`broken_link`), and a missing position is `missing_events` unless a GDPR erasure recorded removing it. A window that reaches now also finds events missing at the end of the chain (answer without `firstInvalid`). The first event of a window is checked by its own hash only. The answer keeps `valid`, `eventsChecked`, `firstInvalid` and adds: `firstInvalidAt` (ISO), `firstInvalidSeq`, `reason` (`hash_mismatch`, `broken_link`, `missing_events`), `missingEvents`, `legacyEventsChecked` (events written before hash version 2) with `legacyNote` (their hash does not cover the payload), and `erasureGaps` (`[{ erasureEntryId, erasedAt, eventsRemoved }]`). Before, events were only re-hashed with their own stored `previousHash`, so a deleted or moved event answered `valid: true`. The SOX report's audit trail integrity runs the same check.
- **`DELETE /api/v1/identity/:id/gdpr-erase` (super-admin)**: the `GDPR_ERASURE_EXECUTED` entry's `payload.metadata` records `removedSeqs` (chain positions of the audit entries it deletes) and `removedLegacyHashes` (hashes of deleted entries written before hash version 2), and exactly those entries are deleted. The chain check reports the gap as `erasureGaps`, not as tampering. A dry run records neither.
- **New: `POST /api/v1/audit/merkle-roots` (super-admin)** creates a Merkle checkpoint over the chained events after the last checkpoint (at most `AUDIT_CHECKPOINT_MAX_EVENTS`, default 10000), signed when `AUDIT_ANCHOR_PRIVATE_KEY` is set, and writes an `AUDIT_CHECKPOINT_CREATED` audit event. 201 with the checkpoint (without `eventHashes`); 400 when no chained event follows the last checkpoint; 409 when another checkpoint over the same events was made at the same moment. Checkpoints gain `firstSeq` and `lastSeq`; events written before hash version 2 are in none. The daily audit archive run (`AUDIT_ARCHIVE_ENABLED=true`) now also creates each tenant's checkpoints (at most `AUDIT_CHECKPOINT_MAX_PER_RUN`, default 50, per tenant) before it archives the settled ones. Before, nothing created a checkpoint.
- **`POST /api/v1/audit/verify` (super-admin)** checks each checkpoint created in the range against the events it covers: its stored root against its stored leaves, and every covered event still in the log re-hashed against its leaf. New fields: `eventsMissing` (leaves whose event left the log: retention, GDPR erasure, deletion; counted, not judged), `firstInvalidCheckpoint`, `reason` (`root_mismatch`, `event_changed`), `invalidEventId`. `eventsVerified` now counts events re-hashed. Before, it compared each checkpoint's root with its own stored leaves, read no event, and its `eventsVerified` was the leaf count. A request without a body is accepted.
- **Zod on every audit route input, 400 with one `field: message` line per issue.** `from`, `to` (verify-integrity, verify) and `dateFrom`, `dateTo` (`GET /api/v1/audit`) must be ISO 8601 times, and not reversed; `GET /api/v1/audit/merkle-roots` `page` 1 to 10000 and `limit` 1 to 100 (before, any number); `:eventId` must be a 24-hex `_id`, `:checkpointId` a UUID. Before, a bad date reached the database. `GET /api/v1/audit` validation errors now read `dateFrom: must be ...` (one line per field) instead of `Validation failed: ...`.
- **Audit integrity page** (`/audit/integrity`, Governance > Audit integrity, super-admin; docs/USER_FLOWS.md Flow 21): the chain check over a time window with the first broken event (position, reason, link to it in the audit log, its Merkle proof), the missing end of the chain, erasure gaps and the count of older events; one event's Merkle proof; the checkpoints with their positions and anchor status, [Create checkpoint] and [Check checkpoints]; a signed checkpoint's anchor in a modal. The audit log (`/audit`) takes `?dateFrom=&dateTo=` (ISO) and starts filtered to that window.
- The OpenAPI spec needs regenerating (new route, new Swagger descriptions).

### Fixed: GDPR consent grants and erasure counts; Added: identity list search with offboarded identities

The UI for these is the new GDPR requests page (`/compliance/gdpr`, docs/USER_FLOWS.md Flow 20). API only; the worker is unchanged.

- `POST /api/v1/identity/:id/consent` (role: operator) on a purpose that already has a record makes the record this grant: `method` and `expiresAt` are the request's, removed when it sends none, and `revokedAt` is removed. Before, a field the request did not send kept its old value (Mongoose drops undefined values from an update), so a purpose granted again after a revoke still carried its `revokedAt`, and a grant without an expiry kept the previous `expiresAt`. `GET /api/v1/identity/:id/consent` shows the change.
- `POST /api/v1/identity/:id/consent`: 404 "Identity <id> not found" when the id is no identity of the caller's tenant (an offboarded one counts). Before, a consent record was stored for any ObjectId.
- `POST /api/v1/identity/:id/consent`: an `expiresAt` that is not a date is 400 with `["expiresAt: must be a date, e.g. 2026-12-31 or 2026-12-31T23:59:59.999Z"]`. Before, a value Mongoose could not cast as a date answered 500.
- `DELETE /api/v1/identity/:id/gdpr-erase` (role: super-admin, also with `?dryRun=true`): `documentCounts.audit_events` and `documentCounts.outbox_events` count what the erasure deletes: the identity's audit entries except the `GDPR_ERASURE_EXECUTED` ones (kept), and published outbox events only (pending and failed ones stay). Before, both counts included the kept documents, so the attestation and the audit entry overstated what was deleted; each preview added one more.
- `GET /api/v1/identity` (role: viewer) takes `q`: every word must be in the work email, first, last or display name, case ignored, taken as text (at most 100 characters, else 400). `X-Total-Count` counts the matches. The command palette already sent `q`, which was ignored: its identity search now filters.
- `GET /api/v1/identity` takes `includeDeleted=true`: offboarded (soft-deleted) identities too, each with `deletedAt`. It needs operator or above (403 "includeDeleted=true needs the operator role or above" for a viewer); a value other than `true` or `false` is 400.

### Changed: cancelling an access review campaign takes a reason, is audited and closes its items

API only; the worker is unchanged.

- `POST /api/v1/access-reviews/campaigns/:id/cancel` (role: super-admin): new optional body `{ reason?: string }`, trimmed, 1 to 500 characters; a blank or longer reason, or one that is not text, is `400` with the field's message. A request without a body cancels as before. Response unchanged (the campaign with `status: CANCELLED`), and as before `400` for a COMPLETED or CANCELLED campaign.
- New domain event `access_review.campaign_cancelled` (`campaignId`, `name`, `previousStatus`: `DRAFT` or `ACTIVE`, `reason?`; actor: the admin) in the audit log (resource id: the campaign), webhook subscriptions and the tenant websocket. Before, a cancel left no audit entry.
- A cancelled campaign's items are closed to reviewers. `POST /api/v1/access-reviews/items/:itemId/decide` (role: operator) answers `409` "Campaign "<name>" was cancelled: its items can no longer be decided" for an item of a CANCELLED campaign and writes nothing (before, the decision was recorded and nothing acted on it). `GET /api/v1/access-reviews/my-reviews` (role: viewer) leaves out the items of CANCELLED campaigns, pending and decided, and `total` counts without them.
- UI: Access reviews > Campaigns has a [Cancel campaign] row action (super-admin; DRAFT and ACTIVE campaigns) whose confirmation says what happens to the open items and to the revokes already decided, and requires the reason. A failed decision in My Reviews shows the API's message and reloads the list.

### Fixed: connector account lookups, masked AD errors, SSRF guard, legacy key recovery

Deploy the API and the worker together.

- **Entra ID, mover and sync never create a second account.** The mover and onboarding started by `PATCH /api/v1/identity/:id?syncToEntra=true` find the Entra ID account of an identity whose Entra ID provisioning entry says it has one, without a written-back object id (bulk provisioning writes none), by its UPN, its email as mail or UPN, or its employee id. When no account has them, the Entra ID target fails without retry ("The Entra ID account of this identity was not found: no object id is recorded for it, and no account has its UPN, email or employee id. Link the account to the identity or re-provision it; ..."; HTTP 422 in the reason) on the run's result, the identity timeline and the provisioning entry's `errorMsg`. Before, such an identity got a new account. Two accounts with the employee id fail the same way, choosing neither. Onboarding an identity without an Entra ID account still creates it.
- **Okta config read errors.** When reading the tenant's installed Okta config fails (MongoDB unreachable, as already for a config that cannot be decrypted), every Okta call fails with that error and the Okta health check (`POST /api/v1/connectors/okta/health-check`, onboarding) fails with it instead of answering false. Before, Okta fell back to the `OKTA_*` environment variables, the deployment's own org. Only a tenant with no installed Okta config uses them.
- **Active Directory reruns and namesakes.** `provisionUserToAd` (onboarding, admin account provisioning) uses the person's existing account, found by the UPN it sets (only the UPN identifies it), with that account's sAMAccountName and DN, and creates nothing. Before, a retry or a later run for a person whose account existed wrote back `<sAMAccountName>1`. A new account gets a numeric suffix on a sAMAccountName or CN another account holds (`CN=John Doe 1`; the display name is kept), so a namesake in the same OU gets an account of their own; before, the account at the planned DN was adopted ("already exists"), the namesake's groups included. An account that appears at the DN between the check and the create with another UPN fails the AD target without retry ("... is another person's account (its UPN differs), so it was not used. Run provisioning again ...").
- **Masked AD errors.** An AD provisioning error other than a group change reads `ad: <step> failed (LDAP result <code>): <reason>` (steps: find the account, create the account, read the account's groups) with the names in DNs and emails masked, in workflow history and the provisioning entry's `errorMsg`. Retries are unchanged.
- **SSRF guard for ServiceNow, Okta and Discord webhook.** Their clients refuse a tenant URL (`instanceUrl`, `orgUrl`, `webhookUrl`) that is not https, names localhost or a cloud metadata host, or is a private, loopback, link-local or reserved IP address, and connect only to public addresses a host name resolves to; they follow no redirect and use no proxy from the environment (`HTTP_PROXY` / `HTTPS_PROXY`). A refused URL fails the call and answers false to the health check. Saving the config does not check the URL. The guard's refusals name no connector any more (they began with `JsonApiHrConnector:` for every client).
- **Encryption key recovery.** With `ENCRYPTION_KEY_PREVIOUS` set, a secret stored under the key id `default` (or a `euroid:v1:` value) that the previous key does not open is tried once with `ENCRYPTION_KEY`, logged once per process without key material. Deployments that followed the old rotation steps and hold `default` secrets under two keys recover them: put the old key back as `ENCRYPTION_KEY_PREVIOUS`, set `ENCRYPTION_KEY_ID`, restart, and run the rotation script (`backend/src/infrastructure/secrets/docs/ARCHITECTURE.md`, Key Rotation).

### Fixed: correlation by employee number, Link after offboarding, rehires with a taken email, canvas load errors

Fix round 2, package R3 (identity and correlation).

- **HR rows carry a mapped employee number.** A CSV HR `columnMap` or JSON API HR `fieldMap` entry with the target `employeeNumber` was dropped, so `sources[].rawData.employeeNumber` stayed empty and the `employeeNumber` correlation rule (Design studio, Brain > Identity Correlation, "Employee Number") never matched an HR row: two sources with one person's employee number made two identities. The value is now kept like `employeeId` (`POST /api/v1/connectors/:name/ingest`), and the next sync of each source stores it. A row that carries an employee number is also told apart from a former employee's deleted identity by it (the `isAnotherEmployee` rule of the 2026-11-23 sweep, which HR rows could not reach before).
- **The uncorrelated queue keeps an identity offboarded before its Link.** `POST /api/v1/identity/:id/link` refuses with 409 while the uncorrelated identity has an account in a target, so the admin deletes it first; once its offboarding has finished it left the queue for good, and its HR record stayed on the deleted identity, ignored at every sync. `GET /api/v1/identity/uncorrelated` (role: viewer) now also lists uncorrelated or ambiguous identities that offboarding soft-deleted and that hold no account, each item with the new field `offboarded: true` (`false` for a live identity); `GET /api/v1/identity/uncorrelated/count` counts them. `POST /api/v1/identity/:id/link` (role: operator) merges such an identity into the target (it keeps its deletion and gets the released email; no second `identity.deleted` is emitted), `GET /api/v1/identity/:id/candidates` suggests candidates for it, and `POST /api/v1/identity/:id/create-standalone` (role: operator) takes it out of the queue as a person of its own (it stays deleted). A deleted identity that still has an account is not listed, and its Link keeps the 409. An identity that a merge already took answers 404 on all three. Uncorrelated queue page: the row is tagged "Offboarded, ready to link", and the modal's second button reads "Keep Separate" for it.
- **A rehire whose old address a new hire has now is held for review.** Reviving gave the rehired identity the HR row's email, which failed on the unique email index at every sync while a new hire had that address (an error in each run). The row is now held on the new hire's correlation conflict like a record no rule matches whose email is taken: `POST /api/v1/connectors/:name/ingest` counts it in `rowsHeldForConflictReview` (not in `errors`), `GET /api/v1/identity/conflicts` lists the new hire with `conflictDetails.matchedBy: 'email'`, `confidence: 0` and the row in `incomingSource`, and the deleted identity stays as it is. Once HR sends the rehire a new address, the next sync revives them. Merge on that conflict would add the former employee's record to the new hire, and Dismiss closes it only until the next sync holds the row again: the fix is the new address in HR.
- **`POST /api/v1/privileged-access/:parentId/admin-accounts`**: the admin UPN check counts live identities only, as the unique email index does, so an address that only a soft-deleted identity has no longer answers `409 Admin identity ... already exists`. A live identity with it still does (now documented in the OpenAPI spec). The idempotency lookup also takes live admin identities only: re-creating the account of a tier whose admin identity was deleted answered 201 with the deleted identity and created nothing; it now creates a new admin identity (the parent's `linkedAdminAccounts` keeps the old entry next to the new one), and a later call returns that one.
- **`GET /api/v1/blueprints/latest`** (role: viewer): a canvas that cannot be loaded answers `503` with a message, and nothing is changed. Any load error was answered `200` with `success: true` and an empty canvas, so the Design studio showed its default layout and a Save overwrote the stored canvas (seen with another `ENCRYPTION_KEY`). A stored config this process cannot decrypt says so and names the key settings to check ("... could not be decrypted by this process. Nothing was changed. Check that the encryption keys of every API and worker process ..."); any other failure reads "The saved Design studio canvas could not be loaded. Nothing was changed. Retry shortly ...". Nothing saved is still `200` with an empty canvas and no `lastSaved`. Design studio: such a failure shows the message with Retry in place of the canvas, and no Save is offered until a load succeeds (it showed the default layout with a warning).
- **Design studio**: a saved canvas without nodes loads as saved, with its `connectorConfigs` (the Brain's correlation rule among them). It loaded the default layout without them, so Brain > Identity Correlation showed "Email (fallback)" and a Save overwrote the saved rule. The default layout loads only when nothing is saved (`GET /api/v1/blueprints/latest` without `lastSaved`).
- Deploy: API and worker together; run `npm run migrate:up` (the Dockerfile does this on start): `20261124000000-deprovisioned-writeback-incomplete` sets `writebackComplete: false` on every `DEPROVISIONED` provisioning entry. Entries deprovisioned before the 2026-11-23 sweep kept `true`, so re-provisioning such a target wrote no account id back and Okta, SCIM, AD and Entra ID kept the removed account's id for the mover and offboarding. Rerunning it is safe; `down` is a no-op (the earlier flags are not recorded). The OpenAPI descriptions of `uncorrelated`, `link`, `create-standalone`, `admin-accounts` and `blueprints/latest` changed: regenerate the spec.

### Added: access review exclusions (a review revoke sticks)

A revoke in an access review is now a durable, audited exception: before, the next onboarding, mover run or re-evaluation granted policy-granted access a reviewer had revoked again. Deploy the API and the worker together (the worker records exclusions at campaign close and runs the patched onboarding). No migration: `review_exclusions` is a new collection whose indexes Mongoose builds.

- At campaign close each revoked entitlement (and each expired one the campaign auto-revokes) becomes an access review exclusion for the identity, system and entitlement, whatever its removal's outcome; an account item excludes the whole system for the identity. It holds the campaign, the reviewer, the justification, the time and the active policies that grant it. One active exclusion per identity, system and entitlement.
- The policy engine leaves excluded operations out of every intent: onboarding, the mover and re-evaluation (both sides of the delta), `GET /api/v1/identity/:id/access/preview`, `GET /api/v1/identity/:id/entitlements`, access request SoD, risk scoring and SoD itself. An exclusion never suppresses a `remove`, and offboarding does not evaluate the policies, so a leaver still loses everything.
- Onboarding (workflow patch `onboarding:review-exclusions`, new runs) leaves a target out of a person's provisioning when an access review revoked their account there: no provisioning entry, no account, the timeline entry "Not provisioned to <target>: excluded by an access review", and the run's result ends with "Left out by an access review exclusion: <targets>." The run does not fail for it.
- `GET /api/v1/identity/:id/access/preview` (role: viewer) is evaluated also when no attribute changed since the access baseline, and its baseline side (like the mover run's) leaves out what an exclusion lifted after the baseline took away: the access of a lifted exclusion shows in `toAdd` until a run gives it back.
- `GET /api/v1/policy/evaluate/:identityId` (role: viewer): new optional `suppressedOperations[]`, each operation with `suppressedBy: { reason: 'Suppressed by access review', exclusionId, campaignId }`. The identity map's policy trace shows such a grant as suppressed by access review.
- **New:** `GET /api/v1/identity/:id/access/review-exclusions` (role: viewer): `{ identityId, exclusions[] }`, the identity's active exclusions, newest first: `_id`, `targetSystem`, `scope` (`entitlement` or `account`), `entitlementType`, `entitlementName`, `entitlementId?`, `campaignId`, `campaignName`, `itemId`, `decision` (`revoked`, or `expired` for an auto-revoke), `reviewer?`, `justification?`, `decidedAt?`, `createdAt`, `grantingPolicies[{ policyId, policyName }]`, `status`. 404 for an identity not in the tenant, 400 for an id that is not an ObjectId.
- **New:** `POST /api/v1/identity/:id/access/review-exclusions/:exclusionId/lift` (role: policy-admin; body empty, any field is a 400): `{ exclusion, run }`. The exclusion is now `status: lifted` with `liftedBy` and `liftedAt`, and the run that gives the access back starts with the admin as actor: for an entitlement exclusion the identity's re-evaluation (audited `ACCESS_REEVALUATION_REQUESTED`), for an account exclusion onboarding for the identity (`identity.provision_requested`, reason `access-review-exclusion-lifted`), which skips the SYNCED targets and creates the missing account. `run: { type: 'reevaluation' | 'onboarding', started: true, workflowId }`, or `{ type, started: false, reason }` when it could not start (no access baseline, no provisioned target, a run in progress, no email, Temporal unreachable), the lift staying done. 404 when the exclusion is not the identity's in this tenant, 409 when already lifted.
- When an identity's offboarding has run (`identity.offboarding_completed`), its exclusions end: `status: lifted`, `liftedBy: 'system'`, `liftReason: 'identity offboarded'`, audited (`access_review.exclusion_lifted` with `reason`, actor `system:offboarding`).
- GDPR: `DELETE /api/v1/identity/:id/gdpr-erase` deletes the subject's exclusions (attestation count `review_exclusions`); `GET /api/v1/identity/:id/dsar-export` returns them as `accessReviewExclusions`.
- **New:** `GET /api/v1/policy/review-exclusions/counts` (role: viewer): `{ counts: [{ policyId, policyName, active, lifted }] }`, one row per policy with at least one exclusion counted against it. The policy list shows "N revoked in reviews".
- New domain events `access_review.exclusion_created` (`exclusionId`, `identityId`, `targetSystem`, `scope`, `entitlementType`, `entitlementId?`, `campaignId`, `itemId`, `decision`, `grantingPolicyIds`; actor: the reviewer, an auto-revoke: system) and `access_review.exclusion_lifted` (`exclusionId`, `identityId`, `targetSystem`, `scope`, `campaignId`, `reason?`; actor: the admin, or `system:offboarding`), in the audit log (resource: the identity), webhook subscriptions and the tenant websocket. Ids only: no reviewer address, justification or entitlement name.

### Fixed: a policy's changed grants need a second policy-admin again

- `PATCH /api/v1/policy/:id` (role: policy-admin): a change of `conditionGroups`, `actions` or `roleBundleId` sends any policy that is not a draft (ACTIVE, DISABLED, TESTING) back to `draft`, so it goes live only through `POST /api/v1/policy/:id/activate` by a policy-admin other than its creator. Before, only an ACTIVE policy went back to draft: a policy-admin could disable a peer-reviewed policy, change what it grants and toggle it back to ACTIVE (`PATCH /api/v1/policy/:id/toggle`) without that review. A name or description change keeps the status.
- `POST /api/v1/policy/:id/activate` (role: policy-admin): 403 for the admin who last changed the policy's conditions, actions or role bundle (new, recorded on the policy as `lastEditedBy` / `lastEditedAt`), and as before for the creator of a policy no one has changed so. Before, only the creator was refused, so an admin who changed another admin's policy could activate the change themselves. The creator may activate another admin's change; policies created by `system` stay exempt. `GET /api/v1/policy` and `GET /api/v1/policy/:id` return the two new fields.

### Changed: HR-mastered attributes, their override, contract-critical mastery, unchanged saves

Owner decisions of 2026-11-24 (fix round 2, package R2).

- **`PATCH /api/v1/identity/:id`** (role: operator): a body that changes a field an HR source masters is refused with `409` and nothing is saved, e.g. `departmentName is mastered by csv-hr: change it in HR, or set an override.` ("or set an override" only for `departmentName` and `jobTitle`). The master is the HR source the next reconcile would write the field from: the primary HR contract for a contract-critical field, else the field's Field Mastery owner, else the first HR source with a value. A department or job title with an active override is refused as well (`... has an override: change or remove the override instead.`). Fields no HR source masters stay editable, and the plan 2.8c `metadata.manualOverrides` still applies to them. A body that changes no value (empty, or every value as stored) writes nothing, emits no `identity.updated` and adds no timeline entry, here and for SCIM inbound; it recorded "Updated: " with "0 field(s) updated". With `?syncToEntra=true` the sync still runs.
- **SCIM inbound** `PUT`, `PATCH` and `DELETE /scim/v2/Users/:id` (SCIM bearer token): a change of a field an HR source masters (a `DELETE` sets the status) is refused in SCIM's error model, `400` with `scimType: "mutability"` and the field and its owner in `detail` (e.g. `firstName is mastered by csv-hr: change it in HR.`), nothing saved. A full `PUT` that repeats the current value of such a field passes.
- **`POST /api/v1/connectors/:name/install`** and **`PATCH /api/v1/connectors/:name`** (role: connector-admin): `masteryFields` listing a contract-critical field for a connector the Contract Tag and ingest priority do not make the primary HR source (a secondary HR source, or a connector that is no HR source) is `400`, nothing saved, with the same message as the Recon Config and Design studio saves.
- **New:** `GET /api/v1/identity/:id/mastery` (role: viewer): `{ identityId, masteredBy: { <field>: <HR source> }, attributeControls: { departmentName?, jobTitle?: { value, reason, setBy, setAt, expiresAt? } } }`; 404 for an unknown identity. The identity page's Profile tab shows the fields in `masteredBy`, and an overridden department or job title, read-only with the owner named.
- **`PATCH /api/v1/identity/v2/:id/controls`** (role: operator), the one override of an HR-mastered department or job title: new `manualJobTitle` next to `manualDepartment`; `reason` (1 to 500 characters) is required to set one, `expiresAt` (ISO date-time in the future) is optional, `""` or `null` removes it (a `reason` there is optional and audited). The identity page's Profile tab offers these actions to an operator under the department and job title. `400` for a control set without reason, an `expiresAt` in the past or without a control being set, and for an unknown field (the body is strict now). While set, reconcile writes the value into the profile and the policy contracts take it in the primary HR contract (and in any HR contract holding the same value), whatever HR sends meanwhile. Before, the contract followed HR's next value while the profile kept the manual one, so the identity matched both departments. The control ends when removed or at the first hourly expiry run after `expiresAt` (the activity of `entitlementExpiryWorkflow`); then the HR value returns and `identity.updated` starts the mover (or onboarding), with `source` `system:control-expiry` for an expiry. Audit: `IDENTITY_CONTROL_SET`, `IDENTITY_CONTROL_REMOVED`, `IDENTITY_CONTROL_EXPIRED` with the values, reason and expiry, the admin as actor. The control no longer writes `metadata.manualOverrides`. An unknown identity is now `404` (it was `200 { success: false, error: "Identity not found" }`). `GET /api/v1/identity/v2/:id` and `/v2/by-email` carry `controls.manualJobTitle`, `controls.manualDepartmentInfo` and `controls.manualJobTitleInfo` (`reason`, `setBy`, `setAt`, `expiresAt`). A `manualDepartment` set before this change has no reason or expiry and stays until removed.
- **Contract-critical fields** (Admin > Recon Config) always come from the primary HR contract. Reconcile no longer lets a Field Mastery owner, the default mastery or an HR source node's mastery fields write one from another source: a default mastery naming the secondary froze the field, and a secondary source node's mastery let the secondary win. **`PUT /api/v1/admin/reconciliation-config`** (role: policy-admin) answers `400`, nothing saved, for a `defaultMastery` entry of a contract-critical field that names a source other than the primary; **`POST /api/v1/blueprints/save`** (role: policy-admin) does so for such an entry in the Brain's `correlationConfig.fieldMasteryOverrides` or in an HR source node's `masteryFields`. The primary is the HR source the Contract Tag and ingest priority make primary (the Design studio source nodes, else the installed connectors; without either, the first HR source tag in the source priority). The message names each refused entry and the primary, and says to choose the primary through the Contract Tag and ingest priority. Each save checks the settings it stores. Admin > Recon Config, the Design studio's Field Mastery and a source node's save now show the API's message.

### Fixed: access request decisions, time-bound requests, access review system scope, HR batch approvals

Fix round 2, package R6. Deploy the API and the worker together (new workflow patches and activity).

- `PUT /api/v1/access-requests/:id/approve`, `.../reject` and `.../delegate` (role: operator): the decision (or the new approver) is still claimed before the approval workflow is told, so two approvers never decide one step, but a failed signal no longer leaves the request stuck. When the request's workflow no longer exists (timed out, terminated), the request is closed `CANCELLED` (nobody rejected it) with `statusReason` "The approval workflow is no longer running." and the route answers `409` with "The approval workflow is no longer running. The request was closed."; the approver's decision or delegate stays on the step. When Temporal cannot be reached, the claim is released (the step is `PENDING` again, a rejected request `PENDING_APPROVAL` again, a delegated step back with its approver) and the route answers `503` with "Your decision was not recorded: the approval workflow could not be reached. Try again in a moment." Before, the step stayed `APPROVED` or `REJECTED` while the request stayed `PENDING_APPROVAL` and nobody could decide it again. `.../delegate` now answers `400` "This approval step has already been decided" for a step decided meanwhile (it overwrote the approver). The approval queue shows these messages (it showed "Request failed with status code ...") and reloads after a decision or delegation that failed.
- A time-bound access request whose end date (`timeConstraint.expiresAt`) has passed when its last approval comes in is no longer provisioned: it ends `EXPIRED` with `statusReason` "The requested end date passed before approval completed." Before, it was provisioned and, the date being past, never revoked (workflow patch `access-request-approval:end-date-passed-before-approval`; a run whose last approval came before this release is unchanged).
- After a delegation the new approver gets one approval email (before: two). Workflow patch `access-request-approval:notify-delegate-once`.
- Access request documents (`GET /api/v1/access-requests`, `GET /api/v1/access-requests/:id`) carry the new optional `statusReason`, set only when EuroID closed the request in one of the cases above (a request the requester cancelled has none). The request page shows it ("Closed as CANCELLED" with the reason). `status` can be `FAILED`: a request whose approval workflow could not be started when it was created (stored before too, but missing from the schema and the UI colours).
- New domain event `access_request.closed` (`requestId`, `status`: `EXPIRED` or `CANCELLED`, `reason`; actor `system`), in the audit log, the tenant websocket and webhook subscriptions (selectable in the webhook form). No requester or approver in the payload.
- Metrics counted in MongoDB at each scrape of the API's `/metrics`: `euroid_access_requests_pending` (requests waiting for approval in all tenants; before, it rose on every new request and never came down), `euroid_identities_total` per `status` (profile status, a soft-deleted identity as `DELETED`) and `euroid_access_review_campaigns_active` (both were registered but never set, so always 0).
- `POST /api/v1/access-reviews/campaigns` (role: policy-admin): a `system` scope whose value names no known target system (a registered connector that provisions: `ad`, `discord-webhook`, `entra-id`, `file-outbound`, `github`, `google-sheets`, `okta`, `scim`, `servicenow`, under any of their names such as `entra` or `active-directory`) or no value is refused with `400` "Scope system "file" is not a known system. Known systems: ...". Activation selects the identities provisioned to the scoped system by the same name comparison the review items use, so `active-directory` now selects identities provisioned to `ad`, and a part of a name such as `file` no longer selects identities that then get no items. Campaigns stored before keep their scope; the create dialog shows the API's message.
- `POST /api/v1/leavers/batches/:id/approve`, `POST /api/v1/joiners/batches/:id/approve` and `POST /api/v1/movers/batches/:id/approve` (role: policy-admin) answer as soon as the batch is approved, before any run starts: the answer has no `startedCount` yet and lists the members `queued` (leavers; `superseded` when back in the feed), `waiting` (joiners) or `pending-approval` (movers). The runs start right after, one by one; the batch's `startedCount` is written when they have. Each start waits at most `HR_START_TIMEOUT_MS` (new, default `10000`; leaver starts from a sync too). A failed or timed-out start is kept for the source's next sync as before: a leaver stays `queued` with `startError`, a joiner stays `waiting` with `startError`, a mover item is `failed` and the change is detected again. A full sync also starts the members an approved mover batch left pending (an approval run that stopped; claims expire after `HR_START_CLAIM_TIMEOUT_MS`, new, default `600000`), and an approved joiner batch's members are ordinary waiting joiners for the next full sync. Before, with Temporal down an approval waited 30 to 45 seconds per member. The approval toast says "Starting N offboardings / onboarding runs / mover runs. The batch history shows each one as it starts, or why it does not." `leaver.batch_approved`, `joiner.batch_approved` and `mover.batch_approved` no longer carry `started`.
- A leaver offboarding start that timed out but ran is never started a second time: a later try counts the identity's offboarding that is running, or that finished after the leaver event's first attempt, as the event's (`identity.leaver_offboarding_started` with that workflow id).

### Fixed: orphan cleanups start at once, one orphan record per account, scheduled jobs run, outbox events are not lost or doubled

Fix round 2, package R5. Deploy the API and the worker together.

- `POST /api/v1/reconciliation/orphans/:driftId/signal` (role: operator): ADOPT and DELETE reach an orphan's cleanup during its grace periods. The daily reconciliation awaited each orphan cleanup (weeks) before it recorded the cleanup's workflow id on the drift, so the route answered `400 Orphan workflow not yet started`, the next orphan's cleanup did not start and the run stayed open, so no later daily run could start. The run now starts each cleanup under the drift's own workflow id (`t-<tenant>-orphan-cleanup-<driftId>`), records it at once and goes on (workflow patch `reconciliation:start-orphan-cleanup`); a drift whose cleanup already runs gets no second one. A run started before this release finishes the cleanup it waits for the old way, then starts the remaining ones without waiting.
- The same route when no cleanup runs for the drift (it ended, for example kept disabled after the extended grace, or never started): it starts a fresh cleanup run that applies ADOPT or DELETE at once, records its id on the drift and answers `{ success: true, message: "Signal <action> sent" }`. Before: `400 Orphan workflow not yet started`, or `500` once the cleanup had ended. A drift already `corrected` or `ignored` without a running cleanup answers `409`.
- `POST /api/v1/reconciliation/drifts/:id/ignore` and `POST /api/v1/reconciliation/drifts/:id/correct` (role: operator) on an orphan drift cancel its running cleanup first, so the account is no longer disabled (or deleted with `ORPHAN_AUTO_DELETE_AFTER_EXTENDED=true`) after the admin closed the drift. When Temporal cannot be reached the request fails and the drift stays as it was.
- One orphan record per account. A run records nothing new (no drift, no `orphan.detected`, no cleanup) for an account with an open (`open` or `quarantined`) orphan drift, whose latest orphan drift an admin ignored (an ignore is a decision: the account is not quarantined again), or whose cleanup still runs; for an open drift whose cleanup never started it starts one. Before, every run added a `quarantined` drift (`GET /api/v1/reconciliation/drifts?type=ORPHAN_ACCOUNT`, `orphans/stats`), an `orphan.detected` (audit log, websocket, webhooks) and a cleanup for each orphan it had already recorded. Duplicates recorded before stay.
- Scheduled jobs: the daily recertification scheduler, the intelligence batch (peer groups, reviewer quality) and the audit archive (`AUDIT_ARCHIVE_ENABLED=true`) run. Their schedules started workflow types the worker did not register.
- Domain events published through the outbox (`identity.created` from `POST /api/v1/identity` on a replica set): an event whose publishing process stopped after it claimed the event is published by a later poll once the claim is older than `OUTBOX_CLAIM_TIMEOUT_MS` (new, default `300000`, 5 minutes). Before, it was never delivered: no audit or timeline entry, no webhook, no onboarding run for `?triggerWorkflow=true`.
- A domain event delivered again (that outbox reclaim, or a dead-letter replay that re-emits the event) adds no second audit log entry, identity timeline entry or webhook delivery: each keeps one per event id (audit entries and timeline entries written for an event carry its `eventId`; a webhook delivery already holds it). Entries from before this release have no `eventId` and are not checked.

### Changed: no personal data in Temporal history (payload encryption, workflow ids, failure messages)

- The codec changes no route or response. The API's Temporal client and the worker encrypt every payload they send to Temporal (workflow inputs such as an onboarding's `targetEmail` and an offboarding's `userEmail`, activity arguments and results, signals, queries, memos, results) with AES-256-GCM under a key derived from `ENCRYPTION_KEY` (`backend/src/infrastructure/temporal/temporal-payload-codec.ts`). The Temporal UI and CLI show these payloads as `binary/encrypted` base64; search attributes (`TenantId`), ids and failure messages stay readable. Workflows started before the deploy run on (their payloads pass through).
- Workflow failure messages no longer name the person. Failure messages are not payloads, so the codec leaves them in clear (Temporal UI and CLI): a one-person onboarding for an address no identity has fails `UserNotFound` with "The requested person was not found in Hub" (it named the address), the mover's `IdentityNotFound` names the identity id in every run, and an offboarding started before the per-system results patch names `identity <id>` in its `OffboardingPartialFailure`. `POST /api/v1/onboarding/start` already answers `404` for an unknown address, so the API itself shows none of these.
- `POST /api/v1/reconciliation/user/:userId` (role: operator): `userId` must be the identity's `_id`; anything else, an email too, answers `400 Invalid ID format: <value>` and starts nothing. The value goes into the workflow id (`t-<tenant>-user-recon-<userId>-<ms>`), which Temporal stores in clear, and the lookup behind it also matched an email.
- Bulk provisioning validation names the operation, not the person: "Invalid email format in operation <id>" and the warning "Destructive operation on a VIP user in operation <id>" (they named the address). The workflow puts the error messages into its `ValidationFailed` failure message.
- `GET /api/v1/dev/workflows/:workflowId` (role: viewer, non-production only): step outputs still show (the service decrypts them with the API's client); a history with a payload the API cannot decrypt is shown without steps and the server logs the key id.
- Deploy the API and the worker together with the same encryption settings, and keep `ENCRYPTION_KEY_PREVIOUS` after a key rotation until every workflow started before it has closed (`backend/src/infrastructure/secrets/docs/ARCHITECTURE.md` § Temporal Payloads, `docs/DEPLOYMENT.md` § 1).

### Changed: the API uses the worker's Temporal namespace and mTLS; `trackingUrl` names that namespace

- The API starts, reads, signals and cancels workflows in the namespace `TEMPORAL_NAMESPACE` (default `default`), the one the worker and its schedules use; it used `default` whatever the setting, so with another namespace no workflow it started ever ran. It also connects with the worker's mTLS settings (`TEMPORAL_TLS_CERT_PATH`, `TEMPORAL_TLS_KEY_PATH`, `TEMPORAL_TLS_CA_PATH`), which only the worker read. All of it is read in `backend/src/infrastructure/config/temporal.config.ts`.
- `trackingUrl` in the responses of `POST /api/v1/onboarding/start`, `POST /api/v1/identity`, `PATCH /api/v1/identity/:id` (with `syncToEntra`), `DELETE /api/v1/identity/:id`, `POST /api/v1/bulk-provisioning/start`, `POST /api/v1/batch-provision/entra` and `GET /api/v1/batch-provision/status/:workflowId` is `<TEMPORAL_UI_URL>/namespaces/<TEMPORAL_NAMESPACE>/workflows/<workflowId>`; the namespace segment was always `default`. Unchanged with the default namespace.

### Fixed: a sign-in that must set up MFA stays on MFA setup, and its token reaches only MFA setup

- **Console, password sign-in in a tenant with `settings.mfaRequired`.** When `POST /api/v1/auth/login` answered `mfa_enrollment_token` for an admin without MFA, the sign-in page sent the new session to `/` before MFA setup opened, so the console went on to `/dashboard`, whose queries refuse the token (403), and the admin reached the setup only by opening Account security by hand. The session is now marked as enrollment-only (`mfaEnrollmentOnly` in the auth context): the sign-in page sends it to `/settings/security?mfa_enrollment=true`, and `MfaEnrollmentGate` shows that page without the menu and the top bar and sends every other signed-in route back to it. A single sign-on (`POST /api/v1/auth/saml/exchange`) gets the same page the same way. The page's "MFA Required" alert has [Sign out]; [Done] after the backup codes still signs the admin out, and the next sign-in asks for the MFA code.
- **One `POST /api/v1/auth/mfa/setup` per visit.** Each call stores a new secret. The page called it twice under React StrictMode (the status fetched twice re-ran the start); with two calls open, the QR code on screen matched the stored secret only if the answers came back in order. The setup route itself is unchanged: a second call still replaces the pending secret, so a secret someone else requested with the password is never handed to the admin.
- **The MFA enrollment token reaches only MFA setup (breaking for a client that used it elsewhere).** The token `POST /api/v1/auth/login` and `POST /api/v1/auth/saml/exchange` answer as `mfa_enrollment_token` was accepted by every route that needs no role, `POST /api/v1/auth/change-password` among them. `MfaEnrollmentScopeGuard` is now global (right after `JwtAuthGuard`) and accepts it only on `GET /api/v1/auth/me`, `GET /api/v1/auth/mfa/status`, `POST /api/v1/auth/mfa/setup` and `POST /api/v1/auth/mfa/verify-setup` (`@AllowMfaEnrollmentToken()`); `POST /api/v1/auth/logout` is public. Every other route answers `403` "This sign-in can only set up MFA. Finish the setup (POST /api/v1/auth/mfa/setup, then POST /api/v1/auth/mfa/verify-setup) and sign in again." Other tokens are unchanged: setup and verify-setup still refuse a token without a role that is not the enrollment token. Deploy: API only.
- **Console, single sign-on return.** `/auth/saml-callback` no longer runs the session check (`GET /api/v1/auth/me`) as the app loads. A 401 of that check could come after the code exchange had stored its tokens, and the refused check cleared them: an MFA enrollment token, which has no refresh token to recover with, was lost and the admin sent to `/login`. The code exchange alone decides the session on that page.

### Fixed: access request detail, approve, reject, cancel and delegate take the request id

- `GET /api/v1/access-requests/:id`, `PUT .../:id/approve`, `.../reject`, `.../cancel`, `.../delegate`: `:id` is the request's `requestId` (UUID), which the services look up and the portal sends. The routes validated a MongoDB ObjectId instead, so every one of them answered `400 Invalid ID format: <uuid>` and no request could be opened, decided or cancelled in the UI. An id that is not a UUID is `400`. Found in the browser check of 2026-11-24.

### Fixed: reconciliation stores its drifts, reads only complete target configs, names identities by id

Final sweep of the 2026-11-23 round (reconciliation).

- **Drift records from reconciliation.** The scheduled and the one-user reconciliation now store what they detect in `drift_records`, so `GET /api/v1/reconciliation/drifts` (role: viewer), its `drifts/stats`, the drift dashboard and the identity page's Drift tab show missing-account, field and status drifts (before: only orphans and hand-made records). One open record per identity (`userId` = the identity's `_id`), target system, type and field: a later run updates it and keeps `detectedAt`. An open drift a later run no longer finds in a system it read is closed `corrected` with `drift.resolved` `resolutionAction: "no_longer_detected"`; an auto-correction the run made closes its drift with `"reconciliation_auto_correct"`. An ignored drift stays ignored while the run finds the same values. `hubValue` and `targetValue` of PII fields are stored masked; a drift without a field stores `field: null`.
- **New:** `GET /api/v1/reconciliation/drifts/open-counts?userIds=<_id>,<_id>` (role: viewer): `{ success, counts: { <_id>: <open drifts> } }` for at most 100 identities, an identity without an open drift left out; 400 for no ids or more than 100. The Identity hub's Sync column reads it for the identities on the page (before: the tenant's 50 most recent drifts of any status).
- **Unreadable target systems.** An installed AD config without host or Root Base DN, a SCIM config without base URL, a target system without an installed connector config or a failed connector call is an error for that system's reconciliation, never "no account": no `MISSING_USER` is raised or auto-corrected for it, and the reason (e.g. `AD connector config is incomplete (empty: host): ...`) is in the detection result's new `systemErrors` (`GET /api/v1/reconciliation/result/:workflowId` of a one-user run) and once per batch in the batch result's `errors`. Orphan detection fails for such a system with the same message (an uninstalled system still has no orphans).
- **No email in drift ids and texts.** A `MISSING_USER` drift's description, the run's correction id (`<system>:<identity _id>:<type>`) and the batch result's `errors` (`identity <_id>: <reason>`) name the identity by id. `POST /api/v1/reconciliation/drifts/:id/correct` (role: operator) answers `400 Correction failed: User not found: identity <userId>` (it named the email) and finds the identity by the drift's `userId`, an older record's email as the fallback.
- **`orphan.detected` once per orphan** (audit log, websocket, webhooks): detection emits it; the orphan cleanup workflow no longer emits it a second time. An AD orphan's `externalId`, `accountIdentifier`, event aggregate (audit `resourceId`, webhook `aggregateId`) and drift `userId` are its objectGUID (`33221100-5544-7766-8899-aabbccddeeff`), no longer its DN, whose CN is the person's name.
- **Drift dashboard:** a drift row's [View] opens and closes the drift's details (it did nothing).
- **Active Directory values read whole.** The AD connector read every LDAP attribute as a list and took its first entry, but a single value comes as itself, so a single-valued mail, userPrincipalName, sAMAccountName, userAccountControl, pwdLastSet, cn or name was its first character. AD drift detection, orphan matching by UPN or mail, the account's enabled state, discovered group names (entitlement catalog, `POST /api/v1/connectors/ad/discover`) and the AD credential state now get the whole value.
### Fixed: access requests and access reviews (final sweep)

Final sweep of the 2026-11-23 round. Deploy the API and the worker together.

- Access request approval: a decision that arrives before its step starts waiting (while the approver is being notified, or for a later step while an earlier one still waits) counts for that step, never for another. Before, it was dropped, the step timed out and the request was `REJECTED` although the stored step said `APPROVED`. Runs started before this release keep the old behaviour (workflow patch `access-request-approval:buffer-step-decisions`).
- A time-bound access request expires on its `expiresAt` (requests run up to 730 days). Before, its access was revoked and the request marked `EXPIRED` after 90 days. A run already waiting its 90 days keeps that (workflow patch `access-request-approval:expire-on-date`).
- SoD policies match an operation's system as the policy engine names systems (`entra` and `entra-id` are one system, `active-directory` and `ad` are one), and an operation on target `all` matches a policy on any system. Before, the names were compared exactly, so policy grants on `all` or on the legacy `active-directory` passed SoD policies on `entra-id` or `ad`: onboarding, mover, access request and preview checks can now block or warn where they did not. `POST /api/v1/sod-policies` refuses an entitlement listed twice under two names of one system with `400`.
- Onboarding gives Entra ID the non-admin directory roles a policy assigns (`assign_role`) together with its groups and licenses; each is reported applied, unchanged or failed like the other Entra ID changes. Active Directory still gets groups only: the AD connector has no directory roles.
- `GET /api/v1/identity/:id/entitlements` and `GET /api/v1/identity/:id/offboard-impact`: an access request counts for the identity the access is for (`targetIdentityId`; a request stored without one counts for its requester). A manager's requests for a direct report no longer show as the manager's access or offboarding impact.
- `GET /api/v1/identity/:id/entitlements`: a request grant of a time-bound request carries `expiresAt` (ISO 8601). The entitlement map's policy trace shows it on any identity's map; before, the map read `GET /api/v1/access-requests` (the viewer's own requests) and showed no request's time constraint on another identity's map.
- Access review campaigns with scope `system` review only that system's access: its group memberships, or the account item of a target without readable memberships. Before, every access the selected identities had in every system was put up for review (and removed on a revoke). The scope value is compared as the policy engine names systems (`entra` reviews `entra-id`); other scopes review all access, as before.
- New domain event `access_review.membership_revoked` (`identityId`, `campaignId`, `itemId`, `targetSystem`, `groupId?`, `outcome`, `detail?`, `reason?`; actor: the reviewer who revoked the item): the removal of a revoked group membership at campaign close, in the audit log (resource: the identity), webhook subscriptions and the identity timeline ("Group membership removed after access review: entra-id", "No group membership left after access review: ...", "Group membership to remove by hand after access review: ...", "Group membership removal after access review failed: ..."). `groupId` is the group's id in the target; the event carries no group name.

### Fixed: no email in onboarding, offboarding, invite, access request, PAM, escalation and orphan events

Final sweep of the 2026-11-23 round. These domain events reach the audit log (`payload.metadata` of the entry), the tenant websocket and the dead-letter store; none carries an address now:

- `identity.provision_requested`: no `email` (`{ syncToEntra?, reason? }`, the identity is the aggregate). The onboarding handler reads the address from the identity; one without an email starts no run, as before.
- `identity.offboard_requested`: no `userEmail` (`{ userId, reason? }`). The offboarding handler reads the address from the identity by `userId`.
- `invite.created`: no `email` and no `tenantId` (`{ roles, createdBy, expiresAt }`; the audit entry and the event metadata carry the tenant), so its audit entry no longer names the invitee; `GET /api/v1/auth/invites` (role: super-admin) still lists the address.
- `access_request.created`: no `requesterEmail`; `requesterId` only when the requester has an identity (it was the email otherwise).
- `admin_account.created`: no `adminEmail` (`{ parentIdentityId, adminTier }`, the admin identity is the aggregate).
- `access_review.item_escalated`: no `originalReviewer` or `escalatedTo` (`{ itemId, campaignId, daysOverdue }`). The "overdue items reassigned to you" mail still goes to the item's new reviewer, read from the item.
- `orphan.detected`: `accountIdentifier` is the account's id where it is opaque (Entra ID object id, SCIM id), else the UPN or mail masked (`a•••@corp.example`, an AD account); it was the UPN or mail in clear.

`invite.created`, `access_request.created`, `admin_account.created` and `access_review.item_escalated` now have a payload schema: a key outside it is dropped before any handler, audit entry or websocket sees it. Webhook deliveries are unchanged (their body carries ids only). The workflow log lines of onboarding, offboarding, PAM admin account provisioning and orphan cleanup (worker output) name the identity by id, an orphan by its drift id, never by email or phone number. No endpoint or DTO changed.
### Fixed: who gets a mover run, timeline entries for PAM, mover and bulk, rehire leavers

Final sweep of 2026-11-23 (provisioning and mover).

- **`GET /api/v1/identity/:id/access/preview`** (role: viewer) and **`POST /api/v1/identity/:id/access/re-evaluate`** (role: operator): a target system counts as provisioned by the mover's own rule: SYNCED once, until a deprovision, also while a later run there is in `ERROR`. `provisionedTargets` lists such systems, and an identity whose only system is in `ERROR` after a failed mover run can be re-evaluated (it got 409 "not provisioned to any target system"). An entry onboarding never got to SYNCED (no account written back) still does not count. The same rule now decides whether an HR sync gives the identity a mover run (`POST /api/v1/connectors/:name/ingest`, `movers`) and whether an edit (`PATCH /api/v1/identity/:id`) starts the mover or onboarding.
- **Identity timeline** (`GET /api/v1/identity/:id/events`): onboarding adds "Not provisioned to `<target>`: not configured" (type `USER_PROVISIONED`, severity `warning`) for a target it left out because nothing is configured for it (Entra ID without a config). PAM admin account provisioning, the mover's Entra ID change and bulk operations (Entra ID) now put "Provisioned to `<target>`" or "Provisioning failed to `<target>`" on the identity's timeline: their `provisioning.completed` / `provisioning.failed` (audit log, websocket, webhooks) go under the identity id with `identityId`, no longer under the connector name. Bulk runs started before the deploy keep the connector name.
- **Re-provisioning after a deprovision**: an offboarding, an expiry, an access review revoke or a target closed as removed manually sets the provisioning entry's `writebackComplete` to `false` (identity responses, `provisioning[]`), so a later provision writes the new account id back (Okta, SCIM, AD and Entra ID kept the removed account's id). Entries deprovisioned before the deploy keep `true`.
- **HR leavers**: a rehire who leaves again with the same HR status word and no end date is detected and offboarded (it was taken for the first departure). Its leaver event key ends with `:rehired:<rehiredAt>`; identities never rehired keep their keys.
- **Offboarding workflow memo** (Temporal UI, describe, `GET /api/v1/dev/workflows`): `targetDescription` is `Offboarding: identity <id>` instead of the email.
### Fixed: identity merges with accounts, two Primary HR sources, a former employee's email, the manual department control

Final sweep of the 2026-11-23 round (identity).

- **A merge is refused while the identity it would merge away has an account.** `POST /api/v1/identity/:id/resolve-conflict` with `merge` and `POST /api/v1/identity/:id/link` (role: operator) answer `409` with nothing changed while that identity has an account in a target (provisioned and not deprovisioned since, the rule the mover uses; File outbound, Google Sheets and Discord webhook keep no account and do not count): "Identity `<id>` still has an account in entra-id, ad, so nothing was changed. Delete that identity first (its offboarding removes the accounts), then merge again." The merge used to soft-delete it while its accounts stayed with no identity owning them. Once `DELETE /api/v1/identity/:id` has offboarded it, `resolve-conflict` merges it (it answered `409` "no longer exists" before): its records join the kept identity, it keeps its deletion and gets the released email. The kept identity no longer takes the merged identity's links to the accounts EuroID provisioned for it (target sources holding a provisioning entry's account id). An incoming identity that another merge took still answers `409` "no longer exists (merged into another identity, or removed)". The uncorrelated queue lists live identities only, so an identity offboarded first can be merged only through the conflict of the identity it matched.
- **Two HR sources both tagged Primary give every identity the same primary HR source.** With both Design studio source nodes (or installed connectors) tagged `PRIMARY`, or both HR sources `primary-hr` because no connector is the configured primary, `metadata.primaryHrSource` was the source that minted the identity, so the profile values (the primary wins every field no source masters) differed from person to person. The tie now goes to the lower ingest priority, then the earlier source in Recon Config `sourcePriorityOrder`, then the source name. An existing identity changes at its next reconcile (a sync of either source, a writeback, a controls change): profile values can change without new data, and a changed mover trigger attribute starts a mover run.
- **Design studio, HR source drawer**: Save Config now saves Ingest Priority, Contract Tag and Field Mastery with the source node (`config.ingestPriority`, `config.contractTag`, `config.masteryFields`); they were dropped, so the canvas never carried them. A node saved after the deploy carries the drawer's values, by default `ingestPriority: 1` and `contractTag: 'PRIMARY'`, and its mastery fields make that source the owner of those fields at its next ingest. The drawer warns while another source node is also tagged Primary.
- **A former employee's email can go to a new hire.** The unique index `{ tenantId, profile.email }` on `identities` covers live identities only (partial over `deletedAt: null`). An HR row whose email only a soft-deleted identity has is minted (it failed on the index at every sync, so each run was partial; `POST /api/v1/connectors/:name/ingest` now counts it in `ingested`). A row that matches a soft-deleted identity only by email (the email rule, or a source key that is the email) and carries an employee number that identity's records do not is a new person: minted, not revived as a rehire. A rehire takes the row's email. Deploy: run `npm run migrate:up` (the Dockerfile does this on start): `20261123000001-identity-email-unique-among-live` replaces the old index under the same name; rerunning is safe; `down` refuses, changing nothing, while an email is shared.
- **`PATCH /api/v1/identity/v2/:id/controls`** (role: operator): a `manualDepartment` that changes the department acts as a department edit through `PATCH /api/v1/identity/:id`. The HR contract the policies evaluate takes it until HR sends another department (`metadata.manualOverrides`), and `identity.updated` (`changedFields: ['departmentName']`, `previousAttributes`, `source` the admin's email) starts the mover run, or onboarding for an identity not provisioned yet. Clearing it (`''`) goes back to the HR department the same way. The identity used to match both departments and nothing removed the old department's access. The response is unchanged.
- **`identity.created`** is also sent for identities minted by onboarding's and bulk provisioning's Golden Record write and by `POST /api/v1/batch-provision/seed`: `identityId`, `sourceSystem` and `status` only. Their timeline starts with "Created via `<source>`".
- **Design studio, Brain > Identity Correlation > Field Mastery**: the "Default" column shows the tenant's default mastery from Admin > Recon Config (`GET /api/v1/admin/reconciliation-config`, policy-admin) in priority order, "None: primary HR source" for a field without one, and "Recon Config (policy-admin)" for a role that cannot read it. It showed a frontend list the backend does not use.
- **Identity page**: a refused save shows the API's message (for example "Masked values cannot be saved: ...") instead of "Request failed with status code 400".
- Deploy: API and worker together (the worker's onboarding and bulk activities send `identity.created`), with the migration above. The OpenAPI descriptions of `resolve-conflict`, `link` and `controls` changed: regenerate the spec.
### Fixed: honest connector results and events, Okta config, connector page errors

Final sweep of the 2026-11-23 round (connectors).

- **AD onboarding and admin account provisioning**: a group change Active Directory refuses fails the AD target (provisioning entry `ERROR`, `provisioning[].errorMsg` names each failed change and its reason, user DN names and emails masked) instead of `SYNCED` with the group missing, after the other changes were made. The intent's group removals are applied (they were ignored). `provisionUserToAd` returns `operations` (applied, unchanged or failed per change), as Entra ID does.
- **Entra ID provisioning** (onboarding, mover, `PATCH /api/v1/identity/:id?syncToEntra=true`, access requests): an identity with a written-back Entra object id is provisioned on that account alone. When Entra ID no longer has it, the run fails with "No Entra ID account has the object id recorded for the identity (...)" (not retried) instead of creating a second account; the mover reports Entra ID `failed` with that reason.
- **Okta**: an installed Okta connector config without `orgUrl` or `apiToken` fails every Okta call with 400 "Okta config is incomplete (empty: ...)" and its health check (`POST /api/v1/connectors/okta/health-check`, onboarding) is false; it no longer falls back to the `OKTA_*` environment variables (the deployment's own org). A tenant without an installed Okta config still uses them.
- **Events** (audit log, websocket, webhook subscriptions): AD, SCIM, GitHub and ServiceNow provisioning emits `provisioning.completed` and `provisioning.failed` under the identity id, so these targets show "Provisioned to `<connector>`" or "Provisioning failed to `<connector>`" on the identity timeline (`GET /api/v1/identity/:id/events`). No email or name; AD's event has no `targetUserId` (the DN holds the person's name). SCIM failures thrown to Temporal have emails masked (`scim: ...`).
- **New event `provisioning.deprovisioned`** (`identityId?`, `connector`, `targetUserId?`, `detail?`): emitted when a connector's deprovision removed an account (Entra ID deletion by offboarding, entitlement expiry, access review, orphan cleanup or bulk delete; AD, Okta, SCIM, GitHub and ServiceNow deprovision). It is recorded in the audit log (`resourceType: provisioning`); it adds no timeline entry. Orphan cleanup and bulk delete deletions were not audited before.
- **Connectors page and Design studio** (no API change): a refused install, uninstall or save shows the API's own message and the page keeps what it had; a failed `GET /api/v1/connectors` (the 503 of a stored config this process cannot decrypt included) shows an error with the API's message and Retry, not the connectors with empty settings.

### Fixed: a joiner's timeline, identity ids instead of emails in events, failure reasons

Plan 2.8a.

- **Identity timeline** (`GET /api/v1/identity/:id/events`, role: viewer). After an HR sync a joiner's history shows: "Created via `<source>`" (the sync that minted the identity), "Onboarding started by HR sync", "Policy evaluated" (type `POLICY_EVALUATED`: the policies that matched and the operation count of the evaluation onboarding provisioned from) and one entry per target: "Provisioned to `<target>`", for Discord webhook, Google Sheets and File outbound too (description: what the target did, such as "no account: line appended to the outbound file"), or "Provisioning failed to `<target>`" with the reason. Before, only the start was recorded: entries for Entra ID and Okta went under the email and the other events were not sent. Deleting an Entra ID account (offboarding, expiry, an access review revoke, bulk delete, orphan cleanup) no longer adds "Provisioned to entra-id"; offboarding, expiry and access review record what they removed as before.
- **`identity.created`** (audit log, websocket, webhook subscriptions) has no `email`, and `sourceUserId` is present only when the caller of `POST /api/v1/identity` gave one (it was the email otherwise). An HR sync now sends it for every identity it mints (`sourceSystem` the HR source, no `sourceUserId`). The new-identity notification in the console names the source instead of the person.
- **`POST /api/v1/identity`** (role: operator) without `sourceUserId` no longer stores the email as the profile's `sourceUserId`; `GET /api/v1/identity/:id` shows none for such an identity. Correlation is unchanged (the source key still falls back to the email).
- **`provisioning.completed`, `provisioning.failed` and `policy.evaluated`** go under the identity's id: the audit entry's `resourceId` was the person's email for onboarding runs (and for Entra ID deletions a masked email). When the caller passed a profile without an identity id (bulk rows, PAM admin accounts, the mover's policy profile) the event goes under the connector name (`entra-id`, `okta`, `ad`, `file-outbound`...) or `policy-engine`, with no `identityId`. `provisioning.completed` has no `generatedAttributes` (the new account's mail and UPN), `targetUserId` is absent for a target that keeps no account, and `detail` is new. The `error` of `provisioning.failed` from Okta and AD has emails (and AD DN names) masked. `policy.evaluated` has `forProvisioning: true` for the evaluation a workflow provisions from.
- **Onboarding and PAM admin account provisioning**: a target's provisioning entry in `ERROR` (`provisioning[].errorMsg` in identity responses) says why, with the activity's own masked reason, instead of "Activity task failed".
- **Leaver batches** (`GET /api/v1/leavers/batches`, `POST /api/v1/leavers/batches/:id/approve`, role: policy-admin): each item has `startError` when its offboarding could not start (it stays `queued`; the next sync tries again), as joiner items have. The approval toast gives that reason and the batch history shows it on the member's status.
### Changed: HR joiners include rehires and wait on an unreadable start date; JSON API HR maps start dates

Plan 2.8c.

- A rehire an HR sync revives (an active row of a deleted identity, starting after the deletion) is an HR joiner of that source: `POST /api/v1/connectors/:name/ingest` (role: connector-admin, operator) counts it in `joiners.detected` and onboards it like a minted identity (deployed pipeline, mass-joiner limit, start date). Its revival closes the provisioning entries of the earlier employment (`DEPROVISIONED`, `writebackComplete` false; a target that keeps no account, which offboarding left `SYNCED`, too), so the identity page shows them revoked until onboarding provisions them again. `identity.joiner_onboarding_started` gains `rehire?: true` (timeline "Rehired in the <source> sync."). Rehires revived before the deploy stay with [Provision].
- JSON API HR maps `start_date`, `startDate`, `hire_date` and `hireDate` to `startDate` by default, and a custom `fieldMap` entry with the target `startDate` is honoured (it was ignored), so its joiners wait for a start date ahead like CSV HR's.
- A start date that is not a date (CSV HR `Start Date`, JSON API HR) no longer fails the row: the row is ingested without it, the sent text kept in `customAttributes.startDateUnreadable`, and the sync stays full (`errors` no longer lists the row). The person's joiner waits, also at a batch approval, until a sync reads a date or an operator provisions by hand. New domain event `identity.joiner_onboarding_waiting` (`{ identityId, joinerEventId, sourceName, reason: 'start-date-unreadable' }`, actor `system:hr-sync`), emitted once: audit log, webhooks, timeline "Onboarding waits: start date unreadable".
- Deploy: run `npm run migrate:up` (`20261123000000-joiner-events-one-per-hire`: one joiner per identity and hire) with the API and worker; until it runs, a rehire whose identity already has a joiner is not recorded.

### Fixed: a record no correlation rule matches, with an email an identity has, is held for review

Plan 2.8c. A record that matched no correlation rule (rules without `email`, or another employee number) while a live identity had its email was minted and failed on the unique email index at every sync, so each run was partial. It is held on that identity's conflict like a low-confidence match whose email is taken: `POST /api/v1/connectors/:name/ingest` counts it in `rowsHeldForConflictReview`, and `GET /api/v1/identity/conflicts` lists the identity with `conflictDetails.matchedBy: 'email'`, `confidence: 0` and the record in `incomingSource` (Merge adds it). The 409 message of a held record reads "This record's email is already used by an identity and no correlation rule matched it with confidence, ...".

### Fixed: a manual department or job title edit removes the old department's access

Plan 2.8c. After `PATCH /api/v1/identity/:id` (role: operator) changed the department, the policies still evaluated the HR contract with the old department, so the identity matched both and the mover added the new access without removing the old. The edited value now replaces the HR value it replaced in that contract (`metadata.manualOverrides`) until HR sends another value; the access preview, re-evaluation and the edit's mover run remove the old department's access. The next HR sync of the source still sets the profile back to the HR value, as before.
### Fixed: sign-in, sessions and encryption key rotation (final sweep)

- **SAML auto-provisioning.** The first SAML sign-in of an unknown user (`SAML_AUTO_CREATE_USER`) failed on `Path passwordHash is required` and `POST /api/v1/auth/saml/callback` redirected to `/login?saml_error=...`. It now creates the admin with `authSource: 'saml'` and no password hash. `GET /api/v1/auth/users` is unchanged.
- **SAML and a tenant that requires MFA.** For an admin without MFA in a tenant with `settings.mfaRequired`, `POST /api/v1/auth/saml/exchange` answered a full session (`access_token`, `refresh_token`, cookies) next to `mfa_enrollment_required`. It now answers what `POST /api/v1/auth/login` answers: `{ mfa_enrollment_required: true, message, mfa_enrollment_token, user }`, a 5-minute token that can only set up MFA, with no session and no cookies. Frontend: both sign-in pages (`LoginPage`, `SamlCallbackPage`) now read `mfa_enrollment_token` (`LoginResponseSchema`), keep it in memory as the access token without a refresh token, and open Account security's MFA setup (`/settings/security?mfa_enrollment=true`, `frontend/src/auth/mfa-enrollment.ts`). Before, `LoginPage` dropped the token, so the setup failed with no token, and `SamlCallbackPage` expected the old session shape. When the setup is done ([Done] after the backup codes) the admin is signed out and signs in again, now with the MFA step.
- **`POST /api/v1/auth/change-password`** answers `409` "This account signs in through single sign-on and has no EuroID password to change." for a single sign-on account (it was a 500).
- **`POST /api/v1/auth/revoke/:userId`** (role: super-admin) answers `400` `Invalid ID format: <id>` for an id that is not an ObjectId (it was a 500).
- **Websocket `/events`.** A connection is accepted on the checks `JwtAuthGuard` applies to an API request (signature, issuer, audience, an active admin whose `tokenVersion` is current; OIDC tokens as before), and only for a token with a role. A revoked session, a deactivated admin and an MFA enrollment token are disconnected; before, any unexpired local token received the tenant's events. A connection that is already open stays open until it reconnects.
- **Encryption key rotation (deploy note, no API shape change).** The API and the worker refuse to start when `ENCRYPTION_KEY_PREVIOUS` is set and `ENCRYPTION_KEY_ID` is unset, `default` or equal to `ENCRYPTION_KEY_PREVIOUS_ID` (the previous key took the `default` id, so new secrets were written under the old key and lost once it was removed), when `ENCRYPTION_KEY_PREVIOUS` does not decode to 32 bytes, and when a key id contains `:`. `backend/src/scripts/rotate-encryption-key.ts --generate` prints a key id with the key; the script now also re-encrypts `admin_users.mfaSecret`, `event_subscriptions.webhook.signingSecret` and `rollback_snapshots.ciphertext`, refuses (writing nothing) when a stored secret does not decrypt, and says when `ENCRYPTION_KEY_PREVIOUS` can be removed. Steps: `backend/src/infrastructure/secrets/docs/ARCHITECTURE.md` § Key Rotation.

### Changed: access reviews certify the account in targets without readable memberships

Plan 2.8b. A campaign reviewed group memberships in Entra ID, AD, Okta and SCIM only, so access in GitHub, ServiceNow, File outbound, Google Sheets and Discord webhook was in no review, and a campaign scoped to such a system completed with 0 items.

- `POST /api/v1/access-reviews/campaigns/:id/activate` (role: super-admin) adds, for every other target the identity has an account in (its provisioning entry is provisioned and not deprovisioned since, the rule the mover uses), one review item for the account itself: `entitlements: [{ system: '<target>', type: 'account', name: 'Account', accountId?, policyManaged }]`. `GET /api/v1/access-reviews/campaigns/:id/items`, `GET .../items/:itemId` and `GET .../my-reviews` (role: viewer) return them.
- Revoking one removes the account when the campaign closes, through offboarding's per-target deprovision (GitHub removes the organization membership, ServiceNow deactivates the user), for campaigns activated after the deploy (workflow patch `access-review:account-revocation`). `entitlements[].revocation.outcome`: `removed`; `already-gone` (no such account any more, a target that keeps no account with `detail` "keeps no account (notification or log target)", or the identity offboarded or its entry deprovisioned since the review); `manual-action-needed` (a target with no deprovision); `failed` with the reason. Counted in `revocationSummary`. The identity's provisioning entry becomes `DEPROVISIONED` when the account is removed or gone, as at entitlement expiry.
- New domain event `access_review.account_revoked` (`identityId`, `campaignId`, `itemId`, `targetSystem`, `outcome`, `detail?`, `reason?`; actor: the reviewer who revoked the item): the audit log (resource: the identity), webhook subscriptions and the identity timeline ("Account removed after access review: github", "No account left after access review: file-outbound", "Account to remove by hand after access review: ...", "Account removal after access review failed: ...").
### Fixed: SoD policies are enforced on every path (plan 2.9)

- **Access requests are checked against the access the person holds now.** `POST /api/v1/access-requests` and `POST /api/v1/access-requests/pre-check-sod` count, besides the requested entitlements and the person's groups and licenses from role-based rules, their directory roles from those rules, what the rules give their linked admin account, and the entitlements of their other requests that are `ACTIVE` (not past `expiresAt`) or `PROVISIONING`. Pending, rejected, cancelled, expired and revoked requests do not count. A request for side B of a Block policy after an earlier request gave side A is refused (`400` with `sodViolations`, as for any Block match). Before, earlier requests were not counted, so the two sides could be asked for in two requests.
- **Re-check before fulfilment.** When the last approval comes in, the request is checked again against what the person holds at that moment. A Block match rejects it: `status` becomes `REJECTED` and `sodCheckResult` becomes `{ passed: false, violations: [...] }` with the matches found then. This closes two pending requests for the two sides of a policy both being fulfilled; if both final approvals come in at the same moment, at least one is rejected. `GET /api/v1/access-requests/:id` shows it.
- **`sodCheckResult.violations[].action`** (`BLOCK` or `WARN`) is new on `GET /api/v1/access-requests`, `/:id` and `/pending-approvals`. Requests stored before have no `action`; every match stored with `passed: true` is a Warn match. The request page shows the Warn matches to the approvers and a rejection's conflict.
- **One type for directory roles.** A requested Entra ID directory role (catalog type `DirectoryRole`) is the operation type `role`, as the policy engine and the Entra connector name it, so a request for a directory role is fulfilled and revoked (it failed with `Entra ID has no "directoryrole" operation`) and an SoD policy naming a role with type `role` matches it. SoD policies stored with type `directoryrole` (or `DirectoryRole`) still match: types are compared through that mapping. No migration.
- **Admin-account entitlements are SoD-checked.** Entitlements the policy engine gives a linked admin account (privileged access) are part of the SoD check of onboarding, mover runs, bulk creates and access requests, and count in the risk score's SoD factor. Before, they were left out.
- **`POST /api/v1/sod-policies`** (role: policy-admin, super-admin) answers `400` when `conflictingEntitlements` lists one entitlement twice (system and type compared case-insensitively, a directory role as `role`, the id exactly): `conflictingEntitlements.<n>: repeats conflictingEntitlements.<m> (same system, type and id). List each entitlement once: ...`. Such a policy matched anyone who held that one entitlement.
- **Onboarding.** A Block conflict fails that person's policy step without retry; the person is not provisioned, their timeline gets "Onboarding refused by a segregation of duties policy" with the policy names, the rest of the batch is onboarded, and the run then fails (`SoDViolation`) naming the refused identity ids. Before, the step was retried without limit and the run, with every later person, waited there.
- **`GET /api/v1/access-explorer/identity/:id/sod-violations`** (role: viewer) reads the tenant's active SoD policies from MongoDB (the policies of `/sod-policies`) and reports each policy whose every entitlement the identity reaches in the access graph; it answered an empty list for every real policy (it read graph nodes nothing wrote). Each violation gains `action` and `conflictingEntitlements` (`[{ entitlement, path }]`, every entitlement of the policy with its shortest path); `entitlementA`/`entitlementB` and `pathToA`/`pathToB` are the policy's first two.

### Fixed: Golden Record mastery: the primary HR source wins, and a field's master sets the field

The Golden Record (`profile` in `GET /api/v1/identity/:id`, the identity lists, the values provisioning and the policy engine read) is computed by these rules again, as `identity/docs/MULTI_HR_INGESTION.md` (Survivorship Rules) describes them:

- A secondary HR source supplements. For a field that is neither contract-critical nor mastered (names, email, location, phone, custom attributes key by key) it writes only where the primary HR source carries no value, so the primary's value wins whatever the order of ingestion. Before, every HR source overwrote and the primary was merged first, so with two HR feeds the lowest-priority one won these fields.
- A field's master writes it. When `metadata.mastery`, the Brain's Field Mastery (`fieldMasteryOverrides`) or the tenant's `defaultMastery` names a source for a field, the first listed source that has a value replaces the Golden Record value, a target such as Entra ID included, and no other source changes the field. While no master has a value, another source may fill the field when it is empty. Before, a target master only filled an empty field, so once the first HR record had set it nobody could change it, and the order of a `defaultMastery` list was not used.
- Contract-critical fields stay with the primary HR source (or the source `metadata.mastery` names), as before; dropped fields are cleared as before, and a target never clears a field.

Which email survives a conflict merge (`POST /api/v1/identity/:id/resolve-conflict` with `merge`, `POST /api/v1/identity/:id/link`) follows: the email's master, else the primary HR source's email. No API shape changes and no migration: each identity is recomputed at its next sync or writeback, so for a tenant with two HR sources or a target-mastered field, profile values can change without new data (a changed mover trigger attribute such as `location` can start a mover run).
### Changed: onboarding workflow ids name the identity, events carry no email

Plan 2.0dn: email addresses are no longer used as ids or carried by these events.

- **Onboarding workflow id.** A per-person onboarding run has the id `t-<tenant>-onboard-<identityId>` (was `t-<tenant>-onboard-<email>` with `@` and `.` replaced). The all-users run keeps `t-<tenant>-onboard-all`. This is the `workflowId` and `trackingUrl` in the answers of `POST /api/v1/onboarding/start`, `POST /api/v1/identity?triggerWorkflow=true` and `PATCH /api/v1/identity/:id?syncToEntra=true` (role: operator), in `identity.joiner_onboarding_started` and on the HR joiner items. Ids already stored (joiner events, audit entries, Temporal history) stay as they were. While a run started under the old id is still open, a start for the same person answers as an onboarding run already in progress, naming that run's (old) id.
- **`POST /api/v1/onboarding/start`** (role: operator) answers `404` with "No identity has this email. Create the identity or run an HR sync first, then start onboarding." for an email no identity of the tenant has. Before, it started a run that failed in Temporal (`UserNotFound`).
- **The onboarding run's memo and audit entry** (`PROVISIONING_EXECUTED`, `resourceName`, `description`) name the identity by id (`Onboarding: identity <id>`), not by email.
- **`identity.updated`** has no `email` (`GET /api/v1/audit` entries, the analytics search and the tenant websocket showed it). In `previousAttributes` an old `managerEmail` is masked (`m•••@example.com`); the field still shows the manager changed. **`identity.move_requested`** masks it the same way.
- **`entitlement.expired`, `entitlement.expiring_soon` and `entitlement.expiring_tomorrow`** have no `email`. Webhook deliveries are unchanged: their body carries ids only.
### Fixed: the mover retries a failed system, moves an edit from the access baseline, and makes the Entra ID sync an edit asks for

- Mover runs (any trigger): a system whose provisioning entry was SYNCED without `writebackComplete` (provisioned before the onboarding patch `onboarding:writeback-until-complete`) and whose mover run failed there was reported "No account" by the next run, which completed and advanced the access baseline, so that system's change (possibly the removal of the old department's access) was never retried. A system now counts as provisioned once provisioned, also while a later run there is in ERROR, until a deprovision. Provisioning entries carry `provisionedAt`: when the target first reported the account provisioned, `null` after a deprovision, absent on an entry no write has touched since this change; identity responses that return `provisioning` show it. Existing data needs no migration: an entry that is SYNCED, has `writebackComplete`, or is in ERROR with the account id the target wrote back counts; one that went to ERROR before this change with none of these counts as never provisioned, as before.
- `PATCH /api/v1/identity/:id` changing Department, Job Title, Location or Manager of a provisioned identity (role: operator): the mover run's "before" is now the access baseline's values of the changed attributes, as for HR-sync and re-evaluation runs. Before, it was the values the edit replaced, so with a change not yet applied (a paused or rejected HR batch, a failed run) the access granted for the baseline's value stayed and no longer showed in `GET /api/v1/identity/:id/access/preview`. An identity without a baseline keeps the values the edit replaced.
- `PATCH /api/v1/identity/:id?syncToEntra=true` when it starts the mover (role: operator): the run now updates the Entra ID account also when it changes no access there, so the sync happens without a second request and without an onboarding run. `workflow` keeps its shape; `workflowType: 'mover'` names the run that carries the sync. Timeline: "Access updated: entra-id" with "The edit asked for a sync to Entra ID: the account was updated with the current attributes; its access needed no change.", or "No account: entra-id" when the identity has no Entra ID account. Workflow patch `mover:sync-to-entra`; the mover workflow input has an optional `syncToEntra`. The sync needs the API and the worker of this version: a worker without the patch ignores the flag, as before.

### Fixed: a connector config the server cannot decrypt is kept and answers 503

A read of a stored connector config that the reading process could not decrypt (another `ENCRYPTION_KEY`, a key id missing from its key ring) deleted the config and went on with an empty one, so one misconfigured API or worker process erased the connector credentials of every tenant it served, on any read: `GET /api/v1/connectors`, a status check, the readiness probe. Such a read now changes nothing and answers `503` with a message that names the connector and the key settings to check: `GET /api/v1/connectors`, `PATCH /api/v1/connectors/:name`, `POST /api/v1/connectors/:name/health-check`, `/ingest` and `/discover`, `GET /api/v1/connectors/:name/status` and `/sync-status`, and any route or job that uses that connector. `POST /api/v1/connectors/:name/ingest` answered `200` with `success: false` and "Data synchronization failed" for this case; it now answers the `503` and still records the failed run. `GET /api/v1/reconciliation/connector-health` lists that connector as `down` with the same message. `GET /api/v1/health/ready` reads no connector config. If the key the config was saved with is lost, a connector-admin replaces the config with `POST /api/v1/connectors/:name/install` and the full config, or removes it with `DELETE /api/v1/connectors/:name`.

### Fixed: GET /connectors/:name/sync-status shows only the last run

`lastSyncError` of an earlier run stayed after a sync without row errors (an error stored before row errors were masked kept its clear-text email addresses), and `lastSyncCount` of an earlier run stayed after a failed one. A run now removes what it does not report: `lastSyncError` is `null` after a clean sync, `lastSyncCount` is `null` after a failed run.
### Changed: GET /reconciliation/drifts filters by identity; bulk-correct says what it could not correct

- `GET /api/v1/reconciliation/drifts` (role: viewer) takes `?userId=`: the drifts of one identity, by the drift's `userId` (the identity's `_id`; an orphan drift's `userId` is the target account id). 1 to 200 characters, else `400`. The identity page (Drift tab and badge, Profile drift indicators, identity map) now asks for `?userId=<_id>&status=open&limit=100`, all pages, instead of picking the identity's drifts from the tenant's 50 most recent drifts of any status.
- `POST /api/v1/reconciliation/drifts/bulk-correct` (role: operator) answers `{ success, corrected, failed, failures }`. `corrected` is the count as before. New: `failed` (count) and `failures`, one `{ driftId, error }` per requested drift that was not corrected: `Drift <id> not found`, `Drift <id> is <status>, not open`, or the reason `POST /reconciliation/drifts/:id/correct` answers with `400` for that drift. `success` is `false` when no drift was corrected and at least one failed (it was always `true`, also with `corrected: 0`). A duplicated id is handled once. The status stays `201`.
- `POST /api/v1/reconciliation/drifts/:id/correct` answered `400` `Correction failed: Unknown error` when nothing could be done for the drift; it now names why: `Correction failed: Correction of <type> is not supported for system: <system>`, or `Correction failed: The user was not found in entra-id`.
### Added: console admin password reset

- `GET /api/v1/auth/password-reset/config` (public): `{ byEmail, tokenTtlMinutes }`; `byEmail` is true when `SMTP_HOST` is set.
- `POST /api/v1/auth/password-reset/request` `{ email }` (public): `202 { message }`, the same message for every address, answered before any lookup or mail. An active admin account that signs in with a password gets a mail with `<FRONTEND_URL>/reset-password#token=<64 hex>` while SMTP is on. `429` above `PASSWORD_RESET_MAX_PER_IP` (default 10) per IP or `PASSWORD_RESET_MAX_PER_EMAIL` (default 3) per address within `PASSWORD_RESET_WINDOW_MINUTES` (default 15); `503` while the security state store is down.
- `POST /api/v1/auth/users/:id/password-reset` (role: super-admin): `201 { token, expiresAt }`, a one-time code for an admin of the caller's tenant, shown once (only its hash is stored). `400` your own account, `403` a platform admin, `404` not an admin of the caller's tenant, `409` a single sign-on or deactivated account.
- `POST /api/v1/auth/password-reset/confirm` `{ token, newPassword }` (public): `200 { success, message }`. Sets the password with the change-password rules, ends every session (`tokenVersion`, refresh token), signs nobody in, keeps MFA. `400` for an invalid, used or expired token (one message) or a password that breaks the rules or was used recently; `429` per IP; `503` while the store is down. A token lasts `PASSWORD_RESET_TOKEN_TTL_MINUTES` (15 to 60, default 30) and is void once a newer one is issued or the password changes (`POST /api/v1/auth/change-password` included).
- New events `admin_user.password_reset_requested` `{ adminUserId, mailSent }`, `admin_user.password_reset_issued` `{ adminUserId, issuedBy, expiresAt }` and `admin_user.password_reset_completed` `{ adminUserId }`: never the token, code, password or address.

### Added: console admins: role change, last sign-in, pending invites

- `PATCH /api/v1/auth/users/:id` (role: super-admin) accepts `role`: `super-admin`, `connector-admin`, `policy-admin`, `operator` or `viewer` (anything else is `400`). Your own role is `400`, a platform admin's `403`, demoting the tenant's last active super-admin `409`. Audited as the new event `admin_user.role_changed` `{ adminUserId, previousRole, newRole, changedBy }`. The role applies from the admin's next request: `JwtAuthGuard` now takes the role of a local token from the database instead of the token's `roles` claim (a scoped MFA enrollment token keeps none), so `GET /api/v1/auth/me` answers the current role too.
- `GET /api/v1/auth/users` answers `lastLoginAt` (ISO, `null` until a sign-in records it), set by every sign-in that issues a session: a password sign-in (after its MFA step when MFA is on) and SAML. A token refresh does not set it.
- `GET /api/v1/auth/invites` (role: super-admin): the caller tenant's unused, unexpired invites, newest first, `[{ id, email, role, createdBy, createdAt, expiresAt }]`. Never the code or its hash.
- `DELETE /api/v1/auth/invites/:id` (role: super-admin): cancels a pending invite of the caller's tenant, `{ success: true }`; its code no longer registers anyone (`401`). Another tenant's, a used or an expired invite is `404`, an id that is not one `400`. Audited as the new event `invite.cancelled` `{ roles, createdBy, cancelledBy, expiresAt }` (no code, no email).

### Changed: admin and invite refusals

- `POST /api/v1/auth/revoke/:userId` and `PATCH /api/v1/auth/users/:id` answer `404` for any id that is not an admin of the caller's tenant, a platform admin's included. Before, another tenant's super-admin got `403` for a platform admin's id, which told them the id was on `PLATFORM_ADMIN_USER_IDS`.
- `POST /api/v1/auth/invites` answers `409` for an address that has an admin account in the caller's tenant. An address with an account in another tenant is still accepted, so the inviter learns nothing about other tenants: `POST /api/v1/auth/register` answers it `409` "This email address already has an admin account. Sign in with it instead." (was "Email already registered"), and the invite stays pending until it expires.

### Changed: POST /policy-suggestions/analyze says which analyzers did not run

`POST /api/v1/policy-suggestions/analyze` (role: super-admin) answers `{ analyzed, suggestionsCreated, skipped }`. `skipped` is new: one `{ analyzer, reason }` per analyzer that did not run, for example `birthright` and `orphan` with `Entra ID is not configured for this tenant` (both read group memberships from Entra ID). Before, such a run answered `{ "analyzed": 0, "suggestionsCreated": 0 }`, the same as a run that found nothing. `analyzed` is unchanged: the number of candidate suggestions found, not of identities read.

### Fixed: a POST, PUT or PATCH without a body is read as an empty body

A request without a body to a route whose body fields are all optional (for example `POST /api/v1/policy-suggestions/:id/dismiss`) answered `400` with `": Required"`. It is now handled as `{}`. A route with required body fields still answers `400`, now naming the missing fields.

### Fixed: GET /blueprints/pipeline-status and the Deploy readiness check read the stored pipeline config

`GET /api/v1/blueprints/pipeline-status` answered a `config` up to 5 seconds old after an impact analysis, deploy, pause, resume or stop, and a Deploy within 5 seconds of an impact analysis answered `422` with `Impact analysis has not been run`. Both now read the stored canvas.

### Fixed: correlation conflicts and the uncorrelated queue can be resolved

- `POST /api/v1/identity/:id/resolve-conflict` with `merge` and `POST /api/v1/identity/:id/link` (role: operator) failed with a validation error (the merged sources lost their fields), and once past that with a duplicate-key `500` whenever the merge gave the kept identity the incoming identity's email, after the sources were saved: the kept identity stayed half-merged and the conflict open. A merge now ends fully merged with the conflict closed, or with nothing changed and `409` (`400` above the 50-source limit) whose message says why: another identity has the merged email, the incoming identity no longer exists, the conflict stores no incoming record, the held record now belongs to another identity, or an identity changed meanwhile. The merged-away identity is soft-deleted as before and its `profile.email` becomes `merged-<id>@released.invalid`, so the kept identity can take the address. Which email survives is decided by the survivorship rules (the email's master, else the last HR source in the merge order). `link` also closes the target's conflict about the linked identity. Answers keep their shape.
- `POST /api/v1/identity/:id/create-standalone` answered success and stored nothing; the identity now leaves `GET /api/v1/identity/uncorrelated`.
- An HR record matching an identity with low confidence whose email an identity already has no longer fails with a duplicate key on every sync. It mints nothing and is held on the matched identity's conflict (`metadata.conflictDetails.incomingSource`, listed by `GET /api/v1/identity/conflicts`); `merge` adds it as a source, `split` answers `409` (it cannot become an identity of its own), `dismiss` clears the flags until its next sync. `POST /api/v1/connectors/:name/ingest` answers a new count `rowsHeldForConflictReview`; such rows are neither `ingested` nor `errors`. `POST /api/v1/identity`, bulk and batch provisioning answer `409` for such a record.
- Console: the uncorrelated queue's link modal button [Skip / Ignore] is [Close] (it never recorded anything); the conflict card shows the API's reason when a resolution is refused.
### Added: admins retry or close expired access the expiry run could not remove

Two routes next to the identity's other access routes (tenant and actor from the token, body validated, other fields `400`). Both act only on a provisioning entry that is not `DEPROVISIONED` and has an `expiryFailure` for its current `expiresAt`, and answer that entry after the change.

- `POST /api/v1/identity/:id/access/expiry/retry` (role: operator): body `{ targetSystem }`. Clears `expiryFailure`, so the next hourly `entitlementExpiryWorkflow` run tries to remove the access again (fix the cause first). Emits `entitlement.expiry_retry_requested` `{ identityId, targetSystem, expiresAt, failureReason }` (audit log with the operator as actor, identity timeline, webhooks).
- `POST /api/v1/identity/:id/access/expiry/removed-manually` (role: policy-admin, like `POST /api/v1/leavers/offboardings/:workflowId/removed-manually`: it asserts a removal EuroID cannot verify; an operator gets `403`): body `{ targetSystem, reason }` (`reason` required, at most 500 characters). For access the admin removed in the target by hand: the entry becomes `DEPROVISIONED` and `expiryFailure` is cleared. Emits `entitlement.expiry_removed_manually` `{ identityId, targetSystem, expiresAt, reason, failureReason }`; the timeline says "removed manually", never removed by EuroID.
- `404`: identity not found in the tenant, or no provisioning entry for `targetSystem`. `409`: no failed expiry on the entry (none, one for an earlier expiry date, already `DEPROVISIONED`) or it changed meanwhile, with the reason in `message`.
- The identity page's Access tab shows each failed expiry (target, expiry date, reason, next attempt) with [Retry removal] for an operator and also [Mark removed manually] for a policy-admin.

### Fixed: expiry removes Okta, GitHub and ServiceNow access, and counts an account already gone as removed

The hourly `entitlementExpiryWorkflow` removed expired access only in Entra ID, AD and SCIM; an expired Okta, GitHub, ServiceNow or other entry was recorded as a non-retryable `expiryFailure` and the access stayed. It now removes the access with the per-target deprovision offboarding uses, for every target offboarding deprovisions, with the account id from the identity's account record (target sources only, as offboarding reads it). As in offboarding:

- An account the target no longer has counts as removed: AD "no such object" (before: retried forever with a warning each time) and a SCIM 404 (before: parked with the timeline saying the access stays), like the Entra ID 404 before.
- Entra ID without a stored object id: a 404 for the email as UPN is followed by a lookup by mail; no user found is a failure to check (before: counted as removed). SCIM, Okta, GitHub and ServiceNow without a stored id look the account up as offboarding does; AD without a distinguished name is a failure.
- A target that keeps no account (Discord webhook, Google Sheets, File outbound) has nothing to remove: the entry becomes `DEPROVISIONED` (before: a failure).
- A target with no deprovision is a non-retryable failure whose reason says to remove the access by hand and mark it removed manually (see the entry above).
- Domain event `entitlement.expired`: `outcome?: 'deprovisioned' | 'already-gone' | 'not-applicable'` and `detail?` (new); the timeline title follows it ("no account left", "the target keeps no account").
- The workflow code is unchanged (no patch); the change is inside its activity.
### Fixed: webhook and dead-letter retries run once however many processes poll; filters.severityMin applies

Every API replica and every Temporal worker runs the webhook retry poller and the dead-letter automatic retry. Two processes polling at once posted the same webhook twice and re-ran the same dead-letter entry twice. Each delivery and each entry is now taken with one conditional update before it is re-run, so one process re-runs it.

Webhook deliveries (`GET /api/v1/event-subscriptions/:id/deliveries`, role: super-admin):

- `status: "PENDING"` (the page's "Sending") now also while a retry is being sent (it stayed `FAILED` during a retry). The `nextRetryAt` of a `PENDING` delivery is the end of its sender's lease (`WEBHOOK_DELIVERY_LEASE_MS`, default 60000, must be longer than `WEBHOOK_DELIVERY_TIMEOUT_MS`).
- A delivery whose send never finished (the process stopped) stayed `PENDING` and was never retried. Once its lease has run out the retry poller sends it again; the interrupted send counts as an attempt (`lastError`: `The send was interrupted before the receiver answered (the process sending it stopped). It counts as an attempt.`), so it follows the retry schedule and is dead-lettered after the last attempt.
- A delivered delivery, and one out of attempts, no longer carries `nextRetryAt` (the last scheduled retry time stayed).
- A retry that falls due while the subscription is paused, or no longer names the event, is no longer rewritten with `lastError: "Subscription no longer active"` on every poll: it keeps the receiver's last error, its attempts and its retry time, and is sent after a resume. Fifty such deliveries no longer stop the retries of active subscriptions, which are sent oldest due first. Deliveries of a deleted subscription are never sent, as before.
- `filters.severityMin` (`LOW`, `MEDIUM`, `HIGH`, `CRITICAL`) was stored and answered but did nothing. An event whose payload carries a lower `severity` is now not delivered to that subscription: `drift.detected` (`LOW` to `CRITICAL`) and `anomaly.detected` (`low` to `critical`; case is ignored). An event type without a severity, or with one outside that scale, is always delivered.
- The body never carries an email address: an id (`aggregateId`, `payload.identityId`, `policyId`, `campaignId`, `driftId`, `anomalyId`) whose value holds one is left out of the body. `PolicyEngineService.evaluate` sends `policy.evaluated` with the email as `aggregateId` and `identityId` for a profile without `_id` (the mover evaluates profiles so).

Dead-letter entries (`POST /api/v1/dead-letter/:id/retry`, `POST /api/v1/dead-letter/:id/replay`, `POST /api/v1/dead-letter/batch-retry`, role: super-admin):

- An entry another admin or the automatic retry is re-running right now is `409` with `Dead-letter entry <id> is being retried right now, or was just retried, by the automatic retry or an admin. Reload it to see where it is.` and nothing runs (before, it ran a second time). `batch-retry` counts such an entry under `failed`.
- A replay holds the entry as `retrying` while it runs (it stayed `pending`); a failed replay puts it back to `pending` with its retry time and `lastRetryError`, not counted, as before.
- While an entry is `retrying`, its `nextRetryAt` is the end of the lease (`DLQ_RETRY_LEASE_MS`, default 300000). A re-run not finished by then (the process stopped) is taken again by the automatic retry and counts as a failed retry (`lastRetryError`: `The previous retry did not finish (the process running it stopped); it counts as a failed retry.`); before, the automatic retry re-ran every `retrying` entry whose old retry time had passed, also one still running.
- An entry dismissed while its retry runs stays `dismissed` (the retry's outcome reopened it as `replayed` or `pending`). An entry a retry or replay closes as `replayed` or `failed_permanently` no longer carries `nextRetryAt`.

Deploy: the API and the worker run these pollers and must be deployed together: a process of the previous version still re-runs without claiming. New env vars (optional): `WEBHOOK_DELIVERY_LEASE_MS`, `DLQ_RETRY_LEASE_MS`. New index on `webhook_delivery_attempts`: `{ subscriptionId: 1, status: 1, nextRetryAt: 1 }`.
### Fixed: Entra ID group, directory role and license changes that were not made showed as done

A group or directory role change Microsoft Graph refused was logged and dropped, a group name no Entra ID group has was skipped, and a license `remove` was ignored, so onboarding marked Entra ID `SYNCED`, the mover's timeline said "Access updated: entra-id" while the old access could still be there, and access requests counted as fulfilled or revoked without the change. Now every requested change is applied, already as requested, or failed with its reason; licenses are also removed (`assignLicense` with `removeLicenses`). A failed change fails Entra ID for the run after the other changes were made (they stay made): onboarding and admin-account provisioning mark the target `ERROR`, the mover reports "Access update failed: entra-id" with the reasons, access-request fulfilment and revocation count Entra ID as failed, and the identity timeline gets "Provisioning failed to entra-id" (`provisioning.failed` with `partialFailure: true`, emails masked) instead of "Provisioned to entra-id". When onboarding created the account in that run, the account is written back to the identity before the target is marked `ERROR`, so the next run updates it (workflow patches `onboarding:entra-created-account-writeback` and `admin-account-provisioning:entra-created-account-writeback`). An operation of a type Entra ID does not handle (e.g. an access request for a `DirectoryRole` catalog entitlement, sent as type `directoryrole`) now fails instead of being ignored. No API shape changes; deploy the API and the worker together.

### Fixed: Entra ID configuration and client errors were retried five times

`provisionUserToEntra`, `disableEntraUser` and `enableEntraUser` rethrew every error, so an incomplete or missing Entra ID config, refused credentials or a Graph 4xx was retried per `CONNECTOR_RETRY` (5 attempts, 5 `provisioning.failed` events) before onboarding, the mover, bulk provisioning or reconciliation saw it. They now fail at once (`ApplicationFailure.nonRetryable`, as offboarding does); a 429 waits its retry-after and a 5xx or no answer is still retried. Their failure messages start with `entra-id:` and have email addresses masked.

### Changed: GET /batch-provision/health/diagnostics checks the tenant's Entra ID config

`GET /api/v1/batch-provision/health/diagnostics` (platform admin) ran its Entra ID connection, license and domain checks only when the `ENTRA_*` variables were set, although those checks run on the tenant's installed Entra ID connector config when there is one; a tenant on its own config got `NOT_CONFIGURED`. The checks now run on the config the tenant's Entra ID calls use, named in the new field `entra.configSource`: `tenant-connector`, `environment` (`ENTRA_*`) or `none` (nothing checked, `NOT_CONFIGURED`). `entra.configured` is true for either config, and `message` names the tenant's connector config when that is the one checked. `keysCheck` still describes the `ENTRA_*` variables only.

### Fixed: POST /auth/invites answered 500 for a super-admin without a database id

`POST /api/v1/auth/invites` (role: super-admin) answered `500` (`input must be a 24 character hex string`) when the caller's id was not an `admin_users` id: a super-admin who signs in through OIDC (the id is the identity provider's subject), the emergency admin, and the dev user under `AUTH_DISABLED`. It now answers `201` with the code for every super-admin. The invite stores its inviter (`createdBy`) as the caller's id in text; no answer changed shape.

### New: GET /auth/users lists the tenant's admin users

`GET /api/v1/auth/users` (role: super-admin, like the other admin routes) answers the admins of the caller's tenant, the people who sign in to the console, sorted by email: `[{ id, email, name, role, isActive, mfaEnabled, authSource, isPlatformAdmin, createdAt }]`. `id` is the admin's `_id`, the id `POST /auth/revoke/:userId` and `PATCH /auth/users/:id` take. `authSource` is `local` (password) or `saml`. `isPlatformAdmin` is true for an account named in `PLATFORM_ADMIN_USER_IDS`. Emails are not masked: only a super-admin of the same tenant gets them. Nothing that signs anyone in or proves a second factor is read or answered: no password hash or history, MFA secret or backup codes, refresh token hash or token version. Another tenant's admins are never listed. No route lists pending invites.

### Fixed: a super-admin cannot deactivate themselves or act on a platform admin

- `PATCH /api/v1/auth/users/:id` (role: super-admin) with `{ isActive: false }` for the caller's own id is `400` with `You cannot deactivate your own account. Another super-admin can.` and changes nothing. No route changes a role, so this was the one way the last super-admin could leave a tenant with nobody able to reactivate anyone. Another admin of the tenant is deactivated and reactivated as before.
- `POST /api/v1/auth/revoke/:userId` and `PATCH /api/v1/auth/users/:id` (role: super-admin) on an account named in `PLATFORM_ADMIN_USER_IDS` are `403` (`This account is a platform admin, managed through the deployment configuration (PLATFORM_ADMIN_USER_IDS), not by a tenant role.`) and change nothing, unless the caller is that account: a platform admin can still revoke their own sessions. Before, a super-admin of the platform admin's tenant could sign the deployment's operator out or deactivate the account.

### Changed: webhook subscriptions answer no secret or header value, refuse a name in use (409) and unsafe headers (400); deliveries follow no redirect

All `/api/v1/event-subscriptions` routes (role: super-admin).

- **Answer shape (breaking):** list, get, create and update no longer answer `webhook.signingSecret` (the ciphertext) or `webhook.headers` (the custom headers with their values). `webhook` is now `{ url, headerNames: string[], hasSigningSecret: boolean }`. No other field changed; `__v` is no longer answered.
- **Editing headers (breaking for clients that sent a partial map):** `PATCH .../:id` with `webhook.headers` still replaces the whole set of custom headers. A header sent as `null` keeps its stored value, so a client can keep a value it is never answered; a stored header left out is removed; `null` for a header that is not stored is `400`. Without `webhook.headers` the headers stay as they are.
- **Name in use:** `POST` with a name another subscription of the tenant has answered `201` with that subscription unchanged (the new URL and secret were dropped). It is now `409` `A webhook subscription named "<name>" already exists.` A `PATCH` renaming onto a used name answered `500`; it is now the same `409`.
- **Header rules:** a custom header name must be an HTTP token, without `.` and not starting with `$`, and cannot be `Host`, `Content-Type`, `Content-Length` or start with `X-EuroID-` (case ignored); names that differ only in case are one header; a value holds at most 2000 characters and no line break. Otherwise `400` with the field path (`webhook.headers.<name>: ...`). Names with `.` or a leading `$` answered `500` before; reserved names were stored and replaced the signature or `Content-Type` on delivery.
- **Deliveries:** EuroID's headers (`Content-Type`, `X-EuroID-Signature`, `X-EuroID-Event`, `X-EuroID-Delivery`) are set after the custom ones. A subscription stored earlier with a header these rules refuse is not delivered: the attempt fails with `Not sent: the subscription's custom header "<name>" ... Edit the subscription's headers.`, is retried and dead-lettered like any failure, and the test answers `success: false` with that error. Edit the headers to resume.
- **Redirects:** event deliveries and dead-letter retries no longer follow redirects (the test already did not): a `3xx` answer is a failed delivery with `The receiver answered with a redirect (<status>). Deliveries do not follow redirects: use the URL it redirects to.`
- **Where a delivery connects:** the host is resolved when the connection is made, and the connection goes only to addresses the SSRF guard allows; a host that resolves to a private, loopback, link-local, metadata or reserved address fails with `Refused to connect to <host>: ...` (the address is not named), also when it resolved to a public one when the subscription was saved. The stored URL is checked again before each POST (`Not sent: Webhook URL refused: ...`). No proxy from the environment (`HTTPS_PROXY`) is used for deliveries.
- **SSRF guard** (also JSON API HR, SCIM, Entra `@odata.nextLink`, AD host): every address is parsed and IPv6 forms that embed an IPv4 address (IPv4-mapped `::ffff:7f00:1`, IPv4-compatible, NAT64 `64:ff9b::/96`, 6to4 `2002::/16`) are judged by that IPv4 address; `::`, carrier-grade NAT, multicast, broadcast, documentation, benchmarking and other reserved ranges of both families are refused, as are `localhost` and `*.localhost`. `https://[::ffff:127.0.0.1]/`, `https://[::ffff:169.254.169.254]/` and `https://[::]/` were allowed before. The reverse also changed: a sign error refused every IPv4 address from 128.0.0.0 up, public ones included (for example `140.82.112.3` or a host resolving to `151.101.1.69`), so such webhook URLs and connector hosts were refused; they are allowed now. Host names are resolved like the connection resolves them (getaddrinfo, `/etc/hosts` included). The JSON API HR client connects through the same checked lookup.

### Fixed: a refused webhook URL is 400

`POST /api/v1/event-subscriptions` and `PATCH /api/v1/event-subscriptions/:id` (role: super-admin) with a webhook URL the SSRF guard refuses (not https, or a host that is or resolves to a private, loopback, link-local or cloud metadata address) answered `500 Internal server error`. They now answer `400` with `Webhook URL refused: it must use https, and its host must not be or resolve to a private, loopback, link-local or cloud metadata address.` The message does not name the address the host resolves to. Nothing is stored.

### Fixed: POST /event-subscriptions/:id/test sends a test delivery

`POST /api/v1/event-subscriptions/:id/test` (role: super-admin) answered `{ success: true, message: "Test delivery queued ..." }` without sending or queuing anything. It now posts one signed test body to the subscription's URL, whatever the subscription's status, and answers how the receiver took it: `{ success, subscriptionId, deliveryId, eventType: "webhook.test", httpStatus?, error?, message }`.

- `success` is true only for a 2xx answer. A refused or unreachable receiver is still `201`, with `success: false`, the receiver's `httpStatus` (absent when it could not be reached) and `error`.
- The body carries ids only: `{ eventId, eventType: "webhook.test", timestamp, aggregateId: <subscription id>, payload: {} }`, signed like every delivery (`X-EuroID-Signature`, `X-EuroID-Event`, `X-EuroID-Delivery` = `deliveryId`, plus the subscription's headers).
- The test is not stored as a delivery attempt: it is not retried, not dead-lettered and not listed by `GET /api/v1/event-subscriptions/:id/deliveries`.
- It does not follow redirects: a `3xx` answer is `success: false` with an error saying so. Event deliveries no longer follow them either (see the entry above).
- Another tenant's subscription is `404`, as before.

### Added: HR-driven joiner

An HR sync now onboards the people it adds: after leaver and mover detection, each identity the sync minted is recorded as a joiner and, once the tenant's pipeline is DEPLOYED, gets one onboarding run through the existing path (`identity.provision_requested` -> `OnboardingService.triggerOnboarding`, actor `system:hr-sync`, memo `reason: joiner:hr-sync:<source>`; the workflow input is unchanged). Before Deploy, while the pipeline is paused or stopped, on a partial sync and until an HR start date (CSV HR `Start Date`) is reached, the joiners wait; the next full sync of the source starts them. A person HR marks as left (a terminated status word, an end date that is over, an HR leaver event) is never onboarded. A sync above the mass-joiner limit (the smaller of 10 and 5% of active identities, at least 2) starts nobody and waits for an admin, so a company's first import needs an approval. Re-ingesting the same export starts nothing. Design: `backend/src/modules/joiners/docs/ARCHITECTURE.md`.

- `GET /api/v1/joiners/batches?status=pending|approved|rejected`: newest 50 joiner batches, each `{ id, sourceName, status, identityCount, allowance, activeIdentityCount, createdAt, decidedBy?, decidedAt?, comment?, startedCount?, items: [{ joinerEventId, identityId, displayName, email?, departmentName?, jobTitle?, status: waiting | pending-approval | started | rejected | superseded, workflowId?, closeReason?, startError? }] }` (role: policy-admin)
- `POST /api/v1/joiners/batches/:id/approve`: body `{ comment? }` (strict); `409` while the pipeline is not DEPLOYED (the batch stays pending) and when already decided, `404` for another tenant's batch; re-reads each member and starts its onboarding (the admin as actor), closing as `superseded` anyone who left in HR, was deleted or is onboarded already (role: policy-admin)
- `POST /api/v1/joiners/batches/:id/reject`: body `{ comment? }`; no later sync onboards the members (role: policy-admin)
- `GET /api/v1/joiners/policy`, `PUT /api/v1/joiners/policy`: per-tenant `{ massJoinerMaxCount, massJoinerMaxPercent, massJoinerMinCount }`; `configured: false` while on the defaults (env `JOINER_MASS_MAX_COUNT`, `JOINER_MASS_MAX_PERCENT`, `JOINER_MASS_MIN_COUNT`); a floor above the count or an unknown field answers `400` (role: policy-admin)
- `POST /api/v1/connectors/:name/ingest`: the response gains `joiners: { kind: 'joiner-sync-summary', sourceName, fullSync, detected, started, pending, waiting, startFailed, closed, pipelineStatus?, pausedBatchId? }` when joiner detection ran
- Domain events: `identity.provision_requested` accepts `reason?` (kept in the onboarding workflow memo); new `connector.hr_sync_joiners_requested` (the `connector.hr_sync_completed` payload, emitted after mover detection), `identity.joiner_onboarding_started` (`{ identityId, joinerEventId, sourceName, workflowId, batchId? }`, identity timeline "Onboarding started by HR sync"), `joiner.batch_paused`, `joiner.batch_approved`, `joiner.batch_rejected` (`{ batchId, sourceName, identityCount, limit?, activeIdentityCount?, started?, comment? }`) and `joiner.policy_updated` (`{ changedFields }`), all audited
- `GET /api/v1/blueprints/pipeline-status`: `status` is read from the stored canvas, so right after Deploy, Pause or Resume it is the new status (it could be the old one for up to 5 seconds); `config` still comes through the 5 s blueprint cache
- UI: the Governance page "Leavers and movers" is now "Joiners, movers and leavers" (route `/leavers` unchanged) with a tab HR joiners

### Fixed: the write-back's identity.updated and policy activation's policy.updated keep their fields

The write-back after a target created an account (onboarding, admin-account provisioning) emitted `identity.updated` without `changedFields`, which the payload schema requires. Outside production the write-back activity therefore failed after its write and Temporal retried it; in production the event was dead-lettered, so neither the timeline nor the audit log recorded the write-back. Policy activation sent `previousStatus`, which the `policy.updated` schema dropped.

- Domain event `identity.updated`: a write-back now emits `{ identityId, changedFields, source: 'writeback', targetSystem, email }` with event depth 1. `changedFields` names the attributes written to the target's source entry (`objectId`, `mail`, `userPrincipalName`, `email`, ...), and `targetSystem` (new, optional) is the connector. Neither the mover nor onboarding starts a run for it. The event reaches the audit log, the analytics index, the tenant websocket (`system` room) and the identity's timeline (with the target system); webhook bodies still carry only `identityId`.
- Domain event `policy.updated`: `POST /api/v1/policy/:id/activate` now sends `previousStatus` (new, optional: the status it was activated from, `draft` or `disabled`). Who activated the policy is the event's actor, which the audit entry records as `actor`; it is not in the payload (the `activatedBy` key the schema dropped is gone). Websocket payloads gain `previousStatus`; webhook bodies still carry only `policyId`.

### Fixed: anomaly and policy-suggestion routes take the public id; anomaly changes and analysis say what happened

- `GET /api/v1/anomalies/:id`, `POST /api/v1/anomalies/:id/acknowledge`, `.../dismiss`, `.../resolve`: `:id` is the anomaly's `anomalyId` (UUID), the id `anomaly.detected` and `anomaly.resolved` carry; it used to be answered `400 Invalid ID format`. The document `_id` (ObjectId) is still accepted, because the Risk dashboard of the previous release sends it. Any other value is `400`; another tenant's anomaly is `404` by either id. The Risk dashboard now sends `anomalyId`.
- Same three `POST` routes (role: operator): open can be acknowledged, resolved or dismissed; acknowledged can be resolved or dismissed; resolved and dismissed are final. Any other change, repeating a final one included, is `409 Conflict` with a message naming the current status (`Anomaly <anomalyId> is resolved and cannot be acknowledged.`, `Anomaly <anomalyId> is already dismissed.`); it changes nothing and emits no event. Before, any status moved to any other: a resolved anomaly acknowledged again kept its `resolvedAt`, and a dismissed one could be resolved and emitted a second `anomaly.resolved`. Of two simultaneous changes only one is applied.
- `POST /api/v1/anomalies/analyze` (role: super-admin): the answer adds `totalIdentities` (for a run without `identityId` the tenant's identities that are not deleted, otherwise 1 for a found identity and 0 for none) and `ruleFailures: { rules, identities, byRule }` (distinct rules that threw, identities with a failed rule, and per rule, keyed by anomaly type, the identities it failed for). A rule that throws no longer counts as "nothing found": the other rules and identities still run, and the cause is logged with email addresses masked. The orphan-access rule reports an Entra ID failure the same way (it used to return "nothing found"); without an Entra ID config it is skipped, not failed. `page` is 1-based, as validated: `page: 1` used to skip the first page. One run still covers one page (default 50 identities), because each identity costs about twenty policy evaluations and two Entra ID calls inside the request.
- `GET /api/v1/policy-suggestions/:id`, `POST /api/v1/policy-suggestions/:id/accept`, `.../dismiss` (role: viewer; accept and dismiss policy-admin): `:id` is the `suggestionId` (UUID), which the Policy suggestions page sends; the routes validated an ObjectId instead, so Accept and Dismiss always answered `400 Invalid ID format`. An ObjectId or any other value is `400`; another tenant's suggestion is `404`. Accept still answers the accepted suggestion; its `resultingPolicyId` is the draft policy's id, and the page now goes to Role-based rules on it.

### Fixed — an operator's edit of a trigger attribute starts the mover

`identity.updated` reached its handlers without `previousAttributes`: the payload schema did not declare it and zod drops undeclared keys. So `MoverEventHandler` returned on every edit, and an edit of Department, Job Title, Location or Manager of a provisioned identity started onboarding (which skips SYNCED targets) instead of the mover: old access stayed. The schema now carries `previousAttributes`, and the mover and onboarding handlers decide on the same rule (role: operator):

- `PATCH /api/v1/identity/:id` — when the save changes the value of `departmentName`, `jobTitle`, `location` or `managerEmail` and the identity has a SYNCED target, the mover starts once (trigger `attribute-change`) and onboarding starts no run. An identity without a SYNCED target gets onboarding, as before. A trigger attribute sent with its current value (the identity page sends every field) starts no mover.
- `PATCH /api/v1/identity/:id?syncToEntra=true` — in that same case the PATCH starts the mover instead of the onboarding sync, never both (two runs must not change the same identity's access at once). `workflow` has a new field `workflowType`: `'mover'` or `'onboarding'`, also on failures; for the mover `{ triggered: true, workflowType: 'mover', workflowId: 't-<tenant>-mover-<identityId>', trackingUrl }`, or with `triggered: false` and `error: 'A mover run for this identity is already in progress; ...'` while one runs (no onboarding run starts then). The mover updates the Entra ID account's attributes only where it changes that account's access: request the sync again when the mover run has finished if the attributes must reach Entra ID too.
- Domain event `identity.updated` — `previousAttributes` holds the before-values of the access attributes whose value the update changed only, `null` for one that had none; names, contact data and identifiers are left out (before, the masked before-value of every field written). The event reaches the audit log, the analytics index and the tenant websocket; webhook bodies still carry only `identityId`.
- Domain event `identity.move_requested` (new, `emitAndWait`) — `{ identityId, changedFields, previousAttributes }` from the PATCH above; `MoverEventHandler` answers the mover workflow id, or `undefined` when the mover does not apply. `identity.updated` with `syncToEntra` starts no mover run.

### Fixed — onboarding leaves out an Entra ID that is not configured

Since the default canvas's Entra ID node became an onboarding target, every onboarding run of a tenant with no Entra ID config failed at the Entra ID health check (`HealthCheckFailed`) before any user was fetched, so no target was provisioned. Now an Entra ID with no canvas config, no installed Entra ID connector config and no `ENTRA_*` is left out of the run: no health check, no provisioning, no provisioning entry, and the other targets are provisioned. The workflow result ends with `Skipped entra: not configured.`, and with `No target left to provision.` after that when Entra ID was the only target (workflow patch `onboarding:entra-not-configured`). The Entra ID health check now runs on the Entra ID node's canvas config, as provisioning does; before, it ran without one, so a tenant whose Entra ID credentials were only in the Design studio node failed every onboarding run. An Entra ID that is configured but unreachable, refuses the credentials or has an incomplete config still fails the run. No endpoint or DTO changed.

### Security — Entra ID calls without a canvas config use the tenant's own Entra ID config

No endpoint or DTO changes. Entra ID calls made without a canvas config (access-review gathering and revocation, bulk provisioning and its rollback, distributed transactions, reconciliation and drift correction, orphan detection and cleanup, access-request fulfilment, anomaly detection, policy suggestions, credential management, onboarding batch tooling) always used the deployment's `ENTRA_*` app registration, so in a deployment with several tenants they read and changed that Entra tenant for every EuroID tenant. They now run on the current tenant's installed Entra ID connector config, and on `ENTRA_*` only when the tenant has installed none. Access reviews and policy suggestions count a tenant with an installed config as configured even without `ENTRA_*`.

- An Entra ID config with an empty tenant id, client id or client secret (canvas or installed) is a `400` configuration error naming the empty fields; before, each empty field was filled in from its `ENTRA_*` variable, so a config with a tenant id and no secret signed the deployment's app in to that tenant. An installed config counts even when incomplete: uninstall it to use `ENTRA_*`.
- A failed Entra token request is `401` only when the token endpoint refuses the credentials (a 4xx other than 429). A 5xx answer or no answer is a `502` connector error, which offboarding and access-review revocation retry, and a 429 waits its retry-after; before, every token failure was a non-retryable `401`, also on endpoints, where the frontend may take it for a lost session.

### Fixed — field mastery overrides apply; correlation conflicts reach the review

A Brain config with `fieldMasteryOverrides` (`connectorConfigs['euroid-core'].correlationConfig`, saved by `POST /api/v1/blueprints/save`) made every reconcile of a record carrying an overridden field throw, unless the identity had an explicit `metadata.mastery` entry for it, so each such HR row failed to ingest; the override's source list was never used. It now replaces the tenant's `defaultMastery` for the fields it names (only the listed sources write the field); an explicit `metadata.mastery` entry still wins, an empty list counts as unset, and a target named in it still only fills an empty field.

A low-confidence correlation match set `metadata.correlationConflict`, `requiresReview` and `conflictDetails` (with `incomingIdentityId`) on the matched identity in place on a Mixed path, so they were never saved: `GET /api/v1/identity/conflicts` never listed the conflict while a second identity was minted. They are saved now, and `POST /api/v1/identity/:id/resolve-conflict` saves the cleared flags, which it did not either. No API shape changes.
### Changed — dead-letter retry and replay report what actually happened

Event handler failures now reach the dead-letter queue, and an entry is closed as `replayed` only when its re-run succeeded.

- Handler failures: `@nestjs/event-emitter` swallowed the error of every listener without `suppressErrors: false` (and an `async: true` listener runs detached from the emit), so `emit()`'s catch almost never captured one. `HandlerFailureCaptureService` (`backend/src/infrastructure/events/`) now wraps each `@OnEvent` handler at startup: a failure becomes an `event_handler_failure` entry with the event as `originalPayload` and the new field `handler` (`Class.method`), then Nest logs and suppresses it as before (the emitting request and the other handlers carry on). Not captured: a `suppressErrors: false` listener (its error reaches the emitter; `emit()`'s catch now records its `handler` too) and a handler without `async: true` on an event emitted with `emitAndWait` (its caller gets the failure).
- `POST /api/v1/dead-letter/:id/retry` — waits for the re-run and answers `{ success, id, status, retryCount, maxRetries, error? }`: `success` is true only when `status` is `replayed`; otherwise `status` is `pending` or `failed_permanently` and `error` says why (email addresses masked). It used to answer `{ success: true, status: 'retrying' }` whatever happened (role: super-admin)
- `POST /api/v1/dead-letter/:id/replay` — waits for the re-run too and answers the same shape. A failure leaves the entry `pending` with `lastRetryError`, without counting an attempt; it no longer closes the entry as `replayed` at once or captures a new `replay:<source>` entry (role: super-admin)
- Retry and replay of an entry with nothing to re-run (`workflow_terminal`, `connector_non_retryable`, `event_validation_failure`, `event_chain_depth_exceeded`, or a handler failure stored without its event) answer `409 Conflict`; dismiss such an entry. Before, they marked it `replayed` and retry emitted `dlq.entry_retried`. An entry whose `handler` is no longer registered is refused the same way.
- What a re-run runs: an entry with `handler` runs only that handler with the stored event (the event's other handlers, such as audit and webhooks, do not run again); an entry without one re-emits the event to every handler and succeeds only when all of them did.
- `POST /api/v1/dead-letter/batch-retry` — re-runs only entries that carry their event and answers `{ success, processed, replayed, failed }`: `processed` entries were re-run, `replayed` of them succeeded, `failed` could not be retried at all (role: super-admin)
- `GET /api/v1/dead-letter`, `GET /api/v1/dead-letter/:id` — entries may carry `handler`.
- Webhook deliveries that ran out of attempts are captured as the new domain event `webhook.delivery_retry` (`{ subscriptionId, deliveryId, eventType, eventId, body }`, never emitted by a service) with `handler: EventDeliveryService.handleDeliveryRetry` and `retryCount: 0`, so the DLQ's automatic retry and an admin's retry post the stored body again to the subscription (signed with its current secret, same `X-EuroID-Delivery` id). The entry no longer stores `webhookUrl`, which can embed the receiver's token. Each delivery attempt keeps the body it sends (`webhook_delivery_attempts.body`), so the webhook retry poller re-sends the original body; it used to send an empty `payload` and `aggregateId`.
- Dead-letter capture works without a tenant context: the tenant plugin no longer validates the entry's nested `error` document, so the outbox poller's captures are stored under the event's tenant. The webhook retry poller runs each attempt in its tenant, so its attempt updates and captures no longer fail.
### Fixed — `PATCH /identity/:id?syncToEntra=true` starts onboarding once and reports what happened

The update's `identity.updated` event (which carries `syncToEntra`) made `OnboardingEventHandler` start onboarding, and the controller started it again through `identity.provision_requested`, both under the workflow id `t-<tenant>-onboard-<email>` with conflict policy FAIL. When the handler was first, the response said `workflow: { triggered: false, error: 'Workflow trigger failed' }` for a run that had started. The handler now starts nothing for an `identity.updated` with `syncToEntra`; the controller's start is the only one. `identity.provision_requested`'s handler lets a failed start reach the caller (`suppressErrors: false`), so the response can tell the cases apart (role: operator):

- `PATCH /api/v1/identity/:id?syncToEntra=true` — `workflow` is `{ triggered: true, workflowId, trackingUrl }` for the run it started; when an onboarding run of the identity is already in progress, `{ triggered: false, workflowId, trackingUrl, error: 'An onboarding run for this identity is already in progress; ...' }` with that run's id (this sync did not start); any other failed start stays `{ triggered: false, error: 'Workflow trigger failed' }`. Same fields as before, no DTO change.
- Domain event `identity.updated` — `syncToEntra: true` no longer starts an onboarding run.

### Fixed — onboarding targets the default canvas's Entra ID node

The default Design studio canvas's Microsoft Entra ID node (`entra-target`) had no `data.type`, and target discovery (`getActiveTargetSystems`) skips nodes without one, so a tenant that saved the default canvas onboarded nobody to Entra ID, with no error. The default node now carries `type: 'entra-id'`. A canvas saved before keeps working without a migration: a target node without `data.type` whose id is `<system>-target[-suffix]` naming a registered connector counts as that connector (`entra-target` -> `entra-id`), in target discovery and, when no node's id or type names the connector, in `getConnectorConfig` (so `getConnectorConfig('entra-id')` finds that node's Design studio config). Onboarding, the mover, admin account provisioning and access-review target discovery read these. No endpoint or DTO changed.
### Fixed — expired access that cannot be removed no longer blocks other expirations

The hourly `entitlementExpiryWorkflow` picked the first 50 identities with an expired provisioning entry that was not `DEPROVISIONED`, and an entry it could not deprovision (no connector config, an Okta, GitHub or other target it does not deprovision, AD or SCIM without an account id, an error from the target) stayed that way with nothing recorded. Every run picked the same entries again, and a batch that removed nothing ended the run, so once 50 identities had such an entry no other identity's expired access was removed and no `entitlement.expired` was emitted, silently. Now each failure is recorded on the entry and the run goes on (workflow patch `entitlement-expiry:continue-past-failures`): a failure retrying cannot fix (the cases above, a 4xx other than 408/409/429) is skipped until the entry's `expiresAt` changes; a retryable one (5xx, network, 429) is tried again 1 hour after the first failure, doubling up to 1 day (`ENTITLEMENT_EXPIRY_RETRY_BASE_MS`, `ENTITLEMENT_EXPIRY_RETRY_MAX_MS`). Entra ID answering that the user does not exist now counts as removed (before, it failed on every run). Expired access removed or not removed now appears on the identity timeline.

- Domain event `entitlement.expiry_failed` (new) — `{ identityId, targetSystem, expiresAt, reason, retryable, attempts, nextAttemptAt? }`, once per failed attempt; written to the audit log, delivered to webhook subscriptions and put on the identity timeline (`GET /api/v1/identity/:id/events`, type `USER_DEPROVISIONED`). `reason` has emails and LDAP DN names masked; no email in the payload
- Domain event `entitlement.expired` — now also put on the identity timeline; payload unchanged
- `GET /api/v1/identity/v2/:id`, `GET /api/v1/identity/v2/by-email` — `provisioning[].expiryFailure?: { expiresAt, failedAt, reason, retryable, attempts, nextAttemptAt? }` (new): the last failed expiry of the entry, for the `expiresAt` it names (role: viewer)
- Workflow `entitlementExpiryWorkflow` result — `failed: number` (new)
### Changed — the mover updates Okta and SCIM too, and keeps personal data out of its workflow history

A mover run (attribute change, re-evaluation, HR sync) changed access in Entra ID and AD only, and in AD only added groups (removals were dropped though the timeline said "Access updated"). Runs started now (workflow patch `mover:identity-by-id`) change group memberships in Entra ID, AD, Okta and SCIM, each through the new activity `applyMoverAccess` on the connector's own queue (`provisioning-entra`, `-ad`, `-okta`, `-scim`); Entra ID keeps its provisioning path (attributes, groups, directory roles, licenses added). Only systems the identity is provisioned to are changed (a SYNCED provisioning entry, or one whose onboarding completed and whose last run failed); any other is reported and skipped, and the run goes on. The account is the identity's written-back account id, else the email / login / userName lookup; none found there fails the system (422). Design: `backend/src/modules/mover/docs/ARCHITECTURE.md`.

- Domain events `mover.completed` / `mover.failed` — a `not-supported` system entry now carries `reason` (another system, or a kind of entitlement its connector does not change: AD, Okta and SCIM change groups only). A system can have an `updated` (or `failed`) entry and a `not-supported` one.
- Domain events `mover.completed` / `mover.failed` — new system outcome `no-account` (with `reason`): the identity is not provisioned to the system, so the run did not try it there and went on; the timeline shows "No account: <system>".
- `GET /api/v1/identity/:id/access/preview` — `appliedByMover` is `true` for Okta and SCIM groups as well; `false` for other systems and for kinds of entitlement the connector does not change (role: viewer)
- `POST /api/v1/identity/:id/access/re-evaluate` — an identity without an email is no longer refused with 409: the mover reads the identity by id (role: operator)
- Mover workflow history carries no email or profile: the input names the identity by id, `previousAttributes` keep only access-baseline keys (no names, contact data, identifiers), and the new activity `evaluateMoverChange` reads the identity and returns entitlement ids. A BLOCK SoD conflict now fails the run at once (it was retried without limit). A failed system's provisioning `errorMsg` is the connector's reason with emails and LDAP DN names masked, not the Temporal wrapper's text.
- Retried connector failures of offboarding, access-review revocation and the mover also have that masking in the stack trace Temporal stores (`asDeprovisionFailure`).
- Deploy the API and the worker together: a mover run started without an email by the new API cannot run on a worker without the patch. Runs started before it replay unchanged.
### Added — optional GitHub login per identity

An identity can carry its GitHub login in the custom attribute `githubLogin`. With it, onboarding invites that GitHub account by its user id (`GET /users/{username}`, `POST /orgs/{org}/invitations` with `invitee_id`) and writes back `github-user-<id>` as the GitHub account id; offboarding removes the organization membership (`DELETE /orgs/{org}/memberships/{username}`, the login looked up by the written-back id, else read from the identity), and a 404 there is already gone (after cancelling a pending invitation sent to the email, if any). Without a login nothing changes: invitation by email, a pending invitation cancelled, an accepted one failed for manual removal. A value that is not a GitHub login (letters, digits, hyphens, at most 39) fails provisioning and offboarding with a 422 that names the attribute, not the value.

- `PATCH /api/v1/identity/:id` — `customAttributes.githubLogin` (string): the identity page's Profile tab edits it as "GitHub login"; the body's `customAttributes` still replaces the whole map, so the page sends every custom attribute with the login changed, and none when the login is not edited (role: operator)
- CSV HR `columnMap` and JSON API HR `fieldMap` — a value `customAttributes.<key>` maps that column or key to the custom attribute `<key>`; default maps: CSV column `GitHub Login`, JSON keys `githubLogin` and `github_login` to `customAttributes.githubLogin`
- Activity `deprovisionGitHubUser(email, tenantId, correlationId, externalId?, identityId?)` — offboarding now passes the account id and the identity id; histories that called it with three arguments replay unchanged (the command is the same)
### Changed — HR ingest errors name the row, with the email masked

An HR row that failed validation or saving was reported as `<email>: <reason>` with the address in clear (or the employee id when the row had no email), in the ingest response, in the connector's `lastSyncError` and in the logs. It is now `Row <n> (<masked email>): <reason>`: `n` is the CSV line (the header is line 1) or the 1-based position in the JSON feed, the same numbering as the connector's "Skipping row" warnings, and every email address, the row's and any quoted in the reason, is masked (`m•••@example.com`).

- `POST /api/v1/connectors/:name/ingest` — `errors[]` entries in the format above (role: connector-admin, operator, super-admin)
- `GET /api/v1/connectors/:name/sync-status` — `lastSyncError` of an HR connector holds the first three such entries (role: viewer)

### Fixed — onboarding delivers to each target once per person

A second onboarding run for a person provisioned every target again: another Discord message, File-outbound line, Google Sheets row and ServiceNow incident. During an all-users run each write-back (ServiceNow, GitHub, Entra ID, ...) also started such a second run for the person (`identity.sources_changed` -> `SourcesChangedHandler`). Now a target that is SYNCED with its writeback complete is skipped (workflow patch `onboarding:skip-synced-targets`), a delivery with nothing to write back sets `writebackComplete`, and a write-back emits `identity.sources_changed` with `metadata.depth: 1`, which starts no onboarding.

### Changed

- `PATCH /api/v1/identity/:id?syncToEntra=true` — the onboarding run it starts provisions Entra ID again even when Entra ID is SYNCED, and skips every other SYNCED target; before, it provisioned every target again (role: operator)
- Domain event `identity.provision_requested` — optional `syncToEntra: boolean` (set by `PATCH /identity/:id?syncToEntra=true`)
- Domain event `identity.sources_changed` — `metadata.depth` is 1 when the new source is a target account written back by onboarding or admin account provisioning

### Fixed — the Discord webhook health check no longer posts "ping"

The health check (each onboarding run with a Discord target, and the connector-health dashboard on a cache miss) posted a "ping" message into the channel, so every onboarding run put "ping" before the welcome message. It now reads the webhook with `GET` on the webhook URL, which Discord answers with the webhook object without sending anything; a 4xx or an answer that is not a webhook object is unhealthy. No endpoint or DTO changed.

### Fixed — onboarding ignores the HR source on the canvas

Every canvas connector with a type counted as an onboarding target, the HR source included, so a canvas with CSV HR or JSON API HR failed each onboarding run at the health check (`checkCsv-hrHealth`, which no worker registers) before anyone was provisioned. Target discovery (`getActiveTargetSystems`) now keeps only connectors whose manifest declares `provision`; admin account provisioning, the mover and access-review target discovery read the same list and no longer see the source. No endpoint, DTO or workflow code changed.

### Fixed — onboarding provisions GitHub, ServiceNow, Discord webhook, Google Sheets and File outbound

A canvas with one of these targets failed every onboarding run at the health check: the workflow called `check<System>Health` / `provisionUserTo<System>` on the default queue, where no such activity was registered. They are now registered (`worker-default-activities.ts`) and run each connector's own service with its saved config. GitHub invites by email and writes back `github-invitation-<id>`; ServiceNow creates or updates the `sys_user` record, opens a tracking incident and writes back `snow-<sys_id>` (the id offboarding deactivates); Discord webhook, Google Sheets and File outbound deliver the record and write back nothing, since they keep no account. Each target's provisioning entry becomes SYNCED or ERROR as for the other targets. No endpoint or DTO changed; the workflow code is unchanged (same activity names and queue), so no patch is involved. `GitHubClient.createInvitation` also returns the created invitation's id. Design: `backend/src/modules/connectors/docs/ARCHITECTURE.md` (Onboarding: Provision per Connector without a Task Queue).

### Fixed — expiry warning events are emitted once

The hourly `entitlementExpiryWorkflow` emitted `entitlement.expiring_soon` and `entitlement.expiring_tomorrow` again on every run and every extra batch for each provisioning entry expiring that day: about 24 events per entry and threshold, each written to the audit log and delivered to webhook subscriptions (the 2.5 expiry email already deduplicated on its own). Each warning is now emitted once per entry and expiry date; the entry records the `expiresAt` it was emitted for (`provisioning[].expiryWarnings: { soon?, tomorrow? }`, answered like the rest of the identity document by `GET /api/v1/identity/v2/:id` and `GET /api/v1/identity/v2/by-email`, role: viewer) and a changed expiry date is warned about again. A batch now picks entries not yet warned, so with more than one batch's worth expiring on the same day the following runs reach the rest (before, the same first batch was warned every hour). Event payloads unchanged.

### Fixed — cancelling an access review campaign stops its workflow

`POST /api/v1/access-reviews/campaigns/:id/cancel` only set `status: CANCELLED`; the campaign's `accessReviewWorkflow` kept running, escalated overdue items, expired the pending ones at the deadline and then completed the campaign, overwriting `CANCELLED` with `COMPLETED`. The cancel now also cancels the workflow (Temporal cancellation), and the workflow's activities leave a cancelled campaign alone: it stays `CANCELLED` with no `completedAt`, no `access_review.campaign_completed` event, no escalation, expiry or revocation. Response unchanged; `400` also when the campaign completed between the read and the cancel.

### Fixed — ROLE approval steps of access requests can be decided

A `ROLE` approval step stores its role name (e.g. `policy-admin`) as `approverId` and `approverEmail`, and the endpoints matched only the caller's id or email against them, so nobody could decide it and the request was rejected at the approval timeout. Now any active admin user of the request's tenant whose role is that role (exactly; the role hierarchy does not apply) decides it, except the requester. A delegated `ROLE` step belongs to the delegate.

- `PUT /api/v1/access-requests/:id/approve`, `.../reject`, `.../delegate` — accept a holder of the step's role; approve and reject record the caller's email as `approvalSteps[].decidedBy` (all step types) and answer `400` when the step was decided meanwhile (another role holder was first)
- `GET /api/v1/access-requests/pending-approvals`, `.../pending-approvals/count`, `GET /api/v1/access-requests/:id` — include `ROLE` steps of the caller's role (not the caller's own requests)
- Response field `approvalSteps[].decidedBy?: string` (new)
- Approver email (`approval-requested`, SMTP configured): a `ROLE` step mails each active admin user of the tenant with the role, not the requester; nobody holding it means no mail

### Changed — close a failed target of any offboarding, keyed by the workflow

Closing a failed offboarding target as removed manually worked only for offboardings an HR leaver event started, so a failed target of an offboarding started by `DELETE /api/v1/identity/:id` (deleting the user) could not be closed and the identity stayed suspended. Every offboarding's per-system result is now an offboarding record keyed by its workflow id (`offboarding_records`), and the action takes that id. Both routes below were added in this unreleased cycle, so the old one is removed without a deprecation period.

- `POST /api/v1/leavers/offboardings/:workflowId/removed-manually` — body `{ system, reason }` as before; answers the updated offboarding (item shape below); 404 for an unknown workflow id (or another tenant's), 409 when the target is not `failed` (role: policy-admin). Replaces `POST /api/v1/leavers/events/:id/removed-manually`.
- `GET /api/v1/leavers/open-offboardings` — every offboarding with a `failed` target, leaver or user delete: `[{ workflowId, identityId, displayName, email?, leaver?: { leaverEventId, sourceName, reason, effectiveDate? }, offboarding: { status, hubStatus, systems[], finishedAt } }]` (`leaver` absent for a deleted user). It answered leaver batch items before.
- `GET /api/v1/leavers/batches` — `items[].offboarding` unchanged in shape, read from the offboarding record of the member's workflow.
- `identity.offboarding_target_removed_manually` — `leaverEventId` is optional (absent for a deleted user).
- Run `npm run migrate:up` (`20261122000002-offboarding-records-from-leaver-events`): it moves the results leaver events kept to `offboarding_records`; the Docker image runs it before start.

### Changed — the mass-leaver limit has a floor of 2

The mass-leaver limit, the smaller of 10 and 5% of active identities, rounded down to 0 below 20 active identities, so every leaver of a small tenant waited for approval. A sync now always starts up to `massLeaverMinCount` leavers on its own (default 2, env `LEAVER_MASS_MIN_COUNT`, never above the count limit): the limit is `max(massLeaverMinCount, min(massLeaverMaxCount, massLeaverMaxPercent of active identities))`, the HR mover shape.

- `GET /api/v1/leavers/policy` — gains `massLeaverMinCount`; a policy stored before the floor existed reads `min(LEAVER_MASS_MIN_COUNT, massLeaverMaxCount)`
- `PUT /api/v1/leavers/policy` — requires `massLeaverMinCount` (integer, 0 to 100000); a floor above `massLeaverMaxCount` answers `400`
- `leaver.policy_updated` — `changedFields` can name `massLeaverMinCount`

### Fixed — a second policy naming an undiscovered Entra group saves

`POST /api/v1/policy` and `PATCH /api/v1/policy/:id` answered `500` (E11000 on `entitlement_catalog`, `nativeId: null`) when the policy assigned an Entra group the catalog did not know yet and another such group was already registered: policy groups are registered by name, without a native id, and the sparse unique index on `{ tenantId, system, nativeId }` counted every such row as `nativeId: null` (the policy itself was stored as a draft). The index is now unique only for rows that have a `nativeId`. Run `npm run migrate:up` (`20261122000001-entitlement-catalog-native-id-index`) on an existing database; the Docker image runs it before start.

### Fixed — the Entra delete event no longer carries a clear email

`provisioning.completed` from an Entra ID delete (offboarding without a stored object id, bulk delete, orphan cleanup) carried the account's email in `targetUserId`, and as `identityId` and the event's aggregate id when the caller had no identity; the audit log and event subscriptions received it in clear. The email is now masked as in identity responses (`a•••@example.com`); a stored object id is passed on unchanged. No other connector's delete emits an event.

### Fixed — a Graph outage is retried, not a permanent Entra failure

Every Microsoft Graph error other than 404, 409 and 429 became a 400 connector error, so offboarding and access review revocation failed an Entra target at once (without retry) on a brief Graph 503 or a network error. A Graph 5xx answer or no answer at all is now a `502` connector error, which those activities retry per `CONNECTOR_RETRY`; other 4xx answers stay `400` and fail at once. An endpoint that passes an Entra connector error on answers `502` instead of `400` for a Graph outage, and the message names Graph's status (`Entra API Error (HTTP 503): ...`).

### Added — HR-driven mover

An HR sync that changes a provisioned person's department, job title, location or manager now moves their access: after leaver detection, each identity the sync delivered with a SYNCED target whose four trigger attributes differ from its access baseline gets a mover run (trigger `hr-sync`, actor `system:hr-sync`). A partial sync moves nobody; identities without a baseline are skipped and counted; identities an HR leaver is offboarding are left alone. A sync above the mass-mover limit (the smaller of 10 and 5% of active identities, at least 2) starts nobody and waits for an admin. Design: `backend/src/modules/mover/docs/ARCHITECTURE.md`.

- `GET /api/v1/movers/batches?status=pending|approved|rejected` — newest 50 mover batches: `{ id, sourceName, status, identityCount, allowance, activeIdentityCount, fieldCounts, createdAt, decidedBy?, decidedAt?, comment?, startedCount?, items: [{ itemId, identityId, displayName, email?, changes: [{ field, before, after }], status: pending-approval | started | superseded | failed | rejected, workflowId?, closeReason? }] }` (role: policy-admin)
- `POST /api/v1/movers/batches/:id/approve` — body `{ comment? }` (strict); re-reads each member and starts its mover run with its current changes (the admin as actor), closing as `superseded` anyone whose access already matches, who is being offboarded or has a run in progress; 404 for another tenant's batch, 409 when already decided (role: policy-admin)
- `POST /api/v1/movers/batches/:id/reject` — body `{ comment? }`; the same changes are not raised again (role: policy-admin)
- `GET /api/v1/movers/policy`, `PUT /api/v1/movers/policy` — per-tenant `{ massMoverMaxCount, massMoverMaxPercent, massMoverMinCount }`; `configured: false` while on the defaults (env `MOVER_MASS_MAX_COUNT`, `MOVER_MASS_MAX_PERCENT`, `MOVER_MASS_MIN_COUNT`); a floor above the count or an unknown field answers `400` (role: policy-admin)
- `POST /api/v1/connectors/:name/ingest` — the response gains `movers: { kind: 'mover-sync-summary', sourceName, fullSync, detected, started, alreadyRunning, startFailed, withoutBaseline, pausedBatchId? }` when mover detection ran
- Domain events: `mover.started` / `mover.completed` / `mover.failed` accept `trigger: hr-sync`; new `connector.hr_sync_movers_requested` (the `connector.hr_sync_completed` payload, emitted after leaver detection), `mover.batch_paused`, `mover.batch_approved`, `mover.batch_rejected` (`{ batchId, sourceName, identityCount, limit?, activeIdentityCount?, started?, comment? }`) and `mover.policy_updated` (`{ changedFields }`), all audited

### Fixed — dead-letter responses mask every phone field

`GET /api/v1/dead-letter` and `GET /api/v1/dead-letter/:id` masked only the identity phone fields (`mobilePhone`, `workPhone`) in `originalPayload`, so a payload `phone` came back in clear. Every value under a phone-like key is now masked like `mobilePhone` (`+358 •• ••• 4567`) at any depth: `phone`, `homePhone`, `telephoneNumber`, `businessPhones`, SCIM `phoneNumbers[]` (all of `value` and `type`), `mobile`, `fax`, `pager`. Phone numbers inside other fields or in error texts are not detected. Identity responses are unchanged.

### Changed — AD "no such object" is already gone; Okta reruns read the status first

- AD offboarding uses the new activity `deprovisionAdUser` (patch `offboarding:ad-deprovision-outcome`): LDAP "no such object" for the stored DN is `already-gone` (it was `failed`), and the failure reason is masked.
- Okta offboarding reads the user first and does not deactivate a user that is already `DEPROVISIONED`: such a user is `already-gone` (`already deactivated`), or with `deprovisionStrategy: delete` is deleted (`deleted (was already deactivated)`). A rerun after a failed delete used to call deactivate again.
- Entra and AD failure reasons are masked before they reach workflow history (emails, and the CN/UID of an LDAP DN, e.g. `CN=•••,OU=Users`); the Leavers page and timeline masked them already.

### Changed — offboarding also removes half-created accounts; Entra fallback only without state

Offboarding deprovisioned only `SYNCED` targets and fell back to an Entra ID delete by email whenever none was left: on a rerun after every target was `DEPROVISIONED`, and for an identity whose entries were all `ERROR` or `SYNCING` (onboarding that never finished, possibly with a half-created account, which was never removed). It now deprovisions every entry not yet `DEPROVISIONED` (`SYNCING`, `ERROR` and `PENDING` too); one whose account the connector cannot find is `failed` with a reason saying provisioning never completed. The Entra fallback runs only for an identity with no provisioning state at all. New activity `getOffboardingTargets`; workflows started before the patch `offboarding:unsynced-targets` keep the old discovery.

### Changed — access reviews remove revoked access in Entra ID, AD, Okta and SCIM

A `revoked` decision used to remove nothing unless the campaign had `autoRevokeOnExpiry` and items were still pending at the deadline, and then only Entra ID group memberships, without any per-item result; the first decision also ended the campaign within a minute and expired the other pending items. Now, when the campaign closes (every item decided, or the deadline), every revoked group membership is removed through its connector (and expired ones with `autoRevokeOnExpiry`), and decisions no longer end the campaign. Per connector: `backend/src/modules/connectors/docs/ARCHITECTURE.md`, Access Review.

- Activation reviews group memberships in AD, Okta and SCIM targets on the canvas as well as Entra ID (where directory roles and administrative units now get their own `type`: `directory-role`, `administrative-unit`). New entitlement types `app-group` (Okta) and `indirect-group` (SCIM).
- Review items (`GET /api/v1/access-reviews/campaigns/:id/items`, `GET .../items/:itemId`, `GET .../my-reviews`): `entitlements[]` gains `accountId` (the holder's account in the target when the item was generated) and `revocation: { outcome, detail?, reason?, at }`, `outcome` one of `removed`, `already-gone`, `manual-action-needed`, `failed`.
- Campaigns (`GET /api/v1/access-reviews/campaigns`, `GET .../campaigns/:id`): `revocationSummary: { removed, alreadyGone, manualActionNeeded, failed }` once a completed campaign revoked something.
- A cancelled campaign removes nothing.
- New env `ACCESS_REVIEW_REVOCATION_BATCH_SIZE` (default 50).

### Fixed — access review campaign routes accept campaign ids

`GET /api/v1/access-reviews/campaigns/:id`, `POST .../campaigns/:id/activate`, `POST .../campaigns/:id/cancel` and `GET .../campaigns/:id/items` validated `:id` as a MongoDB ObjectId, but campaign ids are UUIDs, so every call answered 400 "Invalid ID format". They now validate a UUID (400 "Validation failed (uuid is expected)" otherwise).

### Added — access preview and re-evaluation of an identity (mover)

- `GET /api/v1/identity/:id/access/preview` — read-only: `{ identityId, baselineRecordedAt, changes: [{ field, before, after }], toAdd, toRemove, provisionedTargets, canReevaluate, blockedReason? }`. The active policies (SoD-free) are evaluated against the identity's access baseline and its current profile; `toAdd` / `toRemove` entries are `{ type, target, targetId, sourcePolicy?, appliedByMover }` (`false` for a system the mover does not update: it updates Entra ID and AD only). No writes, no workflow. 404 for another tenant's identity (role: viewer)
- `POST /api/v1/identity/:id/access/re-evaluate` — no body (any field is a 400). Starts the mover workflow with the baseline values of the changed attributes; answers `202 { workflowId, changedFields }`. 409 without an access baseline, without a SYNCED target, or while a mover run for the identity is in progress; audited `ACCESS_REEVALUATION_REQUESTED` with the authenticated user (role: operator)
- Identity documents (`GET /api/v1/identity/v2/:id`) gain `accessBaseline: { attributes, recordedAt, recordedBy: provisioning | mover }`: the profile values access was last applied with, without names, contact data and identifiers. Recorded at the identity's first SYNCED target, advanced by each completed mover run. Identities provisioned earlier get one at their next SYNCED target.
- The domain events `mover.started` (`{ identityId, workflowId, trigger: attribute-change | re-evaluate, changedFields }`, actor: who changed the attribute or the operator), `mover.completed` and `mover.failed` (`{ identityId, workflowId, trigger, status: completed | no-change | skipped | failed, changedFields, added, removed, systems: [{ system, outcome: updated | failed | not-supported | not-attempted, added[], removed[], reason? }], reason?, durationMs }`) are emitted; they were declared but never emitted, and their payloads no longer carry `email` or `error`. The identity timeline shows each mover run: the start, one entry per target system with changes, a summary.

### Changed — mover workflow named by identity id

The mover workflow id is `t-<tenant>-mover-<identityId>` (was derived from the email); its memo, log and `MOVER_WORKFLOW_STARTED` audit entry name the identity by id, and the audit actor is the user who changed the attribute (was `MoverService`).

### Security — Entra ID calls use only their own config's credentials and tokens

No endpoint or DTO changes. The Entra ID client is shared by every activity on a worker and stored the config of the last call (`setRuntimeConfig`), so concurrent activities of two tenants (onboarding and offboarding with the tenant's canvas config, access reviews with the `ENTRA_*` environment config) could run Microsoft Graph calls with another config's tenant, client id or secret. Each Graph call now takes its config, and nested calls (UPN checks, group, license and role operations) get the caller's. Calls made without a config always use the `ENTRA_*` variables; before, they could pick up the canvas config another activity had just set.

- The Entra OAuth token cache is keyed by every credential, the secret as a SHA-256 hash: `oauth:entra:{tenantId}:{clientId}:{sha256}` (was `{tenantId}`). Tokens cached under the old key are not read again and expire within the hour; the first call per config after the deploy fetches a new token.

### Security — SCIM and ServiceNow tokens are cached per credentials

The ServiceNow client cached its OAuth token per instance URL, so a config naming the same instance with any client id and secret got that token; the SCIM client keyed by base URL and client id, neither of them secret. Both keys now include a SHA-256 of the client secret: SCIM `oauth:scim:{baseUrl}|{clientId}|{sha256}` (Nest cache), ServiceNow `{instanceUrl}|{clientId}|{sha256}` (in memory, per process). The first call per config after the deploy fetches a new token.
- Entra tokens are now reused for their lifetime: every Entra call used to delete the cached token of the previous config, so most calls fetched a new one.
- The Entra license SKU map is cached per config (was one map for all tenants).

### Security — a revoked token is refused on the next request, on every instance

`JwtAuthGuard` reads the admin's `isActive` and `tokenVersion` from MongoDB on every request with a local token. The 30 s admin cache in the security state store (`admincache:{userId}`) is gone: a request that read the admin just before a revocation could re-cache the old token version for 30 s, and when the revoking instance could not reach Redis, other instances kept accepting the revoked token until the cached entry expired. A revocation (`POST /api/v1/auth/revoke/:userId`, password change, deactivation) now takes effect from the next request whether or not Redis is reachable, and the guard no longer touches Redis for it.

### Fixed — dead-letter automatic retry

The DLQ auto-retry poller never retried anything: it runs outside a request and its first tenant-scoped lookup failed for every entry. It now retries each entry in that entry's tenant, and only entries that carry a domain event (`event_handler_failure` with the stored event); workflow terminals, connector errors and webhook deliveries stay `pending` for an admin instead of being closed as `replayed` without any work. An event-carrying entry is re-emitted to all its listeners, as the auto-retry was designed to do.

### Added — email notifications (SMTP)

No endpoint or DTO changes. With `SMTP_HOST` set (new optional env: `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_REQUIRE_TLS`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`, `SMTP_TIMEOUT_MS`; links use `FRONTEND_URL`, else the first `CORS_ORIGINS` entry) the backend emails the approver of each access request step, every reviewer when a campaign is activated, the new reviewer of escalated items, and the owner of time-bound access 7 days and 1 day before it ends. Without `SMTP_HOST` email is off and nothing changes. In-app Socket.IO events are unchanged. Design: `backend/src/modules/notifications/docs/ARCHITECTURE.md`.

- New collection `email_notifications` (TTL 30 days; mail bodies removed once sent).
- New domain event `notification.email_retry` (`{ notificationId, kind }`), never emitted by a service: it is the stored event of a dead-letter entry (`type: event_handler_failure`, `source: email:<kind>`) for a failed send, and the DLQ retry re-emits it. Audited like every event; webhook subscribers to it get `{}`.
- The `notifyApprover` activity of `accessRequestApprovalWorkflow` now sends the approver mail (it was a no-op); the workflow itself is unchanged.

### Changed — dead-letter queue: personal data masked, source filter, validated filters

- `GET /api/v1/dead-letter` and `GET /api/v1/dead-letter/:id` mask personal data in the response (identity-pii): `originalPayload` gets `personalEmail`, `mobilePhone`, `workPhone` and `officeExtension` masked as in identity responses, and every email address in it, in `error.message`, `error.stack` and `lastRetryError` becomes `m•••@example.com`. Secrets stay redacted as before. The stored entry keeps the clear event, so retry and replay re-emit what the handler originally received.
- `GET /api/v1/dead-letter` takes `source`: a case-insensitive prefix of the entry's source (`identity.created`, `webhook:`, `distributed-transaction`), up to 200 characters; empty means no filter. `type`, `status` and `source` are validated (Zod): an unknown `type` or `status`, a repeated one, or a longer `source` is a 400 (an unknown value used to return an empty list). `limit` and `offset` are unchanged (role: operator)
- New page Reconciliation > Dead-letter queue (`/dead-letter`, operator): list with status and type filters, source prefix, paging, the masked entry, and retry and replay (super-admin) and dismiss (operator) behind a confirmation. Retry and replay are offered only for an entry that carries its domain event (`event_handler_failure` with `type` and `metadata`); for any other entry the backend re-runs nothing and would only mark it `replayed`.

### Changed — offboarding reports "already gone" only with proof

An account offboarding cannot find when no account id is stored (provisioned before the id write-back) used to be reported `already-gone`, so the target was marked `DEPROVISIONED` and the Golden Record deleted while the account could still be live under another name. It is now `failed` (not retried) with a reason asking an admin to check the target and mark it removed manually; a stored id the target answers 404 for stays `already-gone`. Lookups use every identifier provisioning used: SCIM `userName` = the identity's UPN or email, then `emails.value`, and only a returned user carrying that value counts; Entra the email as UPN, then `mail` / `userPrincipalName`; ServiceNow `email`, then `user_name`; Okta the login (the email). Per connector: `backend/src/modules/connectors/docs/ARCHITECTURE.md`, Offboarding.

### Added — close a failed offboarding target as removed manually

- `GET /api/v1/leavers/open-offboardings` — leaver events whose offboarding left a target `failed` (batch members or not), newest 50, same item shape as `GET /leavers/batches` `items[]` (role: policy-admin)
- `POST /api/v1/leavers/events/:id/removed-manually` (replaced by `POST /api/v1/leavers/offboardings/:workflowId/removed-manually`, see "Changed" above; this route no longer exists). Body: `{ system, reason }` (both required, `reason` up to 500 characters; strict, so an actor or tenant in the body is a 400). For a target the leaver's offboarding reported `failed`: the admin removed the account by hand. The target's outcome becomes `removed-manually` with `manualRemoval: { by, at, reason }` (`by` is the authenticated user); the provisioning entry becomes `DEPROVISIONED`. When no target of that offboarding is left `failed`, the result becomes `status: completed, hubStatus: deleted` and the Golden Record is soft-deleted as after a fully successful offboarding (`identity.deleted`, `deletedBy` the admin). Answers the updated item; 404 for an unknown leaver event (or another tenant's), 409 when that target is not `failed` (already closed, or not in the result) (role: policy-admin)
- Offboarding results (`items[].offboarding.systems[]`, `identity.offboarding_completed`) gain the outcome `removed-manually` and the optional `manualRemoval`.
- New domain event `identity.offboarding_target_removed_manually` (`{ identityId, leaverEventId, workflowId, system, reason, offboardingComplete }`, actor the admin): audited, and the identity timeline gets a `USER_DEPROVISIONED` entry "Removed manually: <system>" (and "Offboarding completed" for the last one).

### Changed — offboarding removes access in every target and reports each system

Offboarding (`DELETE /api/v1/identity/:id`, HR leavers) now deprovisions every target where the identity has an account and says per system what happened: `deprovisioned`, `already-gone`, `not-applicable` (Discord webhook, Google Sheets, File outbound keep no account) or `failed` with the reason. Per connector: `backend/src/modules/connectors/docs/ARCHITECTURE.md`, Offboarding.

- New deprovision: GitHub cancels the person's pending organization invitation (an accepted invitation fails with a reason: the GitHub API cannot find a member by email); ServiceNow deactivates and locks the `sys_user` record (`active=false`, `locked_out=true`, never deleted); Okta deactivates the user, and with the new connector config field `deprovisionStrategy: delete` (or `OKTA_DEPROVISION_STRATEGY=delete`) then deletes it. The GitHub and ServiceNow manifests gain the `deprovision` capability.
- Onboarding writes the Okta and SCIM user ids back to the identity (`sources[]`, like the Entra `objectId` and AD DN), and every target's id until one writeback completed; SCIM offboarding uses that id and looks accounts provisioned earlier up by `userName`, then `emails.value`.
- An identity with no provisioning state is tried in Entra ID only when an Entra ID connector is configured; it used to fail without one and never be marked deleted.
- The Golden Record is always updated: soft-deleted when nothing failed, otherwise suspended (`controls.isLoginDisabled`, profile `status: SUSPENDED`) and kept until offboarding is re-run.
- New domain event `identity.offboarding_completed` (`{ identityId, workflowId, status: completed|partial-failure, hubStatus: deleted|suspended, systems[] }`, no names or emails). The identity timeline (`GET /api/v1/identity/:id/events`) gets one `USER_DEPROVISIONED` entry per system and a `WORKFLOW_COMPLETED` summary.
- `GET /api/v1/leavers/batches`: `items[].offboarding` (`{ status, hubStatus, systems[], finishedAt }`) once the leaver's offboarding finished.
- The offboarding workflow returns this result (it returned a string), and with a failed target fails with `OffboardingPartialFailure` carrying it in the failure details.

### Fixed — Golden Record correctness: target writes, HR sources without a config

The merge started from the stored profile as a Mongoose subdocument, whose spread holds no field values, so the rule that a target only fills empty fields never saw them: a target writeback (Entra, AD, Okta, ...) overwrote any profile value that no earlier source of the same merge carried (an admin edit, a value its source no longer sends), and without a reconciliation config the first source in the list won, so an HR update after a `manual-ui` or SCIM-inbound record of the same person never landed. The merge now starts from the plain profile: a target fills only empty fields, whatever the merge order. A tenant without `hrSourceTags` used to store every source, HR included, as `sourceRole: target`; a source is now HR when it comes from a connector whose manifest declares `ingest` (CSV HR, JSON API HR), under the connector id, the `sourceSystem` of its installed config or of its Design Studio source node; every other source is a target. The role is rewritten at the source's next ingest. No API shape changes.

Reconciliation changed `metadata.version`, `primaryHrSource` and `primaryContractExternalId` in place on a Mixed path, so Mongoose never saved them: an identity minted by an HR ingest kept `version: 0` and no `primaryHrSource` (with it the correlation status and mastery set before the reconcile were lost too). They are stored now. Leaver detection, which decides by `metadata.primaryHrSource` and fell back to the identity's first source without it, now follows the resolved primary HR source; HR writeback reads the same field.

Offboarding took a target's account id from any source whose name contained the target's name or the other way round, HR sources included: target `ad` got the employee id of an HR source `adp-workforce` (or `upload`) as the DN, `scim` the id of a `scim-prod` source. The id now comes only from a target source (`sourceRole: target`) of that system, matched exactly once normalised (case, dashes) or as aliases of one system (`entra` / `entra-id`, `ad` / `active-directory`); without one the connector looks the account up as it does for an account with no stored id.

An HR row of a soft-deleted identity (an offboarded leaver whose row the feed keeps) matched no identity, because the source-key lookup and the correlation rules skip deleted ones, so the ingest minted a second, active identity (or, with the unique email index, failed that row with E11000 on every sync, which made each run partial). Correlation now also matches deleted identities, after the live ones: a terminated or ended row changes nothing; an active row whose start date is after the deletion is a rehire, which revives the identity (deletion marker, kill switch and access baseline cleared, profile status from HR, audited as `identity.status_changed` with `previousStatus: DELETED`) and lets the joiner path run; any other active row changes nothing and is logged with the email masked.

- `POST /api/v1/connectors/:name/ingest` — the response gains `activeRowsOfDeletedIdentities` (number): active rows of deleted identities that were not a rehire. Rows of deleted identities are neither `ingested` nor `errors`.
- `POST /api/v1/identity` with a record that matches a deleted identity answers `409` unless it is a rehire; it used to create a duplicate identity or fail with a duplicate-key error. Bulk and batch provisioning report the same error for such a row.

### Fixed — dropped HR fields are cleared on the Golden Record

A field the owning HR source stops sending (an end date cleared on rehire, a removed job title, an HR status) is cleared on the Golden Record; a source that does not own the field (mastery, a contract-critical field of the primary HR source, a target) cannot clear it. A target's stale copy of a cleared field (e.g. Entra still holding the old job title) no longer fills it again, in the same merge or later ones, until a source allowed to overwrite the field sends a value (`metadata.ownerClearedFields` on the identity). `email`, `status`, `firstName` and `lastName` are never cleared by a drop: dropping one used to fail the save (`email`, names) or reset the status to `PENDING`. HR custom attributes now update the profile key by key; they used to keep the first ingest's values.

### Added — HR-driven leavers

HR syncs now offboard leavers on their own: a terminated HR status, a passed end date, or three consecutive full syncs without the person. A sync above the mass-leaver limit (10 identities or 5% of active identities, the smaller) starts nobody and waits for an admin. Design: `backend/src/modules/leavers/docs/ARCHITECTURE.md`.

- `GET /api/v1/leavers/batches?status=pending|approved|rejected` — newest 50 leaver batches with their identities (role: policy-admin)
- `POST /api/v1/leavers/batches/:id/approve` — body `{ comment? }`; starts every member's offboarding; `404` for another tenant's batch, `409` when already decided (role: policy-admin)
- `POST /api/v1/leavers/batches/:id/reject` — body `{ comment? }` (role: policy-admin)
- `GET /api/v1/leavers/policy`, `PUT /api/v1/leavers/policy` — per-tenant leaver policy; `configured: false` while on the defaults; unknown fields and time zones answer `400` (role: policy-admin)

### Changed — HR ingest reports leavers; HR connectors map status and end date

- `POST /api/v1/connectors/:name/ingest` responses carry `leavers: { sourceName, fullSync, detected, started, pausedBatchId? }` when leaver detection ran.
- CSV HR maps `Status` / `Employment Status` to `customAttributes.hrStatus` and `End Date` / `Termination Date` to `endDate` by default; JSON API HR maps `status`, `employment_status`, `employmentStatus` and `end_date`, `endDate`, `termination_date`, `terminationDate`. The Golden Record `status` is unchanged by these columns. A feed that already has such a column starts driving leavers on the next sync.
- Identity timeline (`GET /api/v1/identity/:id/events`) has a new type `LEAVER_DETECTED`; the offboarding a leaver starts appears as `WORKFLOW_STARTED`.
- Offboarding workflows started for a leaver carry `reason: leaver:<terminated|end-date|missing-from-source>` in their memo; `identity.offboard_requested` gained an optional `reason`.

### Fixed — unknown errors are logged and answered with the generic 500

The global `VersionConflictFilter` caught every exception and handed the ones it did not answer to NestJS's default handler, so `AllExceptionsFilter` never ran: an unknown error was not logged as `Unhandled exception:`, and an error object carrying its own `statusCode` and `message` (an SDK's upstream response, for example) reached the client with that status and message. `VersionConflictFilter` now catches only Mongoose `VersionError` (`409`) and `CastError` (`400` for an ObjectId); every other error reaches `AllExceptionsFilter`, which answers `500 { statusCode: 500, message: "Internal server error" }` and logs it. Express body parsing errors keep their status and message (`413 request entity too large`), and `HttpException`s their own response.

### Fixed — `POST /blueprints/deploy` answers a failed readiness check with HTTP 422

`POST /api/v1/blueprints/deploy` refused a pipeline that failed its readiness check with HTTP status `400` and `"statusCode": 422` only in the body, although Swagger and the docs promise `422`. It now answers with HTTP status `422`; the body is unchanged (`{ statusCode: 422, message: "Readiness check failed", readiness }`), so the Deploy modal keeps showing the failed checks. A client that treated the `400` as the readiness failure must check for `422`.

### Changed — the canvas save carries the policy condition and action nodes

The Design studio's policy node rail lets admins add condition and action nodes to the canvas. `POST /api/v1/blueprints/save` now receives them after the connector nodes (`type: 'condition'` with `data: { field, operator, value }`, `type: 'action'` with `data: { targetSystem, actionType }`), and the edges between them after the connector edges, so `GET /api/v1/blueprints/latest` returns them. They have no `data.role` or `data.type`, so readiness checks and target discovery skip them. No schema change: nodes were already accepted with any `type` and `data`. The body is pinned in `backend/test/fixtures/blueprint-save-policy-nodes.payload.json`.

### Changed — canvas node labels are saved as `{ text, icon }`

The Design studio now sends each connector node's `data.label` in `POST /api/v1/blueprints/save` as `{ text, icon }` (`icon` is an `@ant-design/icons` component name such as `FileTextOutlined`), so `GET /api/v1/blueprints/latest` returns that shape. Before, the label was a React element that JSON reduced to `{ props: { children: [...] } }` without its icon, and reloaded nodes lost their icons. Canvases saved in the old shape still load: the Design studio takes the name from the old label and the icon from the node's connector, and the deploy readiness check reads the name from either shape.

### Fixed — `PATCH /blueprints/pipeline-config` saves the circuit breaker settings

`PATCH /api/v1/blueprints/pipeline-config` was declared after `PATCH /api/v1/blueprints/:id`, so Express matched it as `:id` and every call answered `400 Invalid ID format: pipeline-config`; the Deploy modal could never change the error threshold. The route now comes first and answers `200 { success: true }`; an invalid body answers `400` naming the field. No other controller declares a literal route after a parameter route that captures it (`backend/src/app-routes.spec.ts` checks the route table of every controller).

### Fixed — `POST /blueprints/save` accepts connector config objects and answers invalid bodies with `400`

`POST /api/v1/blueprints/save` accepted only primitive `connectorConfigs` values, but every entry is a connector's config object (what `GET /blueprints/latest` returns), and the Design studio saves the Brain's correlation settings as `connectorConfigs['euroid-core'] = { correlationConfig }`. Any such save failed, and the thrown validation error answered `500`. Each `connectorConfigs` entry is now an object; `euroid-core.correlationConfig` is validated against the correlation contract (`rules[]` with `strategy` one of `employeeNumber`, `email`, `hashedNationalId`, `composite`, `heuristicName` and optional `compositeFields`, `nationalIdSourceField`, `nameMatchThreshold` 0–1, `nameMatchMode`, `confidenceThreshold` 0–1; optional `conflictAction` `auto-link`/`review`, `confidenceThreshold`, `fieldMasteryOverrides` field → connector id list, `hrWriteback`, `targetWriteback`). An invalid body answers `400` with one `message` entry per problem, prefixed by the field path (e.g. `connectorConfigs.euroid-core.correlationConfig.rules.0.strategy: ...`). The body the Design studio builds is pinned in `backend/test/fixtures/blueprint-save-correlation.payload.json`.

### Added — `isPlatformAdmin` in `GET /auth/me`

`GET /api/v1/auth/me` now also returns `isPlatformAdmin: boolean`, computed server-side from `PLATFORM_ADMIN_USER_IDS` (the check `RolesGuard` uses for `platform-admin`); no token claim sets it. The UI shows tenant management (sidebar, command palette, `/admin/tenants`) only when it is `true`; before, every `super-admin` saw it and got `403` on each call.

### Fixed — a failed registration leaves the invite usable

`POST /api/v1/auth/register` marked the invite used before comparing the email, so a typo answered `400` and burned the invite; the inviter had to create a new one. The token, the email and the invite's state are now checked first, and the invite is marked used only together with creating the admin: a `400` (email other than the invited one), a `401` or a failed account creation leaves it usable until it expires. Of two registrations racing for one invite, one succeeds and the other answers `401` (or `409` if it arrives after the first created the account). The password is hashed only for a valid invite.

### Fixed — registration through an invite

`POST /api/v1/auth/register` with an `inviteToken` answered `500` for every invite: the invite lookup ran without a tenant context, which the tenant-scoped `invites` collection refuses. It now answers `201` and creates the admin in the inviting tenant (the invite's stored `tenantId`) with the invited role; before, the invite's tenant was never read, so the admin would have landed in `DEFAULT_TENANT_ID`. A `tenantId` or `role` in the body is ignored. A used, expired or unknown token is `401`, an email other than the invited one `400`.

### Fixed — the `invite.created` event no longer carries the invite token

`POST /api/v1/auth/invites` emitted `invite.created` with the plaintext invite token as `aggregateId`, so it reached the tenant's audit log (`resourceId`, `resourceName`, `description`, readable by `viewer`), event subscription webhooks and Socket.IO, and any reader could register with the invited role. The `aggregateId` is now the invite's id; the token is only in the response to the inviting super-admin. Audit entries written before this fix still hold tokens of invites created then (valid for 72 hours).

### Fixed — `agentId` is unique per tenant only

`agents.agentId` had a global unique index besides the `{ tenantId, agentId }` one, so a tenant could not hold an agent id another tenant uses, and the conflict would tell it that the id exists. `POST /api/v1/agents/register` generates ids (`agent-<uuid>`), so the API could not hit this in practice; the index contradicted the per-tenant model. The id is now unique per tenant only. Run `npm run migrate:up` (the Dockerfile does this on start): migration `20261122000000-agent-id-per-tenant-unique` drops the global `agentId_1` index if present and creates the per-tenant one if missing; rerunning it is safe.

### Changed — tenant management needs a platform admin

`/api/v1/tenants` (create, list, get, update, suspend, migrate) required `super-admin`, a role every tenant has, so any tenant's admin could manage every tenant. These routes and `GET /api/v1/batch-provision/health/diagnostics` (deployment-wide paths and key status) now require `platform-admin`, which only the deployment grants: `PLATFORM_ADMIN_USER_IDS`, a comma-separated list of authenticated user ids (JWT `sub`). Unset means nobody; a tenant `super-admin` now gets `403`, and a `platform-admin` role claim in a token grants nothing. `POST /tenants` drops a body `createdBy` and records the caller. `POST /api/v1/auth/revoke/:userId` and `PATCH /api/v1/auth/users/:id` act only on an admin of the caller's tenant; another tenant's admin is `404` (revoke used to answer `200` for any id).

### Fixed — the actor of a write is the authenticated user

`POST /api/v1/reconciliation/distributed-transaction` recorded the body's `initiatedBy` as the actor (workflow memo, transaction log). The field is no longer accepted (dropped if sent); the actor is the caller's email. `POST /api/v1/identity` and `PATCH /api/v1/identity/:id` strip `createdBy` and `updatedBy` from the body.

### Fixed — `POST /blueprints/save` stores edge flow conditions

The save kept only `id`, `source` and `target` of each edge and `id`, `type`, `position` and `data` of each node, so the flow conditions set on a Brain → target edge in the Design studio (`edges[].data`) were dropped and provisioning never applied them, and edge labels and node and edge styles were lost on reload. An edge now also keeps `sourceHandle`, `targetHandle`, `type`, `label` (text, at most 200 characters), `animated`, `style` and `data`, and a node keeps `style` (at most 50 properties, string or number values). `data` is validated: `conditionsEnabled` boolean, `label` text, `conditionGroups[]` (at most 20) with `id`, `join` `AND`/`OR` and `conditions[]` (at most 50) of `id`, `field`, `operator` and `value` (text or a list of at most 100 texts). `operator` is one provisioning evaluates: `equals`, `not_equals`, `contains`, `starts_with`, `ends_with`, `in`, `not_in`, `is_empty`, `is_not_empty`; anything else is `400` (e.g. `edges.2.data.conditionGroups.0.conditions.0.operator: ...`). Other keys (React Flow UI state such as `selected` or `measured`) are still dropped. The body the Design studio builds is pinned in `backend/test/fixtures/blueprint-save-edge-conditions.payload.json`.

### Fixed — invalid request bodies and queries answer `400` instead of `500`

Routes that validate their input with a Zod schema inside the handler or service, without their own error mapping, answered an invalid body or query with `500 Internal server error`: among them `PATCH /api/v1/blueprints/:id`, `POST /api/v1/blueprints/impact-analysis`, `POST /api/v1/access-requests` and its decision routes, `POST|PATCH /api/v1/sod-policies`, `POST|PATCH /api/v1/event-subscriptions`, credential policies, dead-letter batch retry, entitlement governance tags, `PUT` reconciliation config, orphan signals, the drift list and the analytics, anomaly, dev-tools and risk-scoring query parameters. They now answer `400` with one `message` entry per problem, prefixed by the field path (e.g. `webhook.url: Invalid url`, `body: ...` for the body itself), the format DTO validation already used. Routes that already mapped validation errors to `400` keep their response body.

### Fixed — child workflows are readable by their tenant

Reconciliation batches (`<parent>-batch-<n>`), orphan cleanups (`<parent>-orphan-<driftId>-<n>`) and admin account provisioning (`admin-provision-<parent>-<identityId>`) are child workflows, and Temporal does not copy the parent's `TenantId` search attribute to a child, so `GET /api/v1/dev/workflows/:workflowId` answered `404` for them to their own tenant and the dev-tools list (filtered by `TenantId`) never showed them. They are now started with the parent's `TenantId` and memo (`triggeredBy`, `targetDescription`). Children started before this change keep answering `404`.

### Fixed — workflows of another tenant are 404

Workflow ids are guessable (`t-<tenant>-...`), and these routes read or controlled any workflow by id: `GET /api/v1/dev/workflows/:workflowId`, `GET /api/v1/bulk-provisioning/status|results|partial-results/:workflowId`, `POST /api/v1/bulk-provisioning/approve-deletes|cancel/:workflowId`, `GET /api/v1/onboarding/status/:workflowId`, `GET /api/v1/batch-provision/status/:workflowId`, `GET /api/v1/reconciliation/status|result/:workflowId`. Each now answers `404` unless the workflow's `TenantId` search attribute is the caller's tenant; a workflow without it (older runs, and child workflows started before the fix below) is `404` for everyone. `GET /dev/workflows/:workflowId` answers `404` instead of `200 { found: false, workflow: null }` for a missing workflow too. Access request approval workflows are now started with `TenantId`.

### Fixed — blueprint responses mask connector secrets

`GET /api/v1/blueprints/latest` and `GET /api/v1/blueprints/:id` (viewer) returned canvas connector configs decrypted, Entra `clientSecret`, AD `password` and Discord `webhookUrl` included. They, and the `PATCH /api/v1/blueprints/:id` response, now return every secret as `••••••••` for every role: a field the node's connector manifest declares `type: 'password'`, or, for a node without a registered `data.type`, a field any connector declares secret or whose name looks like a credential. Saving the mask back (`POST /blueprints/save`, `PATCH /blueprints/:id`) keeps the stored value of the same node; `''` or `null` removes the secret; a new value replaces it. `POST /api/v1/connectors/:name/health-check` uses the stored value for a masked secret in the submitted config.
### Security — the login rate limit holds across instances

`POST /api/v1/auth/login` allowed `AUTH_THROTTLE_SHORT_LIMIT` (default 5) attempts per second and `AUTH_THROTTLE_MEDIUM_LIMIT` (default 15) per minute per client on each API instance, counted in process, so with several instances a client got that many per instance. The counters now live in the security state store (Redis with `REDIS_URL`), so the limits hold across all instances; the counter is a fixed window and a client over the limit gets `429` until the window ends. While the store fails, login answers `503` ("Security checks are temporarily unavailable. Try again later.") instead of running unthrottled. Other routes keep their per-instance limits.

### Security — a revocation holds when its cache delete fails

A revocation (`POST /api/v1/auth/revoke/:userId`, password change, deactivation through `PATCH /api/v1/auth/users/:id`) succeeds when the guard's admin cache entry cannot be deleted, but if Redis came back with that entry, the revoked token was accepted again until the entry expired (30 s). The failed delete now stays pending: the instance that made it deletes the entry before reading it again (and checks the database while it cannot) and resends the delete every second, so other instances stop accepting the token as soon as Redis takes the delete. While Redis stays unreachable for the revoking instance only, another instance can still read the old entry until it expires.

### Changed — security checks fail within half a second while Redis is down

The security state store (MFA and emergency-token counters, the token revocation cache, SAML codes) waited about 10 s per call while Redis was unreachable (ioredis reconnect retries) before failing, so `POST /api/v1/auth/mfa/challenge`, `POST /api/v1/auth/saml/exchange` and emergency-token requests hung that long before their `503`, and every authenticated request waited that long before the guard fell back to the database. Its client now has a connect timeout (`SECURITY_STORE_CONNECT_TIMEOUT_MS`, default 1000) and a command timeout (`SECURITY_STORE_COMMAND_TIMEOUT_MS`, default 500); a value that is not a positive whole number stops startup. The answers are the same, only sooner.

### Security — a SAML one-time code is redeemed once

`POST /api/v1/auth/saml/exchange` read the code and deleted it in two steps, so two simultaneous exchanges of one code could both get the tokens (replay). The code is now read and deleted in one step (one Lua script on Redis, one synchronous step in memory): of concurrent exchanges of a code exactly one answers `200`, the others `401` ("Auth code invalid or expired").

### Security — lockout counters and SAML codes fail closed while Redis is down

The MFA failed-attempt counter, the emergency-token failure counter, the JWT guard's admin cache (token revocation) and the SAML one-time codes were kept in the Nest cache, which reads a failed Redis call as a miss: while Redis was down after startup, the counters read as zero and MFA lockout and the emergency-token limit were off. They now use a store that rejects on Redis errors. While it fails, `POST /api/v1/auth/mfa/challenge` (and every MFA code check) and any request with `X-Emergency-Token` answer `503` ("Security checks are temporarily unavailable. Try again later.") instead of checking the code, `POST /api/v1/auth/saml/exchange` answers `503` unless the code could be used up, and the SAML callback redirects to the login error. Requests with a valid access token keep working: the guard checks revocation in the database when the cache cannot be read. A revocation (`revokeAllSessions`, password change, deactivation) still succeeds when the cache entry cannot be dropped; that entry expires within 30 s. `GET /api/v1/health/ready` gains `components.securityState` (`status` `ok` or `failing`, `backend` `redis` or `memory`, `failures`, `lastFailureAt`); `failing` makes the overall status `degraded` (HTTP 200). Counters written in the old format before the upgrade read as no failures once.

### Security — a failed distributed-transaction restore no longer spreads the user's email

When a distributed transaction could not restore a system, its dead-letter entry (`GET /api/v1/dead-letter`, `originalPayload.email`) and the `distributed_transaction.rollback_failed` event (audit, Socket.IO, event subscription webhooks) carried the user's email in clear, and so did their error message when Graph quoted the address. Both now carry it masked like identity responses (`m•••@example.com`), in `email` and inside the message; the transaction's `systems[<system>].error` gets the same masked message. Dead-letter entries written before this change keep the clear address.

### Fixed — distributed transactions refuse systems they cannot change, and a DELETE rollback restores accountEnabled

`POST /api/v1/reconciliation/distributed-transaction` accepted any `targetSystems`; a system other than `entra-id` prepared and only failed at commit (`Unknown system: <system>`), after Entra ID had committed. Prepare now refuses the transaction before taking any lock or reading any account, without retries: the workflow ends with `prepareSuccess: false` and `systems: {}`, and the Transaction Viewer shows `FAILED` with `error: "Distributed transactions can change entra-id only; not supported: <systems>"` on the refused systems. Transactions prepared before this change still fail such a system at commit and roll Entra ID back. The rollback of a `DELETE` set `accountEnabled: true`, re-enabling accounts that were disabled before the transaction; it now restores the `accountEnabled` value captured at prepare, and a snapshot without that value is `ROLLBACK_FAILED` (dead-letter entry). Distributed-transaction log lines carry the transaction id and the Entra object id instead of the user's email.

### Changed — the JSON API HR health check no longer downloads the HR feed

The `json-api-hr` health check (`GET /api/v1/reconciliation/connector-health`) fetched and parsed the whole feed. It now sends a `HEAD` request, or, when the server answers `HEAD` with `405`/`501`, the feed's own request whose body is dropped once the headers arrive; both within `CONNECTOR_HEALTH_TIMEOUT_MS` and without following redirects. The connector is `healthy` when the answer is `2xx` (`401`/`403` and anything else is `down`). A local feed file counts as healthy when it exists.

### Fixed — a distributed transaction UPDATE changes the Entra account

`POST /api/v1/reconciliation/distributed-transaction` with `operation: "UPDATE"` on `entra-id` changed nothing and still reported the system `COMMITTED`, and its rollback only set `accountEnabled`. Prepare now captures the account's object id and the current values of the attributes the update writes (`EntraService.captureUserState`, the same set bulk provisioning snapshots), stored encrypted in `rollback_snapshots`; the commit writes the user's attributes to that account (`EntraService.updateUser`); the rollback writes the captured values back (`restoreUserState`, `null` clears an attribute that was unset). A user with no Entra account in the default domain fails the prepare (`error: "No Entra ID account for this user: nothing to update"`). An UPDATE prepared before this change (no attribute values in its snapshot) is not committed (`FAILED`), and its rollback is `ROLLBACK_FAILED`. Entra ID is the only system distributed transactions commit to (prepare refuses any other, see above).

### Fixed — a distributed transaction DELETE needs a snapshot of the account first

Prepare read the Entra account before a `DELETE` (disable) and swallowed any error, so a failed read let the commit disable the account with no snapshot, and the rollback then reported `ROLLED_BACK` without re-enabling it. Now a failed read fails that system's prepare (nothing is committed), and so does a `DELETE` of a user with no Entra account (`error: "No Entra ID account for this user: nothing to disable"`). The commit refuses a `DELETE` that has no snapshot, and reports `FAILED` when the account is gone by then (`disableEntraUser` found nothing) instead of `COMMITTED`. A rollback of a committed `DELETE` without a snapshot is `ROLLBACK_FAILED` (dead-letter entry), never `ROLLED_BACK`.

### Security — distributed transaction locks are per tenant and carry no email

A distributed transaction locked each target account under `disttx:lock:<system>:<email>`: the email was in the Redis key and in `systems[<system>].lockId` (stored in the Temporal history, returned by `GET /reconciliation/result/:workflowId`), and a transaction of one tenant blocked another tenant's transaction for the same email. The key is now `disttx:lock:<tenantId>:<system>:<sha256 of the trimmed, lowercased email>`, and `lockId` is that key plus `#<timestamp>`. Transactions prepared before this change release their old keys as before.

### Changed — connector health runs each connector's health check

`GET /api/v1/reconciliation/connector-health` no longer returns stub entries (`status: "unknown"`, `_stub: true`) for Entra ID and AD. It lists the connectors installed for the request's tenant and runs each one's own health check with the tenant's saved config (Entra ID, AD and SCIM as `POST /connectors/:name/health-check` does; the other connectors through their service's `healthCheck`). Per entry: `status` is `healthy` or `down` (`unknown` with `monitored: false` for a connector that has no check), `monitored`, `lastChecked` (when the check behind the result ran, `null` if never), `responseTimeMs`, and `lastError` (`"Health check failed"`, `"No answer within <ms> ms"` or `"Not monitored: ..."`; error details stay in the server log). `uptime`, `rateLimitRemaining` and `rateLimitTotal` are `null`: they are not tracked. A check may take `CONNECTOR_HEALTH_TIMEOUT_MS` (default 5000) before it counts as down, and its result is reused for `CONNECTOR_HEALTH_CACHE_TTL_MS` (default 30000) per tenant and connector.

### Changed — connector health lists only connectors that exist

`GET /api/v1/reconciliation/connector-health` (still a stub: every entry `status: "unknown"`, `_stub: true`) listed Jira Cloud, Salesforce, Slack and Workday HR, which have no connector in EuroID. It now lists Microsoft Entra ID and Active Directory only. The readiness probe's connector name mapping drops the same four names; installed connectors are unaffected.

### Fixed — bulk rollback clears the conflict flags a low-confidence match set

When a bulk operation's Golden Record write matched an existing identity with low confidence, it flagged that identity (`metadata.correlationConflict`, `requiresReview`, `conflictDetails` with `incomingIdentityId`) and minted a new identity for the incoming record. The rollback removed the minted identity but left the other identity flagged, so the review queue kept a conflict with an identity that no longer exists. `saveToHubWithSnapshot` now stores the other identity's flags as they were, encrypted in `rollback_snapshots` (kind `hub-conflict-flags`, keyed so a retry keeps the first), just before the flagging. After removing the minted identity the rollback puts them back, only while that identity still carries this conflict (`conflictDetails.incomingIdentityId` is the removed identity), so a conflict resolved or replaced since stays as it is. `results[].hubWrite.rollbackReason` then reads `created Golden Record removed and the conflict flags it set on identity <id> put back`; an expired flags snapshot or a failed restore makes the Hub write `rolledBack: false` with the reason.

### Security — distributed transaction snapshots no longer carry personal data

Before committing, a distributed transaction reads the Entra account it will change (`id`, `userPrincipalName`, `mail`, `displayName`, `accountEnabled`) so a rollback can restore it. That state went into `systems[<system>].previousState`, so it was stored in the Temporal workflow history and returned by `GET /reconciliation/result/:workflowId`. It is now stored encrypted in the tenant-scoped `rollback_snapshots` collection (kind `entra-account`, TTL `ROLLBACK_SNAPSHOT_TTL_HOURS`), and `previousState` is `{ snapshotRef }`. The rollback reads it back under the transaction's tenant; a snapshot that has expired fails that system's restore (`ROLLBACK_FAILED`, `error: "The snapshot taken before the commit has expired"`) instead of reporting it restored. If the snapshot cannot be stored, that system's prepare fails and nothing is committed. Transactions prepared before this change still restore from the values in their `previousState`, and their results keep those values until Temporal's retention removes them.

### Fixed — a retried bulk Entra operation keeps the snapshot from before its first attempt

The Entra pre-change snapshot of a bulk `CREATE` or `UPDATE` was taken on every attempt of the system activity. When an attempt changed the account and then failed (a 429 after the write, a worker crash), the retry snapshotted the values that attempt had written, or found the account it had created, and a rollback then kept the change. The workflow now gives each system activity a key that is the same for every attempt (`<runId>/<operationId>/<system>`), and the activity stores the whole pre-change state (whether the account existed, its object id, the attribute values) encrypted under that key; a retry gets the first attempt's snapshot back. In `results[].systemResults[].previousState` such snapshots carry `snapshotKind: "entra-state"` next to `snapshotRef`; an account the first attempt created stays `{ existed: false }`, so the rollback disables it. Runs started before this change keep the unkeyed snapshot (workflow patch `bulk-provisioning:entra-snapshot-key`).

### Fixed — the Transaction Viewer shows each distributed transaction's real phase

`GET /api/v1/dev/transactions` reads the transaction log, which the API wrote once (phase `PREPARING`) when it started the transaction and nothing updated afterwards, so every transaction stayed `PREPARING`. The transaction activities now record each phase transition with each system's state (`participants[].status`, timestamps, `error`): `PREPARED` or `FAILED` after prepare, `COMMITTING`, then `COMMITTED` or `FAILED` after commit, then `ROLLING_BACK` and `ROLLED_BACK` or the new `ROLLBACK_FAILED` (a committed system could not be restored; that participant's status is `ROLLBACK_FAILED`). `completedAt` is set on `COMMITTED`, `ROLLED_BACK`, `ROLLBACK_FAILED` and `FAILED` and cleared when a rollback follows a failed commit. The workflow result (`GET /reconciliation/result/:workflowId`) is unchanged and remains authoritative: a failed write to the log is logged and never fails the transaction, and a transaction that stops without reaching an activity (a failed Golden Record save with `autoRollback: false`, a workflow timeout) keeps its last recorded phase. The `phase` filter now accepts every phase (`ROLLED_BACK`, `ROLLBACK_FAILED` and `FAILED` were rejected with `400`).

### Fixed — distributed transaction locks are released only by their owner

A distributed transaction locks each target system's user while it runs. The commit released a system's lock and a successful rollback released it a second time; with Redis that second release deleted the key whatever it held, so it could free the lock another transaction had taken on the same user in between. Each lock is now held under an owner token (tenant and `transactionId`) and released only by that owner, atomically (one Lua script per acquire or release) when `REDIS_URL` is set, with the same semantics in the in-process fallback. A repeated or late release leaves the lock as it is, and a retried prepare renews its own lock instead of failing on it. A lock held by another transaction now fails the prepare with `Resource is locked by another transaction` (was `Resource locked by transaction <id>`). A failed lock release after a commit or restore is logged and no longer turns a committed system into `FAILED` or a restored one into `ROLLBACK_FAILED`.

### Fixed — bulk rollback undoes the Golden Record write

A bulk rollback undid target system changes but never the Identity Hub write each operation makes first, so a rolled-back batch left its Golden Records created or changed. Each operation now saves the Golden Record with `saveToHubWithSnapshot`, which stores what the write overwrites (or that it creates the identity) in the encrypted `rollback_snapshots` store just before writing; a retried activity keeps the first snapshot. Results get `results[].hubWrite`: `{ identityId, snapshotRef, rolledBack?, rollbackReason? }`. The rollback handles it after the target systems: when every system change of the operation was undone it restores the profile, sources, metadata and soft-delete marker from the snapshot (`"Golden Record restored from the snapshot taken before the change"`), or hard-deletes an identity the operation created (`"created Golden Record removed"`, `IDENTITY_DELETED` with reason `bulk-rollback`); while a target system still has the change the Golden Record is kept (`"kept, because a target system still has the change"`). Provisioning state and controls are not touched. The operation's `rolledBack` is true only when its systems and its Golden Record write were all undone, and `rollbackReason` lists `hub: <reason>` when not. Operations that failed on their target systems in a fail-fast batch now have their Golden Record write undone as well, so they can show `rolledBack: true` and count in `summary.rolledBack`. The conflict flags a low-confidence correlation match sets on another identity are undone too (see the entry above). Runs started before this change keep `saveToHub` (workflow patch `bulk-provisioning:hub-compensation`).

### Security — bulk rollback snapshots no longer carry personal data

Before an Entra `CREATE` or `UPDATE`, bulk provisioning reads the attribute values it will overwrite so a rollback can restore them. Those values (names, phone numbers, job title, address fields) went into `results[].systemResults[].previousState.attributes`, so they were stored in the Temporal workflow history and returned by `GET /bulk-provisioning/results/:workflowId` and `GET /bulk-provisioning/partial-results/:workflowId`. They are now stored encrypted (`EncryptionService`) in the tenant-scoped `rollback_snapshots` collection, which expires after `ROLLBACK_SNAPSHOT_TTL_HOURS` (default 24), and `previousState` is `{ existed, objectId?, snapshotRef? }`. Both endpoints also drop `previousState.attributes` from results recorded before this change and mask the PII fields (`personalEmail`, `mobilePhone`, `workPhone`, `officeExtension`) anywhere in the results, in the format of identity responses (`m•••@example.com`, `+358 •• ••• 4567`, extension fully masked). A rollback after the snapshot expired reports `"entra-id: the snapshot taken before the change has expired"` instead of restoring. If the snapshot cannot be stored, the system fails before Entra is changed.

### Fixed — bulk provisioning runs DISABLE operations and handles every activity failure

Bulk `DISABLE` operations were partitioned and then never executed. They now run after the updates and before the deletes (phase `EXECUTING_DISABLES`, parallel batches), and the result has `breakdown.disables` (`{ total, successful, failed }`). A failed disable rolls back like any other failure; the rollback enables the account again. A non-429 activity failure (a Golden Record save, a target system activity that ran out of attempts) used to end the whole run as `FAILED` with `errors: ["Activity task failed"]`, without rollback. It now fails only its operation: a failed Hub save gives `{ success: false, error: "Golden Record save failed: <cause>", systemResults: [] }` and no target system is called for it; a failed system activity gives that system `{ success: false, error: "<cause>" }`. `continueOnError` then decides as for any failed operation: go on, or stop and roll back (`Batch execution failed: ...`). Runs started before this change keep the old behaviour (workflow patches `bulk-provisioning:run-disables` and `bulk-provisioning:failures-as-results`).

### Fixed — bulk rollback says what it did not undo

A bulk rollback reported `rolledBack: true` for every `UPDATE` and for `CREATE`s on systems other than Entra ID without undoing anything. Rollback now runs `compensateOperation` per target system and records the outcome in the result: each `results[].systemResults[]` entry it touched gets `rolledBack` (boolean) and `rollbackReason`, and the operation gets `rolledBack: true` only when every system that had succeeded was undone, with `rollbackReason` either `"Batch failed, compensating transaction"` or `"Not rolled back: <system>: <reason>; ..."`. Entra ID: before a `CREATE` or `UPDATE` the attributes it will write are read into `systemResults[].previousState` (`{ existed, objectId?, attributes? }`); the rollback writes them back to an account that existed and disables an account the operation created (by object ID, no longer by email, so a pre-existing account is never disabled). A `DISABLE` is undone by enabling the account. A `DELETE` stays not reversible (`"entra-id: a DELETE is not reversible"`). File outbound, Discord webhook, GitHub and Google Sheets cannot deprovision, so their changes are reported as `"the <system> connector cannot deprovision, so a CREATE stays"`. Operations that failed on one system but succeeded on another are now compensated too. Each Entra `CREATE`/`UPDATE` adds 2 to `apiCallsUsed` for the snapshot read. Runs started before this change keep the old rollback (workflow patch `bulk-provisioning:compensate-operation`), which now also returns false instead of true when nothing was undone.

### Fixed — bulk provisioning results

Every non-dry-run bulk provisioning batch ended `FAILED` with `"r.systemResults.values is not a function"`: per-system results were a `Map`, which Temporal serialises as `{}`. In the bulk provisioning results (workflow result and partial results), `results[].systemResults` is now an array of `{ system, success, objectId?, error?, apiCallsUsed, durationMs, skipped? }`, one per target system, instead of `{}`.

### Fixed — bulk provisioning runs under the batch tenant

Bulk provisioning saved the Golden Record and called Entra (create, update, disable, and the rollback disable) without the batch's `tenantId`, so those activities threw `[SECURITY] tenantId is required` and every non-dry-run operation failed. They now run under the `tenantId` of the bulk request.

### Fixed — admin account provisioning reaches Okta and SCIM

`adminAccountProvisioningWorkflow` (started by onboarding for privileged admin accounts) had the same bug as onboarding: it scheduled Okta and SCIM provisioning on `provisioning-default`, where no worker registers those activities, and called SCIM with the arguments in the `(user, intent, config, tenantId)` order. It now calls both on their own queues through the onboarding helpers; SCIM gets the canvas connector config as `(config, user, tenantId, correlationId)` and the admin account is marked `ERROR` for SCIM when no SCIM config is on the canvas. Runs started before this change keep the old calls (workflow patch `admin-account-provisioning:connector-queue-routing`).

### Fixed — distributed transactions report a failed rollback and release failed locks

A transaction whose rollback could not restore a committed system (for example the Entra delete of a created account failed) was still reported `phase: "ROLLED_BACK"`, `rolledBack: true`. In the workflow result (`GET /reconciliation/result/:workflowId`) and the `getTransactionPhase` query, such a transaction now ends with the new phase `ROLLBACK_FAILED` and `rolledBack: false`, and the system that kept the change has the new per-system status `ROLLBACK_FAILED` with the restore error in `systems["<system>"].error` (it used to stay `COMMITTED`). A system that fails to commit now releases its lock at once; it used to hold the user locked for that system until the 5-minute lock TTL, so a retry for the same user failed prepare with `Resource locked by transaction ...`. Runs started before this change keep reporting `ROLLED_BACK` (workflow patch `distributed-transaction:rollback-failed-status`).

### Fixed — onboarding provisions to Okta and SCIM

The worker registers Okta and SCIM activities only on their own task queues (`provisioning-okta`, `provisioning-scim`), but onboarding scheduled them on `provisioning-default`, so a joiner with an Okta or SCIM target never got past the health check. SCIM was also called with the arguments in the wrong order, and its health result `{ healthy }` counted as healthy even when `healthy` was false. Onboarding now calls both on their own queues; SCIM gets the canvas connector config as `(config, user, tenantId, correlationId)` and fails the run when `healthy` is false or no SCIM config is on the canvas. Runs started before this change keep the old calls (workflow patch `onboarding:connector-queue-routing`).

### Fixed — distributed transactions commit

`prepareTransaction` returned its per-system state as a `Map`, which Temporal serialises as `{}`, so every commit failed with `systemTransactions.entries is not a function` and the transaction ended `FAILED`. The per-system state is now a plain object keyed by system, and the workflow result's `systems` is `{ "<system>": { system, status, ... } }`. A failed rollback restore is now written to the dead-letter queue under the transaction's `tenantId` instead of `no-tenant`. Runs started before this change keep the old commit check (workflow patch `distributed-transaction:plain-object-systems`).

### Fixed — distributed transactions run Entra calls under the request tenant

The distributed transaction activities called Entra (`validateUpn` in prepare, `provisionUserToEntra` and `disableEntraUser` in commit) without the transaction's `tenantId`. Those activities throw `[SECURITY] tenantId is required`, so every Entra `CREATE` failed prepare and every Entra commit failed. They now receive the `tenantId` and `correlationId` of the transaction.

### Fixed — onboarding connector calls run under the workflow tenant

Onboarding called the health check of every connector except Entra (including AD) as `check<X>Health(tenantId, correlationId)`, while the activities take `(config, tenantId, correlationId)`: the check ran under the workflow ID as its tenant, with the tenant ID as its config. Onboarding and admin account provisioning also called Okta-style `provisionUserTo<X>(user, intent, tenantId, ...)` without the `config` argument, so the tenant ID landed in the config slot. All of them now pass the tenant in the `tenantId` position.

### Fixed — offboard impact reports lookup failures

`GET /api/v1/identity/:id/offboard-impact` answered `200` with no entitlements when the active access requests could not be read, so a failure looked like "no impact". It now answers `500` with the standard error body `{ "statusCode": 500, "message": "Internal server error" }`; the cause is in the server log.

### Fixed — JSON API HR connector follows no redirects

Unauthenticated `json-api-hr` requests followed HTTP redirects, and the SSRF guard checks only the configured URL, so an HR endpoint could redirect the connector to a private or cloud-metadata address. No request follows redirects now, with or without auth; a 3xx response fails the fetch with `JsonApiHrConnector: HTTP 3xx`. Configure the final URL.

### Changed — bulk provisioning backs off on HTTP 429

Each target system of an operation now runs in its own activity (`executeSystemOperation`, after the Golden Record save). A 429 from a target fails that activity, and `RateLimitActivityInterceptor` makes it a retryable failure of type `RateLimited` with the target's retry-after as the next retry delay (`BATCH_OPERATION_RETRY`, 3 attempts). Only the rate-limited system is retried; systems of the same operation that already succeeded are not called again. If the attempts run out, that system's entry in `results[].systemResults` is `{ success: false, error: "Rate limit retries exhausted: ..." }` and the operation counts as failed: with `continueOnError: true` the batch goes on and ends `PARTIAL_SUCCESS` or `FAILED` by the usual counts, without it the batch stops and ends `FAILED` with `Batch execution failed: ...`. Operations that a run started before this change had already scheduled replay on the old single `executeOperation` activity (workflow patch `bulk-provisioning:per-system-activities`). `metrics.rateLimitHits` counts rate limiter throttles only.

### Fixed — bulk provisioning fail-fast rolls back and reports the failed batch

With `continueOnError` false, a batch with a failed operation ended the run straight away: the successful operations of earlier batches (and earlier phases) were never rolled back, and the failed batch's results were missing from the `FAILED` result. Now the run keeps the failed batch's results, rolls back every successful operation so far (phase `ROLLBACK`, the same compensation as the end-of-run rollback), and returns `status: "FAILED"` with `errors: ["Batch execution failed: ..."]`, all results so far in `results` (rolled-back ones with `rolledBack: true`), and `summary`, `breakdown` and `metrics` counted from those results instead of zeros. Deletes, which cannot be undone, now stop at the first failed delete (`errors: ["DELETE <operationId> failed. Stopping execution before the remaining DELETEs."]`) instead of running the rest first. If the rollback itself fails, the result adds `"Rollback failed: ..."` to `errors`. Rollback still runs only with `continueOnError` false; there is no separate rollback flag. Runs started before this change keep the old behaviour (workflow patch `bulk-provisioning:fail-fast-rollback`).

### Added — bulk DELETE on Entra ID

A bulk `DELETE` operation targeting `entra-id` used to fail with `Unsupported operation type: DELETE`. It now deletes the user in Entra ID under the batch tenant (`results[].systemResults[]` entry `{ system: "entra-id", success: true, apiCallsUsed: 1 }`; a user that is already gone counts as deleted). A delete cannot be rolled back: EuroID has no restore call. When a batch rolls back, a successful `DELETE` keeps `rolledBack` unset and gets `rollbackReason: "Not rolled back: entra-id: a DELETE is not reversible"`, and it still counts as successful. Entra keeps a deleted user under Deleted users for 30 days, where an admin can restore it by hand. Deletes still run last, one at a time, behind `requireApprovalForDeletes` when set.

### Fixed — bulk provisioning waits out its own rate limiter

The rate limiter's `checkAndWait` computed a throttle delay that bulk provisioning only logged, so operations went on at full speed past the configured per-system limits. Each system activity now sleeps the delay (500 ms to 10 s by utilization) before calling the system. A longer wait, such as an exhausted hourly window, is not slept in the activity: it fails the activity as a `RateLimited` retry after that delay, the same path as a target's HTTP 429. The in-activity ceiling is `RATE_LIMIT_MAX_IN_ACTIVITY_WAIT_MS` (default 30000). `metrics.rateLimitHits` counts the throttles that were waited out.

### Fixed — per-tenant `profile.correlationId` uniqueness

The unique `{ tenantId, profile.correlationId }` index on `identities` used `$ne: null` in its `partialFilterExpression`, which MongoDB rejects, so the index was never created and two identities in one tenant could share a hashed national ID. The filter is now `{ 'profile.correlationId': { $type: 'string' } }`. Run `npm run migrate:up` (the Dockerfile does this on start): migration `20261121000000-identity-correlation-id-unique-index` creates the index, or fails without changing data and lists each duplicated `(tenantId, correlationId)` pair, which must be merged before rerunning.

### Fixed — doubled `/api/v1/api/v1` prefix

`AuthLocalController`, `MfaController`, `SamlAuthController` and `CredentialLifecycleController` repeated the global `api/v1` prefix in `@Controller()`, so their routes were served at `/api/v1/api/v1/...` and the documented paths returned 404. They now live at the documented paths: `/api/v1/auth/*`, `/api/v1/auth/mfa/*`, `/api/v1/auth/saml/*` (including the SAML ACS `POST /api/v1/auth/saml/callback`, which now matches the default `SAML_CALLBACK_URL`) and `/api/v1/credential-lifecycle/*`. The doubled paths now return 404. The global prefix lives in `backend/src/infrastructure/config/global-prefix.ts`; `backend/src/app-routes.spec.ts` fails if any route starts with `/api/v1/api/v1`.

### Added — JSON API HR connector authentication

`json-api-hr` accepts optional auth config (install/update via `POST /api/v1/connectors/json-api-hr/install` / `PATCH /api/v1/connectors/json-api-hr`): `authType` (`none` default, `bearer`, `header`), `bearerToken` (sent as `Authorization: Bearer ...`), `authHeaderName` + `authHeaderSecret` (custom header such as `X-API-Key`). Stored encrypted with the rest of the connector config; `bearerToken` and `authHeaderSecret` are redacted in `GET /api/v1/connectors`. Requests do not follow redirects. Local file mode is unchanged and ignores auth.

### Changed — identity PII masked, audited reveal

- Identity responses mask `personalEmail`, `mobilePhone`, `workPhone` and `officeExtension` at any depth: every `IdentityController` route (`GET /identity`, `GET /identity/:id`, `GET /identity/v2/:id`, `GET /identity/v2/by-email`, conflicts, uncorrelated (including `sources[].rawData`), candidates, events, and the `user`/`identity` returned by create, update, link, standalone, resolve-conflict and controls). Email: `m•••@example.com`; phone: `+358 •• ••• 4567` (a separated country code and the last four digits stay visible when at least as many digits are masked); extension: every character masked. Masking is applied at the HTTP boundary (`MaskPiiInterceptor`); services, workflows and `GET /identity/:id/dsar-export` (GDPR, audited separately) still see clear values.
- `POST /identity` and `PATCH /identity/:id` answer `400` when one of those fields carries a masked value (contains `•`), so a GET body sent back cannot overwrite the stored value. The frontend omits PII fields the user has not revealed and edited.
- Added `POST /api/v1/identity/:id/pii/reveal` (operator) — body `{ field }`, where `field` is one of the four fields above (anything else is `400`). Writes the `PII_REVEALED` audit entry (`resourceId` = identity id, `resourceName` = field, `payload.metadata` = `{ field, identityId }`, never the value) and only then returns `{ identityId, field, value }` (`value: null` when empty) with `Cache-Control: no-store`. If the audit write fails the request fails and no value is returned. Tenant-scoped: an identity of another tenant, or a soft-deleted one, is `404`. Rate-limited per client: `PII_REVEAL_THROTTLE_SHORT_LIMIT` per second (default 5) and `PII_REVEAL_THROTTLE_MEDIUM_LIMIT` per minute (default 30).
- Removed `POST /api/v1/audit/pii-reveal`: it let a client write `PII_REVEALED` entries without receiving any value, while the value itself came unaudited in every identity response. The reveal endpoint above replaces it.

### Changed — connector secrets declared per manifest

`GET /api/v1/connectors` masked config keys that contained `clientSecret`, `password`, `apiKey`, `secret`, `token` or `serviceAccount`. Secrets are now the fields each connector manifest declares `type: 'password'`; a connector without a registered manifest gets every key masked. Effects: Discord `webhookUrl` (it embeds the webhook token) is now masked and is a password field in the manifest and the Design studio form; SCIM `oauth2TokenUrl` and AD `serviceAccount` (the bind DN) are no longer masked. `PATCH /api/v1/connectors/:name` keeps the stored value of a secret field when `••••••••` or `''` is sent for it, as before.

### Fixed — request bodies cannot name a tenant

`POST /api/v1/identity` stored the identity under the body's `tenantId`, so a caller could write identities into another tenant. The tenant now comes only from the authenticated request (the JWT tenant); a `tenantId` in a request body is dropped:

- `POST /identity`: body schema `CreateUserDto` (the golden record without `tenantId`; `StandardUserDto` stays in the spec as the identity model). `PATCH /identity/:id` (`UpdateUserDto`) no longer lists `tenantId` (it was already ignored).
- `POST /connectors/:name/ingest` takes no body (it took `{ tenantId? }`). HR rows land in the caller's tenant; the CSV HR and JSON API HR `tenantId` config fields are removed and a stored value is ignored.
- `POST /bulk-provisioning/start` (`tenantId`, `operations[].user.tenantId`), `POST /reconciliation/start-daily` (`tenantId`, no longer required) and `POST /reconciliation/distributed-transaction` (`tenantId`, `user.tenantId`): the workflow runs in the caller's tenant. The `start-daily` response `tenantId` is that tenant.
- `POST /blueprints/impact-analysis`: `users[].tenantId` is dropped (the analysis already ran in the caller's tenant).
- SCIM `POST /scim/v2/Users` creates the identity in the SCIM token's tenant (it used tenant `default`).

`scripts/check-request-tenant-fields.sh` (CI) fails when a request schema or controller accepts a tenant id again.

### Fixed — old PII values in `IDENTITY_UPDATED`

`IDENTITY_UPDATED.previousAttributes` carried the old clear value of every changed field into the audit log (`GET /audit`, analytics search) and the tenant websocket. PII fields (`personalEmail`, `mobilePhone`, `workPhone`, `officeExtension`) are now masked there the same way as in identity responses (`m•••@example.com`, `+358 •• ••• 4567`); the key stays, so a timeline still shows that the field changed. Other fields keep their old values.

### Fixed — PII in drift records

A field drift on `mobilePhone` carried the hub and target numbers in clear in `expectedValue`, `actualValue` and `description`, and from there in the `DRIFT_DETECTED` discrepancies (`expected`, `actual`) that reach the audit log, the identity timeline (`GET /identity/:id/events`) and the websocket. Values are still compared in clear, so detection is unchanged, but a PII field's values are now stored and emitted masked (`+358 •• ••• 4567`). Corrections re-provision from the hub record and do not use these values.

### Fixed — `GET /connectors` returned the config ciphertext

Each item of `GET /api/v1/connectors` carried `configEncrypted`, the ciphertext of the whole connector config, secrets included, next to the masked `config`. The field is no longer returned.

### Changed — Design studio and dead-letter secrets follow the manifest

Canvas node configs and `connectorConfigs` (`POST /blueprints/save`, `PATCH /blueprints/:id`) were encrypted at rest only when a key contained `clientSecret`, `password`, `apiKey`, `secret` or `token`, so a Discord `webhookUrl` was stored in clear. They are now encrypted when they hold a field the connector manifest declares `type: 'password'` (connector from `data.type`, `nodeType` or the `connectorConfigs` key); a config that names no registered connector is encrypted whole. Responses are unchanged. `GET /dead-letter` and `GET /dead-letter/:id` redact the payload of an entry whose `source` is a registered connector by that connector's declared secrets; other entries keep the key-name redaction.

### Added — per-identity entitlements

- `GET /api/v1/identity/:id/entitlements` (viewer) — entitlements the identity should hold, as `{ identityId, entitlements: [{ id, entitlement, type, source, targetSystem, grantedBy, status }] }`. Two sources: group/license/role grants from active policies evaluated against the golden record (`grantedBy: "policy"`, `source` = policy name) and entitlements of the identity's `ACTIVE`/`PROVISIONING` access requests (`grantedBy: "request"`, `source` = `Access request <requestId>`). `status` is `Active` | `Pending` | `Revoked`: for policy grants it follows the target system's provisioning state (`SYNCED` → Active, `DEPROVISIONED` → Revoked, otherwise Pending); for request grants it follows the request status. Tenant-scoped; 404 when the identity is not in the caller's tenant. Consumed by the identity Access tab. Data is gathered over the new query event `identity.entitlements_query` (handlers in PolicyModule and AccessRequestsModule), so each call also writes an audit entry like `identity.offboard_impact_query` does.

### Added — NHI (Non-Human Identity) module

New first-class domain for service accounts, workload identities, AI agents, and bots. All endpoints are tenant-scoped. See `backend/src/modules/nhi/docs/ARCHITECTURE.md`.

- `GET /api/v1/nhi` (viewer) — list NHIs, filter by `ownerIdentityId`, `kind`, `status`, `riskTier`
- `GET /api/v1/nhi/:agentId` (viewer) — get one
- `POST /api/v1/nhi` (super-admin) — create; required: `agentId`, `displayName`, `kind`, `ownerIdentityId`, `scope[]`, `expiresAt` (ISO, ≤ 90 days)
- `POST /api/v1/nhi/:parentAgentId/delegate` (super-admin) — create sub-agent; child scope must be a subset and `expiresAt` must not exceed the parent's
- `POST /api/v1/nhi/:agentId/revoke` (super-admin) — terminal revocation, cascades to descendants
- `POST /api/v1/nhi/:agentId/kill` (super-admin) — engage sticky kill-switch (critical severity)
- `POST /api/v1/nhi/:agentId/credentials` (super-admin) — issue short-lived Ed25519-signed credential (SPIFFE-compatible); TTL ≤ 3600s and further clamped to the agent's own `expiresAt`. Requires `NHI_SIGNING_PRIVATE_KEY` to be configured; otherwise returns 409
- `GET /api/v1/nhi/_/credential-signing-status` (super-admin) — whether credential issuance is configured

New domain events (envelope + Zod-registered payloads): `nhi.created`, `nhi.delegated`, `nhi.revoked`, `nhi.kill_switch_engaged`, `nhi.credential_issued`, `nhi.credential_rotated`.

---

## [2.0.0] — 2026-03 — Intelligence, Scale & Hybrid Cloud

> Waves 2–5: connectors, intelligence, cell architecture, CIEM, remote agents, and audit remediation.

### ~~Added — Slack Connector~~

> **Correction (2026-11-22):** not shipped. No `slack` connector exists in `backend/src/modules/connectors/` or in this repository's git history, and none is registered in `plugin/register-connectors.ts`. Removed from this entry; the original text is in git history.

### ~~Added — Generic REST Outbound Connector~~

> **Correction (2026-11-22):** not shipped. No `generic-rest-outbound` connector exists in `backend/src/modules/connectors/` or in this repository's git history, and none is registered in `plugin/register-connectors.ts`. Removed from this entry; the original text is in git history.

### ~~Added — Google Workspace Connector~~

> **Correction (2026-11-22):** not shipped. No `google-workspace` connector exists in `backend/src/modules/connectors/` or in this repository's git history, and none is registered in `plugin/register-connectors.ts`. Removed from this entry; the original text is in git history.

### ~~Added — Workday HR Connector~~

> **Correction (2026-11-22):** not shipped. No `workday-hr` connector exists in `backend/src/modules/connectors/` or in this repository's git history, and none is registered in `plugin/register-connectors.ts`. Removed from this entry; the original text is in git history.

### Added — Multi-Contract Identity: Contract-Scoped Provisioning (TASK-236)

**Identity schema:** New `contracts: ContractProfile[]` sub-document on `Identity`. Fields: `sourceRef`, `externalId`, `isPrimary`, `status`, plus employment-scoped attributes (`jobTitle`, `departmentName`, `division`, etc.).

**ProvisioningState:** New optional `contractRef` field on provisioning entries.

**Connector config:** New optional `boundContractSource` field on `PATCH /api/v1/connectors/:name` and `POST /api/v1/connectors/:name/install`. When set, the provisioning workflow resolves contract-specific employment attributes for that target.

**EmploymentContract DTO:** New optional `sourceRef` field.

**Contract API:** New `GET /api/v1/identity/:id/contracts` endpoint (role: `viewer`). Returns `{ identityId, contracts[], total }`.

**No breaking changes.** All new fields are optional with backwards-compatible defaults.

> **Correction (2026-11-25):** most of this entry never shipped. The `Identity` schema has no `contracts` sub-document and provisioning entries have no `contractRef` (`backend/src/modules/identity/schemas/identity.schema.ts`); no connector config takes `boundContractSource`; `GET /api/v1/identity/:id/contracts` does not exist (not in `swagger-spec.json`); `EmploymentContract` has no `sourceRef`. `ContractProfile`, `contractRef` and `boundContractSource` appear nowhere in the backend's git history. What exists instead: `StandardUserDto.contracts` (`id`, `title`, `department`, `isPrimary`, `status`; `backend/src/shared/dtos/standard-user.dto.ts`), and the contracts the policy engine evaluates, built per HR source when a policy profile is read (`IdentityOnionService.buildProfileWithContractsForPolicy`, `backend/src/modules/identity/identity-onion.service.ts`).

### Added — Cell Management API (A-11)

| Method | Path | Role | Description |
|---|---|---|---|
| POST | `/api/v1/cells` | super-admin | Create a new cell for physical tenant isolation |
| GET | `/api/v1/cells` | super-admin | List all cells with tenant counts |
| GET | `/api/v1/cells/:cellId` | super-admin | Get cell details |
| GET | `/api/v1/cells/:cellId/health` | super-admin | Check cell health (MongoDB connectivity) |
| POST | `/api/v1/cells/:cellId/migrate` | super-admin | Migrate a tenant to this cell |

New collection: `cells`.
Tenant schema extended: `cellId` field (default: `'shared'`).
New domain events: `cell.created`, `cell.tenant_migrated`, `cell.health_check_failed`.
Config: `CELL_DEFAULT_ID` (default `shared`), `CELL_MONGO_POOL_SIZE` (default 10), `CELL_CACHE_TTL_SECONDS` (default 60), `CELL_CONFIG_PATH` (optional JSON).

### ~~Added — KEDA Worker Scaling (A-12)~~

> **Correction (2026-11-22):** not shipped. `backend/src/workers/` and the Kubernetes/KEDA manifests do not exist and never did in this repository's history; `backend/src/worker.ts` is still the single worker entry point. The `start:worker:default|entra|ad|reconciliation|scheduled` scripts that pointed at the missing `src/workers/*.ts` files were removed from `backend/package.json`; use `start:worker` (or `start:worker:watch`). Design: `docs/architecture/future/FUTURE_KEDA_SCALING.md`. Removed from this entry; the original text is in git history.

### Added — CIEM Cloud Entitlement Management (A-06, A-07, A-08)

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/api/v1/ciem/overview` | policy-admin | Dashboard stats: total identities, over-permissioned count, avg/median score |
| GET | `/api/v1/ciem/identities` | policy-admin | List identities with cloud permissions (paginated, sorted by score) |
| GET | `/api/v1/ciem/identities/:id` | policy-admin | Detailed effective + used + unused permissions for an identity |
| GET | `/api/v1/ciem/identities/:id/unused` | policy-admin | Unused permissions and right-sizing suggestions |
| POST | `/api/v1/ciem/analyze` | super-admin | Trigger on-demand CIEM analysis |
| GET | `/api/v1/ciem/recommendations` | policy-admin | Paginated right-sizing recommendations across all identities |
| GET | `/api/v1/ciem/runs` | policy-admin | Analysis run history |

New collections: `cloud_permissions`, `ciem_analysis_runs`.
New connector: `aws-iam` (read-only discovery, CloudTrail usage analysis).
New Temporal workflow: `ciemAnalysisWorkflow` (weekly automated analysis, 5 phases).
Risk scoring updated: cloud over-permission added as 8th risk factor (weight: 15).
New domain events: `ciem.analysis_completed`, `ciem.over_permission_detected`, `ciem.recommendation_generated`.
Config: `CIEM_USAGE_WINDOW_DAYS` (default 90), `CIEM_HIGH_RISK_THRESHOLD` (default 70), `CIEM_ANALYSIS_CRON` (default `0 2 * * 0`), `RISK_WEIGHT_CLOUD_OVER_PERMISSION` (default 15).

### Added — Feature Flags + OPA Policy Engine (A-15, A-01, A-02)

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/api/v1/feature-flags` | super-admin | List all feature flags with effective status |
| PUT | `/api/v1/feature-flags/:key` | super-admin | Set a feature flag (body: `{ enabled, tenantId? }`) |
| DELETE | `/api/v1/feature-flags/:key` | super-admin | Delete a feature flag |

New collection: `feature_flags`.
New infrastructure modules: `infrastructure/feature-flags/` (global), `infrastructure/opa/`.
New policy module additions: `PolicyToRegoCompiler`, `GitSyncService`.
New event types: `policy.compiled_to_rego`, `opa.evaluation_failed`.
Default flags seeded on startup: `FEATURE_ANOMALY_DETECTION`, `FEATURE_RISK_SCORING`, `FEATURE_BULK_OPERATIONS`, `FEATURE_PAM`, `FEATURE_POLICY_ENGINE_MODE`.
`PolicyEngineService` supports three modes via `FEATURE_POLICY_ENGINE_MODE`: `typescript` (default), `opa` (OPA sidecar), `hybrid` (OPA with 2s timeout, TypeScript fallback).
Rego compiler translates all 12 policy operators to valid Rego. Compiled policies synced to local `policies/` directory.
Config: `OPA_URL` (default `http://localhost:8181`), `OPA_TIMEOUT_MS` (default 5000), `OPA_POLICY_PATH` (default `euroid/policy`).

### Added — Identity Event Sourcing + Time-Travel API (I-01, I-02, I-03)

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/api/v1/identity/:id/history` | viewer | Paginated event stream for an identity |
| GET | `/api/v1/identity/:id/at?timestamp=ISO8601` | viewer | Reconstruct identity state at a point in time |
| GET | `/api/v1/identity/:id/diff?from=5&to=10` | viewer | Diff between two identity versions |

New collections: `identity_events`, `identity_snapshots`, `gdpr_erasure_markers`.
9 event types captured: IdentityCreated, ProfileUpdated, SourceLinked, SourceUnlinked, ControlOverrideSet, ProvisioningStateChanged, StatusChanged, IdentityDeleted, IdentityRestored.
OCC with retry (up to 3 attempts on version conflict). Snapshot strategy: every 100 events (configurable via `EVENT_STORE_SNAPSHOT_INTERVAL`).
GDPR cascade: event store + snapshots purged on erasure; time-travel API returns 410 Gone for erased identities.
Config: `EVENT_STORE_SNAPSHOT_INTERVAL`, `EVENT_STORE_MAX_EVENTS_PER_QUERY`.

### Added — CQRS Read Model + Identity Search (I-04, I-05)

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/api/v1/identity/search` | viewer | Full-text + filtered identity search (ES or MongoDB fallback) |
| GET | `/api/v1/identity/facets` | viewer | Faceted aggregation counts (status, department, location, etc.) |
| GET | `/api/v1/identity/export` | operator | CSV export of identities |

New infrastructure: `infrastructure/elasticsearch/` (optional — no-op when `ELASTICSEARCH_URL` not set).
Flat IdentityReadDto projection from Onion Model. Event-driven ES indexing via `@OnEvent` handlers.
MongoDB fallback for all queries when Elasticsearch is disabled.
Backfill script: `scripts/backfill-read-model.ts`. Replay script: `scripts/replay-identity.ts`.
Config: `ELASTICSEARCH_URL`, `ELASTICSEARCH_IDENTITY_INDEX`, `ELASTICSEARCH_REQUEST_TIMEOUT_MS`.

### Added — Analytics v2: ES-backed Audit Search & Seasonal Patterns

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/api/v1/analytics/v2/search` | viewer | Full-text audit event search with filters (action, actor, targetSystem, date range) |
| GET | `/api/v1/analytics/v2/seasonal-patterns` | viewer | ES date_histogram seasonal patterns (falls back to v1 MongoDB if ES unavailable) |
| GET | `/api/v1/analytics/v2/status` | viewer | ES availability and indexed event count |
| POST | `/api/v1/analytics/v2/backfill` | super-admin | Backfill audit events from MongoDB into Elasticsearch |

New services: `AnalyticsIndexerService` (domain event → ES bulk index), `AnalyticsSearchService` (ES query executor).
Real-time indexing of `identity.created`, `identity.updated`, `provisioning.completed` events into `euroid-audit-events` index.
Backfill processes MongoDB `audit_events` collection in batches of 500.
Architecture doc: `modules/analytics/docs/ARCHITECTURE.md`.

### Added — Graph Database + Access Explorer (I-08, I-09, I-10)

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/api/v1/access-explorer/identity/:identityId/access` | operator | All access for an identity (direct + inherited) |
| GET | `/api/v1/access-explorer/entitlement/:entitlementId/holders` | operator | All holders of an entitlement (direct + inherited) |
| GET | `/api/v1/access-explorer/path?identityId=&entitlementId=` | operator | Access paths between identity and entitlement |
| GET | `/api/v1/access-explorer/identity/:identityId/graph` | operator | Full access subgraph for UI rendering |

New infrastructure: `infrastructure/graph/` (Neo4j, optional — no-op when `NEO4J_URL` not set).
New config: `NEO4J_URL`, `NEO4J_USER`, `NEO4J_PASSWORD`, `NEO4J_DATABASE`.
New module: `modules/access-explorer/`.
Enhanced: `SodService.validateWithIdentity()` — transitive SoD via graph traversal.
Seed script: `scripts/seed-graph.ts` — populate Neo4j from MongoDB.

### Added — Role Mining / Role Discovery (I-13)

| Method | Path | Role | Description |
|---|---|---|---|
| POST | `/api/v1/role-mining/runs` | policy-admin | Start a new role mining run |
| GET | `/api/v1/role-mining/runs` | policy-admin | List mining runs for tenant (paginated) |
| GET | `/api/v1/role-mining/runs/latest` | policy-admin | Latest completed mining run |
| GET | `/api/v1/role-mining/runs/:runId` | policy-admin | Get mining run by ID |
| GET | `/api/v1/role-mining/runs/:runId/clusters` | policy-admin | Clusters for a run (paginated) |
| GET | `/api/v1/role-mining/clusters/:clusterId` | policy-admin | Cluster detail with members + entitlements |
| POST | `/api/v1/role-mining/clusters/:clusterId/promote` | policy-admin | Promote cluster → role bundle |
| POST | `/api/v1/role-mining/clusters/:clusterId/dismiss` | policy-admin | Dismiss cluster |
| GET | `/api/v1/intelligence/role-mining-insights` | policy-admin | Role mining summary for intelligence dashboard |

New collections: `role_mining_runs`, `role_clusters`.
New event types: `role_mining.completed`, `role_mining.cluster_promoted`.
Jaccard similarity clustering: Union-Find agglomerative approach, O(n²) pairwise. Capped at 5000 identities per run (`ROLE_MINING_MAX_IDENTITIES`).
Temporal workflow: `role-mining.workflow.ts` (30-min timeout for large tenants).
Config: `ROLE_MINING_MAX_IDENTITIES`, `ROLE_MINING_DEFAULT_MIN_CLUSTER_SIZE`, `ROLE_MINING_DEFAULT_SIMILARITY_THRESHOLD`, `ROLE_MINING_DEFAULT_MAX_CLUSTERS`.

### Added — Shared Signals SSF/CAEP (I-11, I-12)

| Method | Path | Role | Description |
|---|---|---|---|
| POST | `/.well-known/sse` | public | Inbound SSF receiver — accepts Security Event Tokens (SETs) from IdPs |
| POST | `/api/v1/shared-signals/streams` | super-admin | Create SSF stream (inbound or outbound) |
| GET | `/api/v1/shared-signals/streams` | super-admin | List SSF streams for tenant |
| GET | `/api/v1/shared-signals/streams/:id` | super-admin | Get SSF stream by ID |
| PATCH | `/api/v1/shared-signals/streams/:id` | super-admin | Update SSF stream |
| DELETE | `/api/v1/shared-signals/streams/:id` | super-admin | Delete SSF stream |

New collection: `ssf_streams`.
New event types: `ssf.signal_received`, `ssf.signal_transmitted`, `ssf.delivery_failed`.
Outbound transmitter listens for domain events (anomaly, identity status, access review revocation, credential rotation) and delivers signed SETs to registered receivers.
Config: `SSF_ENABLED`, `SSF_SIGNING_KEY_PATH`, `SSF_MAX_STREAMS_PER_TENANT`, `SSF_DELIVERY_MAX_RETRIES`, `SSF_REPLAY_WINDOW_SECONDS`.

### Added — JIT Privileged Access Sessions (A-03, A-04, A-05)

| Method | Path | Role | Description |
|---|---|---|---|
| POST | `/api/v1/jit-sessions` | operator | Request a JIT privileged access session |
| POST | `/api/v1/jit-sessions/:id/check-in` | operator | Check in and receive temporary credentials |
| POST | `/api/v1/jit-sessions/:id/heartbeat` | operator | Send heartbeat to confirm session active |
| POST | `/api/v1/jit-sessions/:id/check-out` | operator | Check out and revoke credentials |
| POST | `/api/v1/jit-sessions/:id/force-revoke` | super-admin | Force-revoke an active session |
| GET | `/api/v1/jit-sessions` | operator | List JIT sessions |
| GET | `/api/v1/jit-sessions/active` | super-admin | All active sessions (admin view) |
| GET | `/api/v1/jit-sessions/:id` | operator | Session details |

New collection: `jit_sessions`.
New event types: `jit_session.requested`, `jit_session.checked_in`, `jit_session.checked_out`, `jit_session.expired`, `jit_session.force_revoked`.
Signal-driven Temporal workflow: `jit-session.workflow.ts` — heartbeat monitoring with configurable grace period.
Break-glass support: bypasses approval with forced audit trail.
Config: `JIT_SESSION_MAX_DURATION_MINUTES`, `JIT_SESSION_HEARTBEAT_INTERVAL_MINUTES`, `JIT_SESSION_GRACE_PERIOD_MINUTES`, `JIT_SESSION_MAX_CONCURRENT_TIER0`, `JIT_SESSION_CHECK_IN_TIMEOUT_MINUTES`.

### Added — Identity Verification / Proofing (A-09, A-10)

| Method | Path | Role | Description |
|---|---|---|---|
| POST | `/api/v1/identity-verification/initiate` | operator | Start identity verification |
| GET | `/api/v1/identity-verification/:identityId` | operator | Current verification status |
| GET | `/api/v1/identity-verification/:identityId/history` | operator | Verification history |
| POST | `/api/v1/identity-verification/webhook/:provider` | public | Provider webhook callback (HMAC verified) |
| POST | `/api/v1/identity-verification/:id/approve` | super-admin | Manual approval (MANUAL provider) |

New collection: `identity_verifications`.
New event types: `identity_verification.initiated`, `identity_verification.completed`, `identity_verification.failed`.
Provider adapter interface (`IVerificationProvider`) + manual adapter for dev/test.
Verification policy: Tier 0 PAM → IAL2, external contractors → IAL2, standard employees → IAL1 (no verification).
Temporal workflow: `identity-verification.workflow.ts` — poll + webhook signal hybrid, 72h timeout.
Config: `IDENTITY_VERIFICATION_ENABLED`, `IDENTITY_VERIFICATION_DEFAULT_PROVIDER`, `IDENTITY_VERIFICATION_TIMEOUT_HOURS`, `IDENTITY_VERIFICATION_VALIDITY_DAYS`.

### Added — SCIM 2.0 Outbound Connector (I-14)

New connector: `scim-outbound` — push-based SCIM 2.0 provisioning to external SaaS systems.
Follows 5-File Pattern: client, mapper, service, module, manifest + activities.
Supports bearer token and OAuth2 (client_credentials) auth. Idempotent provision (409 handling), 404→recreate on update, paginated discovery.
Task queue: `provisioning-scim-outbound`. Activity bindings: `checkScimOutboundHealth`, `provisionUserToScimOutbound`, `disableScimOutboundUser`, `discoverScimOutboundEntitlements`.

### Added — Connector Sandbox Runtime (I-06, I-07)

Opt-in child-process sandbox for connector execution (`SANDBOX_ENABLED=true`).
SSRF network allowlist: blocks private IPs (10.x, 172.16-31.x, 192.168.x, 169.254.x, loopback) and localhost at the `net.Socket.connect` level.
Config: `SANDBOX_ENABLED`, `SANDBOX_CPU_TIMEOUT_MS`, `SANDBOX_MEMORY_LIMIT_MB`, `SANDBOX_DEFAULT_NETWORK_ALLOWLIST`.
Added `sandboxCompatible` and `resourceLimits` fields to `ConnectorManifest` interface.

### Added — Credential Lifecycle Management (F-09, F-10, F-11)

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/api/v1/credential-lifecycle/inventory/:identityId` | operator | Credential inventory for an identity |
| GET | `/api/v1/credential-lifecycle/expiring` | operator | Credentials due for rotation |
| GET | `/api/v1/credential-lifecycle/compliance` | policy-admin | Compliance summary (counts by status) |
| POST | `/api/v1/credential-lifecycle/policies` | policy-admin | Create credential policy |
| GET | `/api/v1/credential-lifecycle/policies` | policy-admin | List credential policies |
| PATCH | `/api/v1/credential-lifecycle/policies/:id` | policy-admin | Update credential policy |
| DELETE | `/api/v1/credential-lifecycle/policies/:id` | policy-admin | Delete credential policy |

New collections: `credential_inventory`, `credential_policies`.
New event types: `credential.rotated`, `credential.expiring_soon`, `credential.rotation_failed`, `credential.inventory_updated`.
New workflows: `credential-rotation.workflow.ts` (nightly CronWorkflow at 3 AM, configurable via `CREDENTIAL_ROTATION_CRON`), `mover.workflow.ts` (role/department change → entitlement delta).
New connector capability: `credentialManagement` — `resetPassword()`, `getCredentialState()`, `getMfaStatus()` on Entra ID and AD connectors.

### Added — Data Fabric Virtual Attributes (F-15, F-16, F-17)

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/api/v1/data-fabric/attributes` | policy-admin | List all attribute definitions |
| GET | `/api/v1/data-fabric/attributes/:name` | policy-admin | Get specific attribute definition |
| POST | `/api/v1/data-fabric/attributes` | super-admin | Register attribute definition |
| PATCH | `/api/v1/data-fabric/attributes/:name` | super-admin | Update attribute definition |
| DELETE | `/api/v1/data-fabric/attributes/:name` | super-admin | Remove attribute definition |
| POST | `/api/v1/data-fabric/seed-defaults` | super-admin | Seed built-in virtual attribute definitions |
| GET | `/api/v1/data-fabric/resolve/:identityId/:attributeName` | operator | Resolve single virtual attribute |
| POST | `/api/v1/data-fabric/resolve/:identityId` | operator | Resolve multiple attributes (body: `{ attributes: string[] }`) |

New collection: `attribute_definitions`.
New event types: `data_fabric.attribute_resolved`, `data_fabric.fetch_timeout`, `data_fabric.fetch_error`, `data_fabric.cache_miss`.
New connector capability: `virtualAttributes` — `fetchAttributes()` on Entra ID and AD connectors for JIT attribute retrieval.
New config: `DATA_FABRIC_FETCH_TIMEOUT_MS`, `DATA_FABRIC_DEFAULT_VIRTUAL_TTL_SECONDS`, `DATA_FABRIC_DEFAULT_CACHED_TTL_SECONDS`, `DATA_FABRIC_STALE_FALLBACK_ENABLED`.

### Added — Mover Workflow (F-18)

Explicit role/department change handling. When an identity with existing provisioned targets has critical fields changed (`departmentName`, `jobTitle`, `location`, `managerEmail`), the mover workflow computes an entitlement delta (additions and removals) between old and new policy evaluations, then executes the delta per target system.

New event types: `mover.started`, `mover.completed`, `mover.failed`.

### Added — AI Access Intelligence (F-12, F-13, F-14)

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/api/v1/intelligence/reviewer-quality` | super-admin | All reviewer quality scores |
| GET | `/api/v1/intelligence/reviewer-quality/:campaignId` | super-admin | Per-campaign reviewer scores |
| GET | `/api/v1/intelligence/peer-groups` | policy-admin | List peer groups with stats |
| GET | `/api/v1/intelligence/peer-groups/:groupKey/outliers` | policy-admin | Outliers in peer group |
| GET | `/api/v1/intelligence/recommendations/:identityId` | operator | Peer-based entitlement recommendations |
| POST | `/api/v1/intelligence/unusual-check` | operator | Check if access request is unusual |

New collections: `reviewer_quality_scores`, `peer_groups`.
New event types: `intelligence.peer_group_updated`, `intelligence.peer_deviation_detected`, `intelligence.reviewer_quality_scored`.

**Changed:** Risk scoring — `peer_deviation` added as 7th factor (weight 12%). Default weights rebalanced: entitlement 8, highRisk 22, sod 22, anomaly 13, admin 13, dormant 10, peerDeviation 12 = 100.

### Added — Immutable Audit: Merkle Tree + S3 Archive (F-07, F-08)

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/api/v1/audit/merkle-roots` | super-admin | List Merkle checkpoints |
| POST | `/api/v1/audit/verify-event/:eventId` | super-admin | Merkle proof for single event |
| POST | `/api/v1/audit/verify` | super-admin | Verify date range using Merkle roots |

New collection: `audit_roots`.
New service: `AuditArchiveService` — S3 Object Lock export (COMPLIANCE mode, WORM).
New workflow: `audit-archive.workflow.ts` (daily at 3 AM, conditional on `AUDIT_ARCHIVE_ENABLED`).

### Added — Event Subscriptions (F-21)

| Method | Path | Role | Description |
|---|---|---|---|
| POST | `/api/v1/event-subscriptions` | super-admin | Create webhook subscription |
| GET | `/api/v1/event-subscriptions` | super-admin | List webhook subscriptions |
| GET | `/api/v1/event-subscriptions/:id` | super-admin | Get subscription by ID |
| PATCH | `/api/v1/event-subscriptions/:id` | super-admin | Update subscription |
| DELETE | `/api/v1/event-subscriptions/:id` | super-admin | Delete subscription |
| POST | `/api/v1/event-subscriptions/:id/test` | super-admin | Send test webhook |
| GET | `/api/v1/event-subscriptions/:id/deliveries` | super-admin | List delivery attempts |

New collections: `event_subscriptions`, `webhook_delivery_attempts`.
New event types: `webhook.delivery_failed`, `webhook.subscription_created`, `webhook.subscription_deleted`.

### Added — SIEM Integration (F-04, F-05, F-06)

| Method | Path | Role | Description |
|---|---|---|---|
| POST | `/api/v1/event-subscriptions/siem` | super-admin | Create SIEM subscription (Splunk, Sentinel, S3) |

SIEM subscriptions extend the existing event-subscriptions module with:
- Subscription types: `SIEM_SPLUNK`, `SIEM_SENTINEL`, `SIEM_S3` (in addition to `WEBHOOK`)
- OCSF v1.1 format translation for all domain events
- Batch delivery with configurable batch size and flush interval
- Provider-specific delivery: Splunk HEC, Sentinel Data Collector API, S3 batch upload
- All existing CRUD endpoints (`GET`, `PATCH`, `DELETE`) work for SIEM subscriptions
- New event types: `siem.delivery_succeeded`, `siem.delivery_failed`, `siem.batch_flushed`
- SIEM credentials encrypted at rest via `EncryptionService`
- Config: `SIEM_ENABLE_IP_ALLOWLIST`, `SIEM_DEFAULT_BATCH_SIZE`, `SIEM_DEFAULT_FLUSH_INTERVAL_SECONDS`, `SIEM_DELIVERY_TIMEOUT_MS`, `SIEM_MAX_RETRY_ATTEMPTS`

> **Correction (2026-11-25):** not shipped. `POST /api/v1/event-subscriptions/siem` does not exist (not in `swagger-spec.json`), a subscription's only type is `WEBHOOK` (`backend/src/modules/event-subscriptions/schemas/event-subscription.schema.ts`), and no `siem.*` event type, OCSF translation or `SIEM_*` setting exists in `backend/src` or its git history. A SIEM receives events through a webhook subscription (`POST /api/v1/event-subscriptions`) to its HTTP collector; the SIEM design is `docs/architecture/future/FUTURE_SIEM_INTEGRATION.md`.

### Added — DLQ Auto-Retry (F-19)

| Method | Path | Role | Description |
|---|---|---|---|
| POST | `/api/v1/dead-letter/:id/retry` | super-admin | Retry a DLQ entry |
| POST | `/api/v1/dead-letter/batch-retry` | super-admin | Batch retry matching entries |
| GET | `/api/v1/dead-letter/stats` | operator | DLQ statistics by status |

**Changed:** `dead_letter` schema: new fields `maxRetries`, `nextRetryAt`, `lastRetryError`. New statuses: `retrying`, `failed_permanently`. Auto-retry poller runs on configurable interval.
New event types: `dlq.entry_retried`, `dlq.entry_failed_permanently`.

### Added — Database Migration Framework (F-20)

`migrate-mongo` installed. Migration files in `backend/migrations/`. Dockerfile runs `migrate:up` at startup.

### Added — Remote Agent Topology (A-13, A-14)

| Method | Path | Role | Description |
|---|---|---|---|
| POST | `/api/v1/agents/register` | super-admin | Register a new remote agent |
| POST | `/api/v1/agents/:agentId/heartbeat` | agent-auth | Agent heartbeat ping |
| GET | `/api/v1/agents` | super-admin | List agents for tenant |
| GET | `/api/v1/agents/status` | super-admin | Agent status summary (online/offline/degraded counts) |
| GET | `/api/v1/agents/:agentId` | super-admin | Agent details with health info |
| DELETE | `/api/v1/agents/:agentId` | super-admin | Deregister (decommission) agent |

**New schema:** `agents` collection — `agentId`, `tenantId`, `status`, `connectorTypes`, `taskQueue`, `lastHeartbeat`, `version`, `metadata`, `certificate`.
**New config:** `agent-management.config.ts` — `AGENT_HEARTBEAT_INTERVAL_SECONDS`, `AGENT_STALE_THRESHOLD_MULTIPLIER`, `AGENT_STALE_CHECK_INTERVAL_MS`, `AGENT_MAX_PER_TENANT`.
**Changed:** `ConnectorManifest` — new `executionMode?: 'cloud' | 'remote-agent'` field.
**Changed:** `task-queue.config.ts` — new `getAgentTaskQueue()`, `isAgentQueue()` helpers.
**New events:** `agent.registered`, `agent.online`, `agent.offline`, `agent.decommissioned`.
**New package:** `@euroid/remote-agent` — standalone Temporal worker binary with CLI, heartbeat, mTLS, credential vault.
**New frontend route:** `/settings/agents` — agent management dashboard with status badges, auto-refresh.

---

## [1.1.0] — 2026-02-22 — Security Hardening & Governance Modules

> All changes between the 1.0.0 baseline and this release. Includes IGA gap remediation,
> security audit batches, GDPR compliance, MFA/SAML, multi-tenancy, and SCIM 2.0.

### Changed (2025-02-20) — ObjectId Validation and Pagination Bounds (CURRENT_TASK_200, CURRENT_TASK_201)

- **All controllers with `:id` path params:** Invalid MongoDB ObjectId format now returns 400 Bad Request (was 500 Mongoose CastError). Applies to identity, reconciliation, access-requests, anomaly, policy, sod-policy, role-bundles, blueprints, entitlement-catalog, dead-letter, gdpr-compliance, policy-suggestions, access-review, auth.
- **Identity:** `GET /api/v1/identity` — `_start` and `_end` query params now validated: start 0–10000, page size (end − start) ≤ 500. Returns 400 for out-of-bounds values.
- **Reconciliation:** `GET /api/v1/reconciliation/drifts` — `page` and `limit` validated: offset ≤ 10000, limit ≤ 500.
- **Audit:** `GET /api/v1/audit` — Same page/limit bounds.
- **Access Requests:** `GET /api/v1/access-requests` — Same page/limit bounds.

### Changed (2025-02-20) — Config Centralization (CURRENT_TASK_200)

- Configuration now loaded via Zod-validated config modules (auth, encryption, events, app). Required env vars fail fast at startup. Secrets never logged.

### Changed (2025-02-20) — IdentityModule GDPR Refactor (CURRENT_TASK_199)

- GDPR endpoints (erasure, DSAR export, consent) now served by ComplianceReportingModule; behavior unchanged. URLs preserved: `DELETE /api/v1/identity/:id/gdpr-erase`, `GET /api/v1/identity/:id/dsar-export`, `GET /api/v1/identity/compliance/consent-report`, `POST /api/v1/identity/:id/consent`, `DELETE /api/v1/identity/:id/consent/:purpose`, `GET /api/v1/identity/:id/consent`.

### Changed (2025-02-19) — NoSQL Injection Guard (CURRENT_TASK_187)

- **Identity:** `GET /api/v1/identity` — Filter query param now rejects MongoDB operator keys (`$ne`, `$regex`, `$where`, etc.) at any nesting depth. Returns 400 with "Operator queries not allowed in filters" if detected. Max filter depth 5.

### Changed (2025-02-19) — assign_role Action Type (CURRENT_TASK_185)

- **Entitlement Catalog:** `GET /api/v1/entitlement-catalog` — Response now includes optional `adminTier` for DirectoryRole entries (TIER_0, TIER_1, TIER_2) when present in catalog.
- **Policy Engine:** `assign_role` action type supported; `targetId` extracted from `params.roleTemplateId` or `params.roleName`.

### Changed (2025-02-19) — Security Audit Deferred Remediation (CURRENT_TASK_180)

- **Identity:** `GET /api/v1/identity/:id/offboard-impact` — Returns `{ affectedSystems, entitlements }` for offboard simulation (FF-4).
- **Auth (FA-1):** Local auth now supports httpOnly cookies. `POST /auth/login`, `POST /auth/refresh`, `POST /auth/mfa/challenge`, and `POST /auth/saml/exchange` set `access_token` and `refresh_token` cookies when tokens are returned. `JwtAuthGuard` and WebSocket gateway accept token from cookie or `Authorization: Bearer`. `POST /auth/logout` clears cookies. API clients can continue using `Authorization: Bearer` in the request header; `refresh_token` in body is optional when sent via cookie.
- **Batch Provisioning:** `GET /api/v1/batch-provision/health` — Documented as intentionally @Public() for load balancer health checks (BP-1).

### Changed (2025-02-19) — Security Audit Batch 15 (CURRENT_TASK_174)

- **Reconciliation:**
  - `POST /api/v1/reconciliation/drifts/:id/correct` — Now performs actual correction in target systems (Entra, AD) for non-ORPHAN_ACCOUNT drifts before updating status. Returns 400 if correction fails.
  - `POST /api/v1/reconciliation/drifts/bulk-correct` — Same; performs actual correction per drift. `driftIds` array capped at 500 (was unbounded).
  - `POST /api/v1/reconciliation/drifts/bulk-ignore` — `driftIds` array capped at 500.
  - Daily reconciliation workflow ID is now deterministic (`t-{tenantId}-daily-recon`). Duplicate starts rejected via `WorkflowIdConflictPolicy.FAIL`.
- **Blueprints:**
  - `POST /api/v1/blueprints/impact-analysis` — When `dryRun=true`, `generateEntraMetadata` no longer calls Entra API; returns synthetic UPN. Simulation is read-only.

### Changed (2025-02-19) — Security Audit Batch 12 (CURRENT_TASK_171)

- **Anomaly Detection:**
  - `GET /api/v1/anomalies` — `page` capped at 10000, `limit` capped at 500 (was unbounded). Query params validated via Zod.
  - `GET /api/v1/anomalies/risk-scores` — `limit` capped at 500 (was unbounded).
- **Analytics:**
  - `GET /api/v1/analytics/upcoming-offboardings` — `daysAhead` capped at 365 (was unbounded).
  - `GET /api/v1/analytics/license-forecast`, `GET /api/v1/analytics/license-forecast/:system/:license` — `daysAhead` capped at 365.
  - `GET /api/v1/analytics/license-forecast/:system/:license` — `system` max 100 chars, `license` max 200 chars; returns 400 if exceeded.
  - `POST /api/v1/analytics/refresh` — `daysAhead` capped at 365.
- **Policy Suggestions:**
  - `GET /api/v1/policy-suggestions` — `page` capped at 10000 (was unbounded).
  - `POST /api/v1/policy-suggestions/:id/dismiss` — `reason` body field capped at 2000 chars (was unbounded).

### Changed (2025-02-19) — Security Audit Batch 11 (CURRENT_TASK_170)

- **Entitlement Catalog:**
  - `PATCH /api/v1/entitlement-catalog/:id/tags` — `governanceTags` array capped at 20 (was unbounded).
- **Role Bundles:**
  - `DELETE /api/v1/role-bundles/:id` — Returns 400 if bundle is in use by policies; message includes count.
  - `POST /api/v1/role-bundles`, `PATCH /api/v1/role-bundles/:id` — Actions without `id` now auto-generated (no breaking change).

### Changed (2025-02-19) — Security Audit Batch 10 (CURRENT_TASK_169)

- **Access Requests:**
  - `GET /api/v1/access-requests/:id` — Now requires caller to be requester or designated approver; returns 403 otherwise.
  - `POST /api/v1/access-requests/pre-check-sod` — When `targetIdentityId` differs from requester, caller must be manager of target (same as create).
  - `POST /api/v1/access-requests` — `entitlements` array capped at 50 (was unbounded).
  - `POST /api/v1/access-requests/pre-check-sod` — `entitlements` array capped at 50.
  - `PUT /api/v1/access-requests/:id/delegate` — `delegateTo` must reference an existing identity; returns 400 if not found.
- **Privileged Access:**
  - `PUT /api/v1/privileged-access/admin-accounts/:adminId/activate` — Only parent identity or connector-admin/super-admin can activate. Role: viewer or operator.
  - `PUT /api/v1/privileged-access/admin-accounts/:adminId/deactivate` — Same restriction as activate. Role: viewer or operator.
  - `POST /api/v1/privileged-access/:parentId/admin-accounts` — TIER_2 creation now requires connector-admin, policy-admin, or super-admin role.
  - `GET /api/v1/privileged-access/:parentId/admin-accounts` — Viewers can only see own linked accounts; operators can see any.

### Changed (2025-02-19) — Security Audit Batch 8 (CURRENT_TASK_167)

- **Policy Engine & SoD (PE-1–PE-6):**
  - `PATCH /api/v1/policy/:id` — When conditions, actions, or roleBundleId change on an active policy, status is set to DRAFT; re-activation by a different admin required.
  - `POST /api/v1/policy/reorder` — `orderedIds` now capped at 500 (was unbounded). Requests exceeding limit return 400.
  - `POST /api/v1/policy/simulate` — Inline `policy` object now validated for ReDoS-safe regex before simulation.
- **Bulk Provisioning:** `validateBatch` now runs SoD validation for CREATE operations; requests with SoD violations fail validation.

### Changed (2025-02-19) — Security Audit Batch 1 (CURRENT_TASK_160)

- **Auth & Secrets hardening:**
  - `POST /api/v1/auth/mfa/setup`, `POST /api/v1/auth/mfa/verify-setup` — require `scope: 'mfa-enrollment'` when using scoped token (roles empty). Full tokens (with roles) unchanged.
  - SAML: `SAML_WANT_ASSERTIONS_SIGNED=false` disallowed in production.
  - SAML: In production, `SAML_AUTO_CREATE_USER` must be explicitly `true` for JIT provisioning (default `false`).

### Added (2026-02-18) — IGA Gap Remediation (CURRENT_TASK_152–159)

- **Role Bundle Integration (CURRENT_TASK_152)** — Policies with `roleBundleId` now resolve the bundle's actions (with parent bundle inheritance, max depth 5) during evaluation. Role Bundle actions are merged with policy-specific actions and deduplicated. `RoleBundlesService.resolveWithInheritance()` added. `RoleBundlesModule` imported into `PolicyModule`.
  - `GET /api/v1/role-bundles/:id/resolved` — returns `{ actions: [...] }` (resolved actions with inheritance). Role: viewer.
  - Role Bundle create/update — added `inheritance?: string[]` (parent bundle IDs).

- **Time-Bound Access (CURRENT_TASK_153)** — `ProvisioningState` extended with `expiresAt`, `activeFrom`, `grantedBy`. `PolicyAction` extended with `timeConstraint: { durationDays?, expiresAt? }`. New Temporal CronWorkflow `entitlementExpiryWorkflow` runs hourly, deprovisions expired entitlements, emits `ENTITLEMENT_EXPIRED` audit events. Notifications: `ENTITLEMENT_EXPIRING_SOON` (7 days), `ENTITLEMENT_EXPIRING_TOMORROW` (1 day).

- **Privileged Access Management (CURRENT_TASK_154)** — Linked admin identity model for privileged roles. Tiered admin model (Tier 0/1/2). Identity schema extended with `linkedAdminAccounts[]`, `parentIdentityId`, `adminTier`. Entitlement Catalog extended with `adminTier`, `requiresAdminAccount`. Policy Engine now separates operations into `operations` (daily-driver) and `adminOperations` (linked admin identity). New module `privileged-access/`. Endpoints:
    - `GET /api/v1/privileged-access/:parentId/admin-accounts` — list linked admin accounts
    - `POST /api/v1/privileged-access/:parentId/admin-accounts` — create linked admin identity
    - `PUT /api/v1/privileged-access/admin-accounts/:adminId/activate` — activate admin account
    - `PUT /api/v1/privileged-access/admin-accounts/:adminId/deactivate` — deactivate admin account
  Temporal workflow: `admin-account-provisioning.workflow.ts`. Config: `ADMIN_UPN_PATTERN`, `PAM_TIER2_REQUIRES_ADMIN_ACCOUNT`.

- **Self-Service Access Request Portal (CURRENT_TASK_155)** — End-user self-service for requesting entitlements. Entitlement Catalog extended with `requestable`, `approvalRequired`, `approvalChain`, `maxDurationDays`, `category`, `userDescription`. New module `access-requests/`. Endpoints:
    - `POST /api/v1/access-requests` — submit access request
    - `GET /api/v1/access-requests` — list my requests (with filters)
    - `GET /api/v1/access-requests/:id` — request detail
    - `PUT /api/v1/access-requests/:id/approve` — approve request step
    - `PUT /api/v1/access-requests/:id/reject` — reject request
    - `PUT /api/v1/access-requests/:id/cancel` — cancel own request
    - `PUT /api/v1/access-requests/:id/delegate` — delegate approval
    - `GET /api/v1/access-requests/pending-approvals` — list pending approvals for current user
    - `GET /api/v1/access-requests/pending-approvals/count` — count pending approvals (sidebar badge)
    - `POST /api/v1/access-requests/pre-check-sod` — pre-check SoD violations before submitting (returns blockers and warnings). Role: viewer.
    - `GET /api/v1/entitlement-catalog/requestable` — browse requestable catalog entries
  Temporal workflow: `access-request-approval.workflow.ts` (multi-step approval with signals). SoD pre-check on submission. Delegation: workflow re-fetches request and notifies new approver.

- **Risk Scoring (CURRENT_TASK_156)** — Per-user composite risk score (0-100). New module `risk-scoring/`. Endpoints:
    - `GET /api/v1/risk-scores?top=100&minScore=50` — top risky users (returns full score with factors, trend, history)
    - `GET /api/v1/risk-scores/:identityId` — risk score for identity
    - `GET /api/v1/risk-scores/distribution` — histogram data; response `{ buckets: [{ range, count }], average, median }`
  Temporal CronWorkflow: `risk-score-calculation.workflow.ts` (nightly at 2 AM, configurable via `RISK_SCORE_CRON`). 6-factor model: entitlement count (10%), high-risk entitlements (25%), SoD violations (25%), anomaly history (15%), admin tier (15%), dormant account (10%).

- **Orphaned Account Detection (CURRENT_TASK_157)** — Extends reconciliation with `ORPHAN_ACCOUNT` drift type and `QUARANTINED` status. Temporal workflow: `orphan-cleanup.workflow.ts` (30-day grace → disable → 30-day extended grace → delete/adopt). Endpoints:
    - `GET /api/v1/reconciliation/drifts?type=ORPHAN_ACCOUNT` — list orphan drifts (existing filter extended)
    - `GET /api/v1/reconciliation/orphans/:driftId/simulate-delete` — simulation for delete confirmation (returns impact). Role: viewer.
    - `POST /api/v1/reconciliation/orphans/:driftId/signal` — signal workflow (body: `{ action: 'ADOPT' | 'DELETE', identityId?: string }`). Role: operator.
    - `GET /api/v1/reconciliation/orphans/stats` — summary: total, quarantined, disabled, resolved, bySystem. Role: viewer.
  Drift schema: `orphanDetails` (targetSystem, externalId, gracePeriodEndsAt, disabledAt, decision, adoptedIdentityId). Config: `ORPHAN_GRACE_PERIOD_DAYS`, `ORPHAN_EXTENDED_GRACE_DAYS`, `ORPHAN_AUTO_DELETE_AFTER_EXTENDED`.

- **Compliance Reporting (CURRENT_TASK_158)** — SOX and ISO 27001 report generation. New module `compliance-reporting/`. Endpoints:
    - `POST /api/v1/compliance-reports/generate` — generate report (body: type, dateRange, format). Role: policy-admin, super-admin.
    - `GET /api/v1/compliance-reports` — list generated reports (query: ?type=SOX|ISO27001). Role: policy-admin, super-admin.
    - `GET /api/v1/compliance-reports/:id/download` — download report file (PDF or CSV). Role: policy-admin, super-admin.
  Supports PDF and CSV export. Report metadata stored in MongoDB; files stored locally (COMPLIANCE_REPORTS_PATH).

- **Recurring Recertification (CURRENT_TASK_159)** — `ReviewCampaign` schema extended with `recurrence` (enabled, frequency: MONTHLY/QUARTERLY/SEMI_ANNUAL/ANNUAL, nextRunAt, previousCampaignId), `escalation` (enabled, escalateAfterDays, escalateTo: MANAGER|ADMIN), `templateCampaignId`. `ReviewItem` extended with `previousDecision`, `previousDecisionDate`, `previousCampaignId`, `escalatedFrom`, `escalatedAt`. `POST /api/v1/access-reviews/campaigns` body accepts optional `recurrence` and `escalation`. Temporal Schedule: `recertification-scheduler.workflow.ts` (daily 2 AM, configurable via `RECERTIFICATION_CRON`). Carry-forward: previously approved/revoked items marked for reviewer context. Escalation: unreviewed items after N days reassigned to manager or admin. New events: `RECERTIFICATION_CAMPAIGN_CREATED`, `ACCESS_REVIEW_ESCALATED`.

### Changed (2026-02-18)
- **Auth login (CURRENT_TASK_133)** — `POST /api/v1/auth/login` password validation now matches register (min 12 chars, complexity rules). Stricter rate limit: 5 req/s, 15 req/min (configurable via `AUTH_THROTTLE_SHORT_LIMIT`, `AUTH_THROTTLE_MEDIUM_LIMIT`).
- **Identity API responses (CURRENT_TASK_125)** — `projectIdentityToUser` no longer exposes `__v` (Mongoose internal version key) in identity list/detail responses. Responses are unchanged otherwise.
- **NoSQL injection fix (CURRENT_TASK_142)** — `GET /api/v1/identity` now accepts optional `?filter` (JSON object) for user-supplied filters. Only whitelisted keys allowed (`email`, `profile.email`, `firstName`, `profile.firstName`, etc.). Keys starting with `$` and `tenantId` override rejected with 400. Nested query operators (e.g. `{"email":{"$regex":".*"}}`) rejected with 400.
- **Auth error sanitization (CURRENT_TASK_145)** — OIDC token validation errors no longer include library-specific messages (e.g., JWKS key IDs) in client responses. Clients receive generic `"Invalid token"`. Dead-letter replay returns 400 with `"Entry X is not in a replayable state"` instead of 500 when entry is not pending.

### Removed (2026-02-18)
- **Reconciliation activity (CURRENT_TASK_125)** — Deprecated `fetchHubUsers` activity removed from Temporal worker. Use `fetchHubUsersPage` for streaming reconciliation to avoid OOM at scale.

### Changed (2026-02-17)
- **Validation Consolidation (CURRENT_TASK_122)** — All request body validation migrated from class-validator to Zod. `ZodValidationPipe` replaces NestJS `ValidationPipe`. 400 validation errors may have different structure (Zod format). All previously untyped inline `@Body()` parameters now use validated DTOs: `CorrelateIdentityDto`, `ResolveConflictDto`, `UpdateIdentityControlsDto`, `UpdateUserDto`, `TriggerReconciliationDto`, `BulkDriftActionDto`, `TriggerOnboardingDto`, `UpdatePolicyDto`, `GrantConsentDto`, etc. Dependencies removed: `playwright`, `class-validator`, `class-transformer`, `@opentelemetry/auto-instrumentations-node`. OTel replaced with targeted instrumentations: `@opentelemetry/instrumentation-http`, `@opentelemetry/instrumentation-express`, `@opentelemetry/instrumentation-mongodb`.

### Added (2026-02-17)
- **Security Hardening (CURRENT_TASK_123)** — Error responses sanitized (no `error.message` to clients). `GET /batch-provision/health` simplified: `{ status, envLoaded, temporalConnected }` only (no filesystem paths). `GET /batch-provision/health/diagnostics` — super-admin only, full env/keys/Entra diagnostics. WebSocket CORS defaults to localhost origins when `CORS_ORIGINS` unset. WebSocket auth supports local JWT (`euroid-local` issuer) and OIDC. Swagger disabled in production. `/metrics` requires `Authorization: Bearer <METRICS_TOKEN>` when `METRICS_TOKEN` is set. PII redaction in logs (mobilePhone, field values). `AUTH_DISABLED` blocked in staging/pre-prod. `ENCRYPTION_KEY_SALT` required when using `ENCRYPTION_KEY_PASSPHRASE`.

### Added (2026-02-17)
- **Critical Security Fixes (CURRENT_TASK_121)** — `POST /api/v1/auth/saml/exchange` — exchange short-lived auth code for tokens (public). Body: `{ code }`. Returns `{ access_token, refresh_token, user }` or `{ mfa_required, mfa_token }` or `{ mfa_enrollment_required, access_token, refresh_token, user }`. `POST /api/v1/auth/invites` — create invite token for registration (super-admin). Body: `{ email, roles }`. Returns `{ token, expiresAt }`.
- **Security Hardening (CURRENT_TASK_120)** — KMS integration for encryption keys (AWS KMS, Azure Key Vault). When `KMS_PROVIDER` is set, envelope encryption: KMS unwraps DEK on startup; data encrypted locally. Temporal mTLS: worker connects with client certs when `TEMPORAL_TLS_CERT_PATH`, `TEMPORAL_TLS_KEY_PATH`, `TEMPORAL_TLS_CA_PATH` are set. Content Security Policy: explicit Helmet CSP directives, HSTS, referrer policy; `CSP_REPORT_ONLY`, `CSP_REPORT_URI` for testing. SCIM connector enforces HTTPS in production. Console.log replaced with Logger in activities/services; ESLint `no-console: warn` added.

### Added (2026-02-17)
- **GDPR Right to Erasure (CURRENT_TASK_118)** — `DELETE /api/v1/identity/:id/gdpr-erase` cascading hard-delete across all collections (identities, user_events, audit_events, review_items, outbox_events). Requires `super-admin` role and `X-Confirm-Erasure: true` header. Supports `?dryRun=true` for preview. Returns attestation with `erasedAt`, `erasedBy`, `collectionsAffected`, `documentCounts`. `GDPR_ERASURE_EXECUTED` audit event (severity: critical) emitted before deletion so the erasure itself is logged.
- **GDPR DSAR Export (CURRENT_TASK_118)** — `GET /api/v1/identity/:id/dsar-export` returns complete data package for one identity: identity document, timeline events, audit trail, access reviews, entitlements. Structured JSON per GDPR Articles 15 & 20. `DATA_EXPORTED` audit event emitted. Roles: super-admin, operator.
- **GDPR Consent Management (CURRENT_TASK_118)** — Per-identity, per-purpose consent tracking in `consents` collection. Endpoints: `POST /api/v1/identity/:id/consent` (grant), `DELETE /api/v1/identity/:id/consent/:purpose` (revoke), `GET /api/v1/identity/:id/consent` (list), `GET /api/v1/identity/compliance/consent-report` (aggregate report). Schema: identityId, purpose, status (granted/revoked/expired), grantedAt, revokedAt, grantedBy, method, expiresAt, tenantId. Upsert on grant (idempotent).
- **GDPR Compliance Documentation (CURRENT_TASK_118)** — `docs/architecture/security/GDPR_COMPLIANCE.md` maps GDPR Articles 6, 15, 17, 20, 30 to implemented features. New `GDPR_ERASURE_EXECUTED` audit action type added.

### Added (2026-02-17)
- **Audit Log Immutability — Hash-Chain (CURRENT_TASK_117)** — Every audit event now includes `integrityHash` (SHA-256 chain) and `previousHash` for tamper-evident logging. Hash computed from `SHA-256(previousHash + canonical JSON)` with deterministic key sorting. Genesis hash: `SHA-256('euroid-genesis')`. In-memory cache of last hash per tenant avoids extra DB read on hot path. `GET /api/v1/audit/verify-integrity?from=<ISO>&to=<ISO>` — super-admin only, walks the chain and recomputes hashes to detect tampering. Returns `{ valid, eventsChecked, firstInvalid? }`. TTL-deleted events treated as new genesis points.
- **Data Export & Bulk-Read Audit (CURRENT_TASK_117)** — New audit action types: `DATA_EXPORTED`, `BULK_QUERY_EXECUTED`, `PII_REVEALED`. `BULK_QUERY_EXECUTED` emitted when audit logs are queried and when identity list returns >50 records. `DATA_EXPORTED` emitted when bulk provisioning results are fetched. `POST /api/v1/audit/pii-reveal` — operator role, logs PII field reveal from frontend `PiiField` component. Body: `{ field: string, identityId?: string }`. Frontend `PiiField` now calls this endpoint on reveal.

### Changed (2026-02-17)
- **SAML callback (CURRENT_TASK_121)** — `POST /api/v1/auth/saml/callback` redirect now passes `?code=...` only (no tokens in URL). `POST /api/v1/auth/register` requires `inviteToken` when admin users exist. First user (zero users) remains open.
- **tenantId required in LogAuditEvent (CURRENT_TASK_117)** — `LogAuditEvent.tenantId` is now required (was optional). All 11 callers updated to pass `tenantId` explicitly: `jwt-auth.guard.ts`, `onboarding.service.ts`, `reconciliation.service.ts`, `blueprints.service.ts`, `connector-config.service.ts` (3 calls), `bulk-provisioning.service.ts` (3 calls), `audit-event.handler.ts`.

### Added (2026-02-17)
- **TOTP MFA (CURRENT_TASK_116)** — Multi-factor authentication with TOTP (RFC 6238). AdminUser schema additions: `mfaSecret` (AES-256-GCM encrypted), `mfaEnabled`, `mfaBackupCodes` (bcrypt hashed), `authSource` (local|saml). Endpoints: `POST /api/v1/auth/mfa/setup` (returns QR code data URL + manual key), `POST /api/v1/auth/mfa/verify-setup` (validates first code, enables MFA, returns 10 backup codes), `POST /api/v1/auth/mfa/challenge` (public — verifies temp MFA token + TOTP/backup code, returns access_token), `POST /api/v1/auth/mfa/disable` (requires current TOTP), `POST /api/v1/auth/mfa/backup-codes` (regenerates 10 codes), `GET /api/v1/auth/mfa/status` (returns `{ mfaEnabled, backupCodesRemaining }`). Login flow: when user has MFA enabled, `POST /api/v1/auth/login` returns `{ mfa_required: true, mfa_token }` instead of access_token. MFA pending token is short-lived (5 min, issuer: euroid-mfa). Emergency token bypasses MFA by design.
- **SAML 2.0 SSO (CURRENT_TASK_116)** — SAML SP-initiated login using `@node-saml/node-saml`. Endpoints: `GET /api/v1/auth/saml/login` (302 redirect to IdP), `POST /api/v1/auth/saml/callback` (validates assertion, redirects to frontend with tokens), `GET /api/v1/auth/saml/metadata` (SP metadata XML), `GET /api/v1/auth/saml/config` (returns `{ enabled, issuer }`). JIT user provisioning: auto-creates AdminUser with `authSource: saml` on first login (configurable via `SAML_AUTO_CREATE_USER`, default role: `SAML_DEFAULT_ROLE`). Configurable attribute mapping: `SAML_EMAIL_ATTR`, `SAML_NAME_ATTR`, `SAML_ROLE_ATTR`, `SAML_TENANT_ATTR`. Clock skew tolerance: 30s (`SAML_ACCEPTED_CLOCK_SKEW_MS`). SAML users cannot use password login.
- **Tenant MFA Policy (CURRENT_TASK_116)** — Tenant `settings.mfaRequired` boolean. When `true` and user has not enrolled MFA, login returns `{ mfa_enrollment_required: true }` with access token so user can complete MFA setup. Frontend redirects to Account Security page for enrollment.
- **Refresh Token Endpoint (CURRENT_TASK_115)** — `POST /api/v1/auth/refresh` accepts `{ refresh_token }`, returns new `{ access_token, refresh_token }`. Refresh tokens are opaque (48-byte base64url), hashed (SHA-256) in DB, expire after 7 days (configurable via `REFRESH_TOKEN_EXPIRY_DAYS`). Revoked on password change, deactivation, and session revoke.
- **Transactional Outbox (CURRENT_TASK_106)** — Domain events can be emitted atomically with MongoDB writes via `emitWithTransaction()`. Outbox poller delivers pending events with at-least-once semantics. Identity creation uses transactional emit when MongoDB is a replica set.
- **Dynamic Connector Capabilities (CURRENT_TASK_107)** — Connectors can validate runtime permissions. Health check endpoint `POST /api/v1/connectors/:name/health-check` now returns `{ healthy, capabilities, ... }` with runtime-validated capability list. Entra and SCIM connectors implement `validateCapabilities()`. SCIM connector health check supported.
- **Encryption Key Rotation (CURRENT_TASK_102)** — New encryptions use v2 format `euroid:v2:<keyId>:<ciphertext>`. v1 ciphertexts still decrypt. `reEncrypt()` upgrades v1 to v2. Env vars: `ENCRYPTION_KEY_ID`, `ENCRYPTION_KEY_PREVIOUS`, `ENCRYPTION_KEY_PREVIOUS_ID`. Run `backend/src/scripts/rotate-encryption-key.ts` for bulk re-encryption.
- **Break-Glass Emergency Access (CURRENT_TASK_101)** — When `EMERGENCY_ADMIN_TOKEN` and `EMERGENCY_TOKEN_VALID_UNTIL` are set, send `X-Emergency-Token` header for super-admin access when OIDC is down. Every use creates a CRITICAL audit event. Brute-force protection: 5 failures per IP per 15 minutes.
- **JWT Token Revocation (CURRENT_TASK_100)** — AdminUser schema has `tokenVersion`; JWTs include `tokenVersion` claim. Guard rejects tokens for deactivated users or version mismatch (30s cache). `POST /api/v1/auth/revoke/:userId` — super-admin only, revokes all sessions. `PATCH /api/v1/auth/users/:id` — super-admin only, update admin (e.g. isActive); deactivation auto-revokes. `POST /api/v1/auth/change-password` — change own password (revokes other sessions).

### Added (2026-02-16)
- **SoD Violations (Toxic Combination Detection, CURRENT_TASK_96)** — Policy Engine validates provisioning intent against `sod_policies` collection. BLOCK violations throw `SoDViolationException` (HTTP 409). WARN violations are logged and returned in `PolicyProvisioningIntent.sodWarnings`. SoD policy CRUD: `GET /api/v1/sod-policies`, `POST /api/v1/sod-policies`, `PATCH /api/v1/sod-policies/:id`, `DELETE /api/v1/sod-policies/:id` (soft-delete). Impact analysis dry-run catches `SoDViolationException` and includes `sodViolationsByUser` in response instead of throwing.

### Changed (2026-02-16)
- **Bulk provisioning SoD (CURRENT_TASK_98)** — `initiatedBy` is always set from authenticated JWT, never from request body (fixes spoofing). `POST /bulk-provisioning/approve-deletes/:workflowId` rejects when approver === initiator (403 Forbidden). Responses include `approvedBy` and `cancelledBy`. Audit logs: `BULK_DELETES_APPROVED`, `BULK_OPERATION_CANCELLED` with actor identity. Legacy workflows without email-like `triggeredBy` in memo allow approval.
- **Policy staging & peer-review (CURRENT_TASK_99)** — `POST /policy` always creates policies with `status: draft`; `createdBy` set from authenticated user. `PATCH /policy/:id` cannot change `status` (use toggle or activate). `PATCH /policy/:id/toggle` rejects DRAFT policies (use activate for peer-reviewed activation).

### Added (2026-02-16)
- **Policy activate endpoint** — `POST /policy/:id/activate` activates DRAFT or DISABLED policies. Requires `policy-admin` role. Returns 403 when activator is the same user as creator (SoD peer-review).
- **Attestation Readiness (CURRENT_TASK_95)** — Reviewer chain of responsibility: Manager → Entitlement Owner → Self (when allowed) → Admin. Campaign creation: `allowSelfReview`, `selfReviewRiskLevels` for low-risk self-attestation. Entitlement Catalog: `owner`, `riskLevel` for ownership and risk-based self-review. Review items are now per-entitlement (one item per identity+entitlement) with per-entitlement reviewer resolution. `isSelfReview` flag on ReviewItem exempts legitimate self-attestation from SoD check. Batch catalog lookup avoids N+1 during activation.

### Added (2026-02-16)
- **Machine Identity Governance (CURRENT_TASK_94)** — Admin Users and SCIM Tokens now have shadow Identity records for governance. `EmploymentType` extended with `SERVICE_ACCOUNT` and `ADMIN_ACCOUNT`. Policy Engine excludes machine identities unless policy has `targetEmploymentTypes` including them. Access Review campaigns support `targetEmploymentTypes` to include machine identities; entitlements for SERVICE_ACCOUNT (SCIM scopes) and ADMIN_ACCOUNT (admin roles) come from Entitlement Catalog. Migration scripts: `migrate-admin-to-identity.ts`, `migrate-scim-to-identity.ts`, `seed-machine-identity-entitlements.ts`. Dual-write hooks: admin registration and SCIM token create/revoke sync to Identity via `MachineIdentitySyncService`.

### Added (2026-02-16)
- **Entitlement Catalog governance tags** — `PATCH /api/v1/entitlement-catalog/:id/tags` — update governance tags (super-admin, policy-admin). Body: `{ governanceTags: string[] }`. Allowed values: `PROTECTED`, `MANDATORY`, `FLAGGED`, `REVIEW_REQUIRED`. Connectors read PROTECTED from catalog instead of hardcoded lists.

### Changed (2026-02-16)
- **Access review decide (SoD audit)** — Blocked self-approval attempts are now logged with `logger.warn` for audit trail. Identity comparison uses `String()` for robust handling of ObjectId/string.
- **Identity sources array** — Enforces max 50 entries at schema level. `pushSourceAndReconcile` and `ensureIdentityFromUser` deduplicate by `(sourceName, externalId)` and throw `BadRequestException` (400) if limit exceeded.

### Added (2026-02-16)
- **VersionError retry (optimistic concurrency)** — `IdentityService.updateIdentityProfile`, `updateControls`, and `updateProvisioningState` now retry on Mongoose `VersionError` (up to 3 attempts) instead of immediately returning 409. Reloads the document, re-applies changes, and retries. Reduces silent data loss when HR sync and admin UI race on the same Identity. After max retries, throws `ConflictException` (409).

### Added (2026-02-16)
- **Auto-generated frontend types from Swagger** — Frontend TypeScript interfaces for `StandardUserDto` and other backend DTOs are now generated from `swagger-spec.json` via `openapi-typescript`. Run `npm run generate:api` in the frontend directory to regenerate after backend DTO changes. Generated types live in `frontend/src/generated/api.types.ts`. Backward-compatible aliases (`IStandardUser`, `UserStatus`, etc.) remain in `frontend/src/interfaces/standard-user.interface.ts`.

### Changed (2026-02-16)
- **DevTools Workflow Debugger** — `GET /api/v1/dev/workflows` and `GET /api/v1/dev/workflows/:workflowId` now source data from Temporal Visibility API instead of MongoDB `workflow_executions` collection. Response shape unchanged (frontend compatible). Workflow metadata (`triggeredBy`, `targetDescription`) preserved via Temporal memo. Existing `workflow_executions` documents can be dropped manually or left to TTL.

### Changed (2026-02-16)
- **Identity onboarding (event-driven)** — `IdentityService` no longer injects `OnboardingService` via `setOnboardingService`. Critical-field updates and manual-link actions now emit `IDENTITY_UPDATED` / `IDENTITY_CORRELATED` events; `OnboardingEventHandler` triggers onboarding. Explicit workflow triggers (`?triggerWorkflow=true`, `?syncToEntra=true`) remain handled by `IdentityController` for synchronous workflowId response. No API contract change.

### Removed (2026-02-16)
- **User collection decommissioned** — All reads and writes now use the Identity collection exclusively. The legacy User collection is no longer used. Run `backend/src/scripts/migrate-user-to-identity.ts` before deploying if you have existing User documents.
- **IDENTITY_AS_SOURCE_OF_TRUTH env var** — Removed; Identity is always the source of truth.

### Changed (2026-02-16)
- **purgeDeletedIdentities** — No longer purges User collection; returns `usersPurged: 0`. Only Identity documents with `deletedAt` older than retention days are hard-deleted.

### Added (2026-02-16)
- **Optimistic Concurrency Control (OCC)** — Identity, User, Policy, and ReviewItem schemas now use `optimisticConcurrency: true`. When two admins edit the same record concurrently, the second save fails with `VersionError`; the global `VersionConflictFilter` returns 409 Conflict with message "This record was modified by another user. Please refresh and try again."
- **Segregation of Duties (SoD)** — Access review `decide` endpoint rejects self-approval: actors cannot approve or revoke their own access request. Returns 403 Forbidden with message "Segregation of Duties: You cannot approve or revoke your own access request."

### Changed (2026-02-16)
- **`__v` in Identity API responses** — All Identity/user list and detail responses now include `__v` (Mongoose document version) for optimistic concurrency. `StandardUserDto` accepts optional `__v` in PATCH body for future version validation.

### Changed (2026-02-16)
- **Reconciliation workflow (streaming)** — Daily reconciliation now processes users in pages (100 per page) to avoid OOM at scale. New activities: `fetchHubUsersPage(tenantId, pageToken, pageSize)` returns `{ users, nextPageToken, total }`. `fetchHubUserForReconciliation(tenantId, userId)` for on-demand single-user reconciliation. `fetchHubUsers` retained for backward compatibility but deprecated. IdentityService: `findUsersPageForReconciliation(skip, limit)`, `findUserForReconciliation(userId)`.
- **Sync scheduler (Cron → Temporal)** — Scheduled syncs now dispatch Temporal workflows instead of running inline. One slow connector (e.g. rate-limited Workday) no longer blocks others. New `scheduledSyncWorkflow` accepts `{ tenantId, connectorName }`. `SyncSchedulerService.executeSync()` runs the actual sync; `runScheduledSync` activity wraps it. When Temporal is unavailable, falls back to inline execution.
- **User deprecation (Identity as source)** — `findAll()` now respects `IDENTITY_AS_SOURCE_OF_TRUTH=true`, reading from Identity and projecting `profile`. New `findAllFromIdentity()` for explicit Identity reads. Migration script: `backend/src/scripts/migrate-user-to-identity.ts` copies User docs to Identity. User writes retained for backward compatibility until migration verified.
- **Controller logic moved to service** — IdentityController now delegates to formatted service methods: `linkUncorrelatedToTargetFormatted`, `createStandaloneFormatted`, `resolveConflictFormatted`, `findIdentityByEmailFormatted`, `findIdentityByIdFormatted`, `updateControlsFormatted`. Response shaping lives in IdentityService.
- **Event bus depth guard** — SourcesChangedHandler skips when `event.metadata.depth > 0` to prevent circular provisioning. Domain event envelope documents: handlers must NOT provision directly; only start Temporal workflows.
- **ReDoS protection (regex policy)** — Policy Engine uses `safe-regex2` to validate regex patterns before execution. Unsafe patterns (catastrophic backtracking) return no match instead of blocking the event loop. Policy create/update validates regex conditions at save time; rejects with 400 if unsafe.

### Security (2026-02-16)
- **BREAKING**: JWT_SECRET is now required when AUTH_DISABLED is not 'true'. App exits at startup if missing. Removed hardcoded fallback to prevent token forgery.
- **JsonApiHrConnector**: Only HTTPS URLs allowed for remote fetches. Private IPs (RFC 1918), loopback, link-local (169.254.x.x), and cloud metadata blocked (SSRF mitigation). DNS resolution validated before request.
- **JsonApiHrConnector**: Local file paths disabled in production unless `ALLOW_JSON_API_LOCAL_FILES=true`.
- **Tenant isolation**: HealthService readiness probe now iterates tenants and uses requestContext per tenant; never uses skipTenantScope. TenantPlugin documented as never failing open.

### Added (2026-02-16)
- **Identity as Source of Truth (feature flag)** — Set `IDENTITY_AS_SOURCE_OF_TRUTH=true` to read list/detail from Identity collection (Onion model) instead of User. `GET /identity` and `GET /identity/:id` project `Identity.profile` to the same shape as User. Update and delete work with Identity._id when flag is on. Default: false.
- **Phase 2 write path** — `saveOrUpdate` now writes to Identity first, then syncs to User via `ensureUserFromIdentity` for backward compatibility. `PATCH /identity/:id` when flag is on updates `Identity.profile` directly.

### Changed (2026-02-16)
- **Hardcoded Values Improvement** — Security and configuration hardening:
  - **MONGO_URI required:** No fallback; app fails at startup if not set.
  - **JWT_SECRET required when auth enabled:** Startup validation exits if `AUTH_DISABLED` is not 'true' and `JWT_SECRET` is missing.
  - **Bulk operations initiatedBy:** Now uses authenticated user email from auth context instead of hardcoded `admin@euroid.local`.
  - **Port configurable:** `PORT` env var (default 3001).
  - **Throttle limits:** `THROTTLE_SHORT_LIMIT`, `THROTTLE_MEDIUM_LIMIT` env vars.
  - **Temporal config:** Shared `backend/src/infrastructure/config/temporal.config.ts` for `TEMPORAL_ADDRESS`, `TEMPORAL_UI_URL`.
  - **Connector timeouts:** `CONNECTOR_TIMEOUT_MS`, `CONNECTOR_TIMEOUT_HR_MS` env vars.
  - **SCIM documentationUri:** Uses `APP_BASE_URL` env var.
  - **Frontend:** Centralized `config/polling.ts`, `config/pagination.ts`, `config/api-routes.ts`, `config/connector-mapping.ts`. BulkProgress/BulkResults use `API_BASE` prefix. Dev auth: `VITE_DEV_EMAIL` env var.

### Added (2026-02-16)
- **Dynamic Reconciliation Config (Per-Tenant)** — All hardcoded reconciliation constants (HR source tags, source priority order, contract-critical fields, default field mastery, target ID keys) are now stored in the database per tenant. No hardcoded fallbacks; tenants configure their own rules. `GET /api/v1/admin/reconciliation-config` — get tenant reconciliation config (returns `{ configured, config }`). `PUT /api/v1/admin/reconciliation-config` — upsert tenant reconciliation config (Zod-validated). New `reconciliation_configs` MongoDB collection. `ReconciliationService`, `ConnectorConfigService`, `BlueprintsService`, and `IdentityService` all read from the dynamic config instead of hardcoded arrays. If no config exists, reconciliation runs in open-merge mode (no mastery enforcement). Frontend: Admin > Recon Config page (`/admin/reconciliation-config`) with HR Source Tags, Source Priority Order, Contract-Critical Fields, Default Field Mastery, and Target ID Keys editors.

### Added (2026-02-16)
- **Uncorrelated Queue (Brownfield Manual Linking)** — Dashboard for manually linking orphaned HR records when automatic correlation fails. `metadata.correlationStatus` on Identity: `'correlated' | 'uncorrelated' | 'ambiguous' | 'manual-review'`. `metadata.ambiguousCandidates` stores identity IDs when heuristic name finds multiple matches. `GET /api/v1/identity/uncorrelated` — list uncorrelated/ambiguous identities. `GET /api/v1/identity/uncorrelated/count` — count for sidebar badge. `GET /api/v1/identity/:id/candidates` — scored candidate matches for manual linking. `POST /api/v1/identity/:id/link` — body `{ targetIdentityId }` — merge sources from uncorrelated into target, reconcile, soft-delete uncorrelated, trigger write-back. `POST /api/v1/identity/:id/create-standalone` — accept as new person (no linking). `CandidateSuggestionService` runs heuristic name matching for suggestions. Frontend: UncorrelatedQueue page (`/reconciliation/uncorrelated`), side-by-side HR vs candidates panel, Link/Create/Skip actions, confirmation modal, badge in sidebar, link from Reconciliation Dashboard.

### Added (2026-02-16)
- **Heuristic Name Matching Correlation** — Correlation Rule Engine now supports `heuristicName` strategy for brownfield deployments where HR and target systems share no unique identifier. Matches by firstName+lastName with normalization (diacritics, hyphens, case). Exact match → auto-link (confidence 0.85). Fuzzy match (Levenshtein ≥ threshold) → flag for review (0.65/0.6). Multiple candidates → ambiguous, never auto-link; returns `ambiguousCandidates` for manual review. Config: `nameMatchThreshold` (0.5–1.0, default 0.8), `nameMatchMode` (exact/fuzzy/both). Brain config UI: IdentityCorrelationTab shows Heuristic Name Match option with threshold slider and warning. Use as last resort after employeeNumber, nationalId, email.

### Added (2026-02-16)
- **Connector Priority & Mastery Configuration** — HR source connectors configure ingest priority, contract tag, and field mastery in **Design Studio** (ConfigDrawer when selecting a source node). Config stored in blueprint `node.data.config` (ingestPriority, contractTag, masteryFields). Backend reads from blueprint first via `BlueprintsService.getHrPriorityFromBlueprint()` and `getHrConnectorsWithPriorityFromBlueprint()`; falls back to connector_configs if blueprint has no config. ReconciliationService uses dynamic priority. Connector mastery merges into `identity.metadata.mastery` during `ensureIdentityFromUser()`. Contract tag auto-sets `contractType` on ingested records. Priority label (P1/P2) shown on canvas source nodes from node.data.config. Connector Marketplace does NOT store priority/mastery — config is Design Studio only.

### Added (2026-02-16)
- **Multi-Contract Split Provisioning & Conflict Review** — Policy Engine now evaluates each policy against ALL active contracts (not just primary). Entitlements from all matching contracts are UNIONED and deduplicated. `IDENTITY_SOURCES_CHANGED` event emitted when a new source is added; `SourcesChangedHandler` triggers policy re-evaluation via onboarding workflow. Correlation conflicts: `metadata.correlationConflict`, `metadata.requiresReview`, `metadata.conflictDetails` on Identity. `GET /api/v1/identity/conflicts` — list identities with requiresReview. `POST /api/v1/identity/:id/resolve-conflict` — body `{ action: 'merge' | 'split' | 'dismiss' }`. Merge: add incoming source to existing, soft-delete incoming identity. Split/Dismiss: clear conflict flags. Frontend: conflict indicator and "Review Required" tag in Identity Hub list, "Show conflicts only" filter, conflict resolution panel in User Detail Drawer.

### Added (2026-02-16)
- **HR Write-Back (Brain → HR Source)** — Closes the bootstrap loop: when Entra ID generates an email, it flows Target → Brain → HR. New `writebackToHrSource` activity in `WritebackActivities`. Onboarding workflow calls it after target writeback when `correlationConfig.hrWriteback` is enabled. Only write-back-eligible fields pushed: `email`, `workPhone`, `officeLocation` (never objectId, userPrincipalName, or HR-mastered fields). `IHrConnectorWriteBack` interface for HR connectors; csv-hr and json-api-hr are read-only (`writeBackCapableFields: []`). `HR_WRITEBACK_COMPLETED` domain event for audit. Connector capability `hrWriteback` in manifest.

### Added (2026-02-16)
- **Attribute Writeback (Target → Brain)** — After provisioning to Entra ID or AD, target-generated attributes (email, UPN, samAccountName, objectId) flow back to the Golden Record. New `writebackToIdentity` activity in `WritebackActivities`. Onboarding workflow now provisions sequentially (Entra first, then AD) so writeback from Entra can provide email for AD. `ProvisioningState.writebackComplete` flag prevents circular writeback on re-sync. Default field mastery: targets own `userPrincipalName`, `samAccountName`, `email` (when HR doesn't); HR owns `firstName`, `lastName`, `jobTitle`, `departmentName`. Target-specific IDs (`objectId`, `objectGUID`) stored in `profile.customAttributes` (entraObjectId, adDn, adObjectGUID). `CorrelationConfig.fieldMasteryOverrides` and `hrWriteback` flags added. Connector mappers: `extractWritebackAttributes()` in entra.mapper and ad.mapper. Audit: `IDENTITY_UPDATED` emitted on writeback.

### Added (2026-02-16)
- **Correlation Rules Engine** — Cross-system identity linking when source-key lookup misses. `ensureIdentityFromUser()` now runs correlation rules (employeeNumber, email, hashedNationalId, composite) before minting a new Identity. Config from blueprint `connectorConfigs['euroid-core'].correlationConfig`. Default: email-only rule (backward compatible). New domain events: `IDENTITY_CORRELATED`, `CORRELATION_CONFLICT`. `CorrelationHashService` for HMAC-SHA256 of national IDs (tenant-scoped key, never store raw PII). `profile.correlationId` field (sparse index) for hashed national ID lookups.

### Changed (2026-02-16)
- **Identity resolution (source-key-first):** `IdentityService.saveOrUpdate()` now matches by `{ sourceSystem, sourceUserId, tenantId }` instead of email. Email changes in HR (marriage, rebranding) no longer create duplicate identities. `ensureIdentityFromUser()` and `pushSourceAndReconcile()` use source-key lookup first, with email fallback for legacy data. New `findIdentityBySourceKey()` method. Backward compatible: missing sourceSystem/sourceUserId falls back to email match with warning log.

### Added (2026-02-15)
- **Pipeline Activation & Circuit Breaker** — Blueprint lifecycle and deploy workflow. `POST /api/v1/blueprints/readiness-check` — pre-deploy checklist (HR source, target connectors, active policies, impact analysis). `POST /api/v1/blueprints/deploy` — deploy pipeline (runs readiness first, returns 422 if not ready). `POST /api/v1/blueprints/pause`, `POST /api/v1/blueprints/resume`, `POST /api/v1/blueprints/stop` — pipeline lifecycle. `GET /api/v1/blueprints/pipeline-status` — returns `{ status, config }`. `PATCH /api/v1/blueprints/pipeline-config` — update `errorThresholdPercent`, `minSampleSizeForCircuitBreaker`. Pipeline status: DRAFT → SIMULATED → DEPLOYED → PAUSED → STOPPED. Circuit breaker auto-pauses when error rate exceeds threshold (default 5%, min 5 samples). WebSocket room `pipeline` for circuit breaker alerts. `GET /api/v1/blueprints/latest` now includes `pipelineConfig`. Onboarding workflow checks pipeline status before TARGET_PUSH; skips provisioning when PAUSED/STOPPED. Records provisioning outcomes for circuit breaker. Frontend: DeployModal (readiness checklist, error threshold), status badge, Deploy/Pause/Resume/Stop buttons, circuit breaker alert banner.

### Changed (2026-02-15)
- **`POST /api/v1/blueprints/impact-analysis`** — Replaced mock delta data with real delta computation. Compares Hub users → Policy Engine output → Identity provisioning state. Returns real CREATE/UPDATE/REMOVE/DISABLE/NO_CHANGE per user per target system. New `risk` object: `overallRisk`, `affectedPercentage`, `circuitBreakerTriggered`, `threshold`, `highRiskOperations`. Summary includes `noChange` count. Uses Identity Hub provisioning state (not live API calls) for speed. Frontend: risk banner, NO_CHANGE support in DeltaAnalysis.

### Added (2026-02-15)
- **Scheduled HR Ingest & Entitlement Discovery** — Configurable sync intervals per connector. `syncIntervalHours` in connector config (0 = manual, 1/6/12/24 = hours). `GET /api/v1/connectors/:name/sync-status` — returns `lastSyncAt`, `lastSyncStatus`, `lastSyncCount`, `lastSyncError`, `syncIntervalHours`, `nextSyncAt`. Sync status persisted on ConnectorConfig. NestJS `@Cron` (EVERY_HOUR) runs scheduled syncs for connectors with `syncIntervalHours > 0`. HR connectors (csv-hr, json-api-hr): ingest. Target connectors (entra-id, ad): entitlement discovery. Concurrent sync protection: `lastSyncStatus: 'running'` prevents overlapping runs. Frontend: Sync Status card in ConnectorConfigModal (last sync, status badge, items count, next sync, Sync Now button). Sync interval selector in config form for ingest/discover connectors.

### Added (2026-02-15)
- **Local Auth** — Email/password authentication for EuroID administrators. `POST /api/v1/auth/login` — login with email/password, returns `{ access_token, user }`. `POST /api/v1/auth/register` — create admin account (first user gets super-admin role). `GET /api/v1/auth/setup-status` — returns `{ hasAdminUsers }` (public, for first-user UX). `GET /api/v1/auth/me` — returns current user from JWT (requires valid token). JWT signed with `JWT_SECRET` (HS256, issuer `euroid-local`). Coexists with OIDC: JwtAuthGuard tries local verification first, then OIDC JWKS.

### Added (2026-02-15)
- **`POST /api/v1/connectors/:name/health-check`** — Test connector connectivity. For AD: accepts optional `config` in body (unsaved form values) and returns enriched result `{ connected, rootBaseDnValid?, userSearchBaseValid?, groupCount?, error? }`. For Entra: returns `{ connected }`. Uses saved config when body.config is empty. Roles: connector-admin, operator, policy-admin, super-admin.
- **`POST /api/v1/connectors/:name/discover`** — Trigger entitlement discovery for a connector (entra-id, ad). Updates the Entitlement Catalog. Tenant-scoped via JWT. Roles: connector-admin, operator, policy-admin, super-admin. Returns `{ success, count, entitlements }`.

### Changed (2026-02-15)
- **AD Connector config** — Split `baseDn` into `rootBaseDn` (required, top-level boundary) and `userSearchBase` (optional, narrower OU). Backward compat: existing configs with `baseDn` auto-migrate to `rootBaseDn` on load. Added `port` field. Scoping validation: `userSearchBase` must be inside `rootBaseDn`.

### Added (2026-02-13)
- **Active Directory Connector** — On-premises AD connector for user provisioning via LDAP/LDAPS. Supports Base DN partitioning (tenant isolation). Capabilities: discover (groups), provision, deprovision, healthCheck. Config: host, baseDn, serviceAccount, password, useLdaps, defaultDomain, userOu. Registered in connector registry (`GET /api/v1/connectors/available` includes `ad`). Task queue: `provisioning-ad`.

### Fixed (2026-02-13)
- **Post-architecture audit fixes:**
  - **API calls without auth:** PolicyEngineStudio, GroupListView, PolicyEditor used raw `axios` instead of `axiosInstance` — no Bearer token sent. Switched to `axiosInstance`.
  - **fetch without auth:** UserTimeline and ProvisioningProgress used `fetch()` without auth headers. Switched to `axiosInstance`.
  - **Hardcoded tenantId:** ReconciliationDashboard (`tenantId: "default"`) and BulkOperations (`tenantId: "default-tenant"`) now use `getTenantId()` with `dev-tenant` fallback for dev mode.
  - **God tenant fallback (backend):** batch-provision.controller no longer falls back to `euroid-default` or `default` when tenant context is missing; now throws `ForbiddenException`.
- **Frontend 404 on `/api/v1/identity`, `/api/v1/role-bundles`:** Data provider was double-prefixing `/api/v1` because both `@refinedev/simple-rest` and the axios instance used `API_BASE`. Axios `baseURL` is now empty; the provider builds full paths.
- **Users not appearing after create (multi-tenancy):** CreateUserModal and OnboardingWizard were hardcoding `tenantId: 'default'` while dev mode uses `dev-tenant`. Fix: use `getTenantId()` from token-store so created users match the JWT tenant. For existing users with `tenantId: 'default'`, run `POST /api/v1/tenants/migrate` with body `{ targetTenantId: "dev-tenant" }` (super-admin).
- **WebSocket 404 on `api.fake-rest.refine.dev`:** Ensure `.env` uses `VITE_API_BASE_URL=http://localhost:3001/api/v1` (or `/api/v1` with Vite proxy). Never use `api.fake-rest.refine.dev` — that is Refine's demo API.
- **Vite proxy:** Added `/events` proxy for WebSocket when using relative `VITE_API_BASE_URL=/api/v1`.

### Testing Without Login
- **No login window needed for local testing.** Set `VITE_AUTH_DISABLED=true` in `frontend/.env`. The app uses a synthetic dev user (`dev@localhost`) without an IdP. Backend must also have `AUTH_DISABLED=true` in `.env` for full dev mode.
- **Required `.env` for local dev:**
  - `VITE_AUTH_DISABLED=true`
  - `VITE_API_BASE_URL=http://localhost:3001/api/v1` (or `/api/v1` if using Vite proxy; backend must be on 3001)

### Changed
- **`GET /api/v1/reconciliation/drifts`** — Now supports server-side pagination and search. Query params: `page` (1-based), `limit` (default 50, max 100), `search` (matches userDisplayName or userEmail). Response includes `total`, `page`, `limit`, `totalPages` alongside `drifts`. Existing clients without `page`/`limit` receive first 50 results (backward compatible via overload).

---

## [Batch 8] — Multi-Tenancy (2026-02-12)

### Added
- **Tenant Management API:** Super-admin only endpoints for tenant CRUD and data migration. `POST /api/v1/tenants` — create tenant. `GET /api/v1/tenants` — list all tenants. `GET /api/v1/tenants/:id` — get tenant by ID. `PATCH /api/v1/tenants/:id` — update tenant (including `status: 'active' | 'suspended'`). `DELETE /api/v1/tenants/:id` — suspend tenant. `POST /api/v1/tenants/migrate` — migrate documents missing tenantId to target tenant (body: `{ targetTenantId: string }`). All endpoints use `@SystemOperation()` to bypass TenantGuard.

### Changed
- **WebSocket tenant isolation:** Events gateway now extracts `tenantId` from JWT on connection. Clients without `tenantId` are disconnected. Rooms are tenant-prefixed (`t:{tenantId}:anomalies`, etc.). `GET /api/v1/realtime/status` returns tenant-scoped connection count.
- **Domain events:** RealTimeBridgeService broadcasts to `t:{tenantId}:{room}` rooms. The `_tenantId` payload hack has been removed.
- All API endpoints are tenant-scoped via JWT claims (`tenantId` claim, configurable via `JWT_TENANT_CLAIM`).
- Temporal workflows include `TenantId` search attribute.
- SCIM tokens are bound to the creating tenant.

### Notes
- Existing single-tenant deployments: set `DEFAULT_TENANT_ID` and run the migration endpoint.
- JWT tokens must include a `tenantId` claim (configurable via `JWT_TENANT_CLAIM` env var).
- Development mode (`AUTH_DISABLED=true`) uses `DEV_TENANT_ID` env var (default `dev-tenant`).
- Frontend sends `X-Tenant-Id` header for traceability (backend uses JWT claims, not this header).

---

## [Batch 7] — SCIM 2.0 Gateway (2026-02-12)

### Added
- **SCIM Outbound Connector** — Generic SCIM 2.0 connector for provisioning to any SCIM-compliant SaaS app. Registered in Connector Marketplace as "SCIM 2.0 (Generic)" with support for Bearer, Basic, and OAuth2 authentication.
- `POST /scim/v2/Users` — SCIM inbound: create user identity from external system
- `GET /scim/v2/Users` — SCIM inbound: list users with pagination and filtering
- `GET /scim/v2/Users/:id` — SCIM inbound: get single user
- `PUT /scim/v2/Users/:id` — SCIM inbound: full replace user
- `PATCH /scim/v2/Users/:id` — SCIM inbound: partial update user (PatchOp)
- `DELETE /scim/v2/Users/:id` — SCIM inbound: soft-delete user
- `POST /scim/v2/Groups` — SCIM inbound: create group (maps to entitlement catalog)
- `GET /scim/v2/Groups` — SCIM inbound: list groups
- `GET /scim/v2/Groups/:id` — SCIM inbound: get group with members
- `PUT /scim/v2/Groups/:id` — SCIM inbound: replace group
- `PATCH /scim/v2/Groups/:id` — SCIM inbound: add/remove group members
- `DELETE /scim/v2/Groups/:id` — SCIM inbound: delete group
- `GET /scim/v2/ServiceProviderConfig` — SCIM discovery: feature support declaration
- `GET /scim/v2/Schemas` — SCIM discovery: User and Group schema definitions
- `GET /scim/v2/ResourceTypes` — SCIM discovery: resource type metadata
- `POST /api/v1/scim-tokens` — Generate SCIM bearer token (super-admin)
- `GET /api/v1/scim-tokens` — List SCIM tokens (metadata only, super-admin)
- `DELETE /api/v1/scim-tokens/:id` — Revoke SCIM token (super-admin)

### Notes
- SCIM endpoints at `/scim/v2/` follow the SCIM protocol convention and are NOT under the `/api/v1/` prefix.
- SCIM endpoints use bearer token authentication (managed via `/api/v1/scim-tokens`), NOT JWT.
- SCIM discovery endpoints (ServiceProviderConfig, Schemas, ResourceTypes) are public — no authentication required.
- Token management endpoints (`/api/v1/scim-tokens`) use standard JWT auth with super-admin role.

---

## [2026-02-12] Swagger & API Documentation Hardening

### Added
- Bearer auth support in Swagger UI (click Authorize → paste JWT)
- @ApiTags on all controllers (Onboarding, Batch Provisioning, Blueprints, Bulk Provisioning, Health, Dev Tools)
- @ApiOperation summaries on all endpoints
- @ApiResponse for 401/403/429 on mutation endpoints (Identity, Policy, Onboarding, Connectors, Blueprints)
- API Stability Contract document (docs/architecture/api/API_STABILITY_CONTRACT.md)

### Unchanged
- All endpoint paths remain the same
- No breaking changes to request/response DTOs

---

## [1.0.0] — 2026-02-12 — Platform Foundation
### Added
- **HR Ingest Endpoint:** `POST /api/v1/connectors/:name/ingest` — trigger HR ingest from csv-hr or json-api-hr. Body: `{ tenantId?: string }`. Returns `{ ingested: number, errors: string[] }`. Connector must be installed first. Protected: connector-admin, operator, super-admin.
- **Multi-tenancy context layer:** JWT claims now include `tenantId` (configurable via `JWT_TENANT_CLAIM` env, default `tenantId`). All authenticated requests require tenant context; `TenantGuard` rejects requests without it. `@Public()` and `@SystemOperation()` endpoints bypass tenant check. Dev mode (`AUTH_DISABLED=true`) uses `DEV_TENANT_ID` (default `dev-tenant`). Mongoose queries auto-scope by tenantId from AsyncLocalStorage; use `skipTenantScope: true` for system operations. `withTenantContext(tenantId, fn)` for background jobs and Temporal activities.
- **Connector Plugin Architecture:** `GET /api/v1/connectors/available` — list registered connector plugins with config schemas (id, name, version, description, icon, capabilities, configSchema). Protected: operator, policy-admin, super-admin. Connectors are self-describing and self-registering via manifests.
- **Real-Time Event Gateway:** WebSocket gateway at namespace `/events` — real-time domain event push to frontend clients. Connect via socket.io with JWT in `auth.token` or `query.token`. Rooms: `anomalies`, `provisioning`, `drift`, `reviews`, `analytics`, `system`. `GET /api/v1/realtime/status` — WebSocket connection status (super-admin only).
- **Predictive Analytics:** Offboarding blast radius pre-computation, license consumption forecasting, and seasonal onboarding pattern detection. `GET /api/v1/analytics/upcoming-offboardings` — list pre-computed offboardings (query: daysAhead, refresh). `GET /api/v1/analytics/upcoming-offboardings/:identityId` — single identity blast radius. `GET /api/v1/analytics/license-forecast` — all license forecasts (query: daysAhead, default 90). `GET /api/v1/analytics/license-forecast/:system/:license` — specific license forecast. `GET /api/v1/analytics/seasonal-patterns` — seasonal onboarding patterns. `POST /api/v1/analytics/refresh` — trigger pre-computation refresh (super-admin). Event listeners: identity.updated invalidates offboarding cache when endDate changes.
- **Access Reviews (Continuous Access Certification):** Access review campaigns with Temporal-backed deadline management. `POST /api/v1/access-reviews/campaigns` — create campaign (DRAFT) (policy-admin). `GET /api/v1/access-reviews/campaigns` — list campaigns (filter by status; paginated). `GET /api/v1/access-reviews/campaigns/:id` — campaign detail with stats. `POST /api/v1/access-reviews/campaigns/:id/activate` — activate and generate review items (super-admin). `POST /api/v1/access-reviews/campaigns/:id/cancel` — cancel campaign (super-admin). `GET /api/v1/access-reviews/campaigns/:id/items` — list review items (filter by decision, reviewerId; paginated). `GET /api/v1/access-reviews/items/:itemId` — single review item. `POST /api/v1/access-reviews/items/:itemId/decide` — approve/revoke with optional justification (operator). `GET /api/v1/access-reviews/my-reviews` — items assigned to current user (from JWT). Scope types: department, role, system, all. Domain events: `access_review.campaign_created`, `access_review.campaign_activated`, `access_review.campaign_completed`, `access_review.item_approved`, `access_review.item_revoked`, `access_review.item_expired`.
- **Policy Suggestions:** Intelligent policy suggestion service. `GET /api/v1/policy-suggestions` — list suggestions (filters: type, status, confidenceMin; paginated). `GET /api/v1/policy-suggestions/:id` — single suggestion detail. `POST /api/v1/policy-suggestions/:id/accept` — accept and create DRAFT policy (policy-admin). `POST /api/v1/policy-suggestions/:id/dismiss` — dismiss with reason (policy-admin). `POST /api/v1/policy-suggestions/analyze` — trigger analysis (super-admin). Suggestion types: BIRTHRIGHT_PATTERN, ORPHAN_ENTITLEMENT, REDUNDANT_POLICY, COVERAGE_GAP.
- **Anomaly Detection:** Access anomaly detection service with rule-based heuristics. `GET /api/v1/anomalies` — list anomalies (filters: identityId, type, severity, status; paginated). `GET /api/v1/anomalies/:id` — single anomaly detail. `POST /api/v1/anomalies/:id/acknowledge` — mark acknowledged (operator). `POST /api/v1/anomalies/:id/dismiss` — mark dismissed with reason (operator). `GET /api/v1/anomalies/risk-scores` — list identities with risk scores, sorted descending. `POST /api/v1/anomalies/analyze` — trigger analysis (super-admin only). Detection rules: TIME_BASED (outside business hours), PEER_DEVIATION (unique entitlements vs peers), VELOCITY (excessive changes in short window), PRIVILEGE_ESCALATION (rapid privilege increase), ORPHAN_ACCESS (entitlements not in policy/catalog). Domain events: `anomaly.detected`, `anomaly.resolved`.
- **Data retention & soft-delete:** Identity/User delete/offboard now uses soft-delete (`deletedAt`) instead of hard delete. All read paths exclude soft-deleted by default. `POST /api/v1/dev/retention/purge-deleted` (super-admin) hard-purges identities after `IDENTITY_SOFT_DELETE_RETENTION_DAYS`. See `docs/architecture/security/DATA_RETENTION.md`.
- **TTL indexes:** `user_events`, `transaction_logs`, `audit_events` have configurable TTL via env (`WORKFLOW_RETENTION_DAYS`, `USER_EVENTS_RETENTION_DAYS`, `AUDIT_RETENTION_DAYS`). Workflow data is sourced from Temporal (no local collection).

### Changed
- **Temporal task queues (bulkhead pattern):** Workers now use per-connector task queues (`provisioning-entra`, `provisioning-ad`, `provisioning-jira`, `provisioning-default`). A slow or failing connector cannot starve others. No API change — operational only. See `docs/architecture/infrastructure/TEMPORAL_QUEUES.md`.

### Added
- **Secrets encryption at rest:** Connector credentials and blueprint configs containing secrets are encrypted with AES-256-GCM before storage in MongoDB. Set `ENCRYPTION_KEY` (base64, 32 bytes) or `ENCRYPTION_KEY_PASSPHRASE` in `.env`. See `docs/architecture/security/SECRETS_MANAGEMENT.md`. Backend fails fast at startup if neither is set.
- **Dead Letter Queue (DLQ):** `GET /api/v1/dead-letter` — list failed events (filters: type, status, limit, offset). `GET /api/v1/dead-letter/:id` — single entry. `POST /api/v1/dead-letter/:id/dismiss` — mark as dismissed. `POST /api/v1/dead-letter/:id/replay` — replay entry (super-admin only). List/dismiss require `operator`; replay requires `super-admin`.
- **API rate limiting:** Global throttling via `@nestjs/throttler` — 10 requests/second and 100 requests/minute. Returns `429 Too Many Requests` when exceeded. Health endpoints (`/api/v1/health`, `/api/v1/health/ready`) and `/metrics` are exempt.
- **Health check endpoints:** `GET /api/v1/health` (liveness) and `GET /api/v1/health/ready` (readiness). Both are `@Public()` — no auth required for load balancers and Kubernetes probes. Liveness returns `{ status, uptime }`. Readiness returns `{ status, uptime, timestamp, components: { mongodb, connectors } }` with status `ok` | `degraded` | `unhealthy` (503 when unhealthy).
- **Swagger JSON export:** `swagger-spec.json` is now written to project root on backend startup. Use it as the source of truth for endpoints, DTOs, and validation rules.
- **Correlation header:** Every API response includes `X-Correlation-ID` (use client-provided value or auto-generated UUID). Pass `X-Correlation-ID: <uuid>` to trace requests across logs and audit.
- **Trace header:** When OpenTelemetry tracing is enabled, responses include `X-Trace-Id` (OTel trace ID) for correlation with Jaeger/Tempo traces. Use with `X-Correlation-ID` to link logs and traces.
- **Prometheus metrics endpoint:** `GET /metrics` returns Prometheus text format. Exposed at root (not under `/api/v1`). No auth required.
- **JWT authentication:** All `/api/v1/*` endpoints require a valid Bearer token in the `Authorization` header, except endpoints marked `@Public()`.
- **Dev-mode auth bypass:** Set `AUTH_DISABLED=true` in `.env` to use a synthetic dev user (`dev@localhost`) without an IdP.
- **Role-based access control:** Endpoints enforce roles via `@Roles()`. Hierarchy: `super-admin` → `connector-admin` / `policy-admin` → `operator` → `viewer`.

### Changed
- **Auth required:** All API endpoints (except `@Public()` and `/metrics`) now require authentication. Clients must send `Authorization: Bearer <jwt>`.
- **Public endpoints:** `GET /api/v1/health`, `GET /api/v1/health/ready`, and `GET /api/v1/batch-provision/health` are public (no auth required).
- **Role requirements:** GET endpoints require `viewer`; mutations require `operator`, `policy-admin`, or `connector-admin` per the permission matrix.

---

## TASK_100/101/102 Recap (Security Phase)

- **TASK_100:** JWT revocation via tokenVersion, revoke/change-password/update-admin endpoints.
- **TASK_101:** Break-glass emergency token (X-Emergency-Token), CRITICAL audit, rate limit.
- **TASK_102:** Encryption v2 format, key ring, reEncrypt(), rotate-encryption-key.ts script.
