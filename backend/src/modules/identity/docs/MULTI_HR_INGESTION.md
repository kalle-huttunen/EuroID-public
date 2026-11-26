# Multi-HR Ingestion Architecture

> **Module:** Identity (Pillar 1 — Heart)
> **Cross-cutting:** [Data Flows](../../../../../docs/architecture/core/DATAFLOWS.md) | [Hub & Spoke](./HUB_AND_SPOKE.md)

## Overview

EuroID supports **multiple HR systems** feeding the Identity Hub. When an employee has contracts in Workday (corporate) and BambooHR (subsidiary), the system must decide which data drives provisioning — the **primary contract** wins for contract-critical fields; secondary HR supplements non-critical attributes.

This document describes the implemented architecture. For the original plan and open questions, see [docs/oldtasks/MULTI_HR_INGESTION_PLAN.md](../../../../../docs/oldtasks/MULTI_HR_INGESTION_PLAN.md).

---

## Core Concepts

| Concept | Description |
| --- | --- |
| **HR Source** | A configured HR connector (e.g., `workday-prod`, `bamboohr-subsidiary`) that pushes data into the Hub |
| **Primary HR Source** | The HR system that owns the *main* contract for provisioning decisions |
| **Secondary HR Source** | Additional HR systems that contribute data but do not override primary for contract-critical fields |
| **Contract Type** | `primary` \| `secondary` — per source, per identity. HR payloads can declare it |
| **Source Role** | `primary-hr` \| `secondary-hr` \| `target` — from connector config or inferred |
| **Field Mastery** | Per-field source of truth in `metadata.mastery` (e.g., `jobTitle: 'workday'`) |

---

## Data Flow

```
    HR-A (Workday) ──primary──┐
                              ├──▶ Identity Hub (merge by survivorship)
    HR-B (Bamboohr) ─secondary┘
                                    │
                                    ▼
                    Golden Record (primary HR wins for contract-critical fields)
                                    │
                    metadata.primaryHrSource, primaryContractExternalId
                                    │
                                    ▼
                    Policy Engine (evaluates on Golden Record)
                                    │
                                    ▼
                    Connectors (Entra, AD, …)
                                    │
                                    ▼
                    HR Write-Back → primary HR only
```

---

## Schema Extensions

### LinkedAccount (Layer 2 – Raw per source)

Each source in `identity.sources` can carry contract semantics:

```typescript
interface LinkedAccount {
  sourceName: string;      // e.g. 'workday-prod', 'bamboohr-subsidiary', 'ad'
  externalId: string;
  lastSync: Date;
  rawData: Record<string, unknown>;
  contractType?: 'primary' | 'secondary';   // HR payload can declare
  sourceRole?: 'primary-hr' | 'secondary-hr' | 'target';  // From connector config
}
```

### Identity Metadata (Layer 5)

Reconciliation writes the resolved primary source into metadata:

```typescript
metadata: {
  mastery?: Record<string, string>;
  version?: number;
  primaryHrSource?: string;           // sourceName of primary HR (e.g. 'workday')
  primaryContractExternalId?: string; // externalId in primary HR (e.g. 'WD-12345')
}
```

### StandardUserDto

Inbound HR payloads can include `contractType`:

```typescript
contractType?: 'primary' | 'secondary';  // HR systems (Workday, SAP) can send this
```

---

## Primary HR Resolution

The **ReconciliationService** (`resolvePrimaryHrSource`) resolves the primary HR source among the identity's HR sources, taking the first level that has one:

1. **contractType = 'primary'**: the source's record declares it, from its connector's contract tag at ingest (a Design Studio source node's `contractTag`, else the installed connector config's), else from the HR payload's `contractType`
2. **Connector contract tag PRIMARY**: the source's connector in the reconcile's priority list (Design Studio source nodes, else installed HR connectors)
3. **sourceRole = 'primary-hr'**: from connector config (`hrRole: 'primary'` or `contractTag: 'PRIMARY'`), or every HR source when no connector is the configured primary
4. **Any HR source**

Several sources at one level (two HR source nodes that both keep the Design Studio default contract tag PRIMARY, or two HR sources with the `primary-hr` role) are ordered by the configured source priority, so every identity has the same primary whichever source minted it: the connector's ingest priority (the source node's `ingestPriority`, else the installed connector config's; for a source without a connector entry its index in the tenant's `sourcePriorityOrder`, Admin → Recon Config), then the index in `sourcePriorityOrder`, then the source name. The Design Studio warns on an HR source node tagged Primary while another source node is too.

---

## Survivorship Rules (Merge Strategy)

| Rule | Behavior |
| --- | --- |
| **Field masters** | A field's masters come from, in this order of precedence: `metadata.mastery[field]` (one source, set by an HR source node's mastery fields), else the Brain's `correlationConfig.fieldMasteryOverrides[field]` (blueprint `connectorConfigs['euroid-core']`, Design Studio → Brain → Identity Correlation → Field Mastery; connector ids), else the tenant's `defaultMastery[field]` (Admin → Recon Config, an ordered list). An empty override list counts as unset. A listed id matches a source whose name contains it (`metadata.mastery` names the source exactly) |
| **The master writes** | The first listed master that carries a value for the field is its master: its value replaces the Golden Record value, also when it is a target such as Entra ID, and no other source changes the field (HUB_AND_SPOKE.md: IT controls Email). While no master carries a value, any other source may fill the field when it is empty, so an identity is not left without, say, an email before its first provisioning; the master's value replaces it when it comes |
| **Contract-critical → primary only** | `jobTitle`, `departmentCode`, `departmentName`, `employmentType`, `startDate`, `endDate`, `status`, `managerId`, `managerEmail` (the tenant's `contractCriticalFields`): the primary HR contract always drives them (owner decision 2026-11-24). Only the primary HR source writes them; no master applies, neither `metadata.mastery` (an HR source node's mastery fields) nor a Field Mastery override or the default mastery. Until 2026-11-24 the source `metadata.mastery` named could write them too, and a default mastery naming another source froze the field. The saves that store mastery refuse an entry naming another source for such a field (`contract-critical-mastery.ts`): `PUT /admin/reconciliation-config` (default mastery), `POST /blueprints/save` (the Brain's Field Mastery, an HR source node's mastery fields) and `POST /connectors/:name/install` / `PATCH /connectors/:name` (an installed connector's `masteryFields`), 400 with the hint to choose the primary through Contract Tag and ingest priority. The primary there is the HR source the Contract Tag and ingest priority make primary (source nodes, else installed connectors, else the first HR source tag in `sourcePriorityOrder`); naming it is accepted |
| **Secondary supplements** | A field that is neither contract-critical nor mastered: a secondary HR source writes it only while the primary HR source (and any HR source ahead of it in the merge order) carries no value for it, so the primary's value wins whatever the order of ingestion. A secondary's own change lands while the primary has none. With several secondaries the one ahead in the merge order wins |
| **Merge order** | Primary HR first, then others by connector `ingestPriority` (blueprint, else installed connector config) or `sourcePriorityOrder` |
| **Dropped fields** | When an HR ingest no longer carries a field its previous record had (missing, `null` or `''`; custom attributes compared one by one), the field is cleared on the Golden Record if that source may overwrite it (it passes the master, contract-critical and secondary rules above and is an HR source). Another source allowed to overwrite the field may then set it; a target's copy (e.g. Entra still holding the old value) may not fill it, in that merge or a later one: the cleared key is kept in `metadata.ownerClearedFields` until a source allowed to overwrite it sets it again. A source that does not own the field (a secondary HR source for a contract-critical field or one the primary carries, a non-master, a target, its master or not) never clears it. `email`, `status`, `firstName` and `lastName` are never cleared by a drop (the record needs them) |
| **Custom attributes** | Merged key by key under the rules above (masters of `customAttributes`, secondary supplements): a secondary HR source adds a key the primary does not carry, a target only fills empty ones; target ids (`targetIdKeys`) are kept under their own keys (`entraObjectId`, `adDn`) |
| **Enum fields** | `status`, `employmentType` and `priority` take only their enum's values (`UserStatus`, `EmploymentType`, `UserPriority`). A stored record's value written in another case or with spaces or hyphens for underscores (`active`, `full time`) is taken as the value it names; one that names none is left out of the profile with a warning in the log, and the rest of the record still applies (`profile-enum-values.ts`). HR ingest validates each row, so only a record stored another way (a seed, a migration) can hold such a value; before, reconcile copied it and the save failed, so Link answered 500 |

### HR-mastered fields and their override

A field is HR-mastered for an identity when an HR source would write it at the next reconcile (`ReconciliationService.hrOwnersOf`: the overwrite rule above; the primary HR source for a contract-critical field, the field's master, else the first HR source in the merge order with a value). `PATCH /identity/:id` refuses to change such a field (409, `IdentityMutationService`), and so does SCIM inbound (`/scim/v2/Users`, 400 `scimType: "mutability"`; a value repeated unchanged passes), so an edit no longer lasts only until the next sync; `GET /identity/:id/mastery` lists them for the identity page, which shows them read-only with the owner named. A field no HR source masters is kept by EuroID and stays editable (a manual edit of the department or title there still overrides the value another HR source holds in its contract, `metadata.manualOverrides`).

The one override of an HR-mastered department or job title is an attribute control (`attribute-controls.ts`, `IdentityControlsService`): `PATCH /identity/v2/:id/controls` with `manualDepartment` or `manualJobTitle`, a required `reason` and an optional `expiresAt`, audited (`IDENTITY_CONTROL_SET`, `_REMOVED`, `_EXPIRED`). While set, reconcile writes it into the profile (Step 3) and the policy contracts take it in the primary HR contract and in any HR contract holding the primary's value (`controlledContractValue`), whatever HR sends meanwhile. It ends when removed or when the hourly expiry run (`EntitlementExpiryActivities` → `IdentityControlsService.endExpiredControls`) passes its `expiresAt`; the profile then reconciles back to the HR value and `identity.updated` starts the mover from the access baseline.

### Contract-Critical Fields

```
jobTitle, departmentCode, departmentName, employmentType,
startDate, endDate, status, managerId, managerEmail
```

---

## Connector Config: HR Role

To designate Workday as primary and BambooHR as secondary, set `hrRole` in the connector config:

```json
// Connector config for "workday"
{
  "tenantId": "...",
  "clientId": "...",
  "hrRole": "primary"
}

// Connector config for "bamboohr"
{
  "apiKey": "...",
  "hrRole": "secondary"
}
```

`ConnectorConfigService.getPrimaryHrSourceName()` returns the connector name where `config.hrRole === 'primary'`.

---

## Identity Service: Source Role

`IdentityCorrelationService.getSourceRoleForSource(sourceName)` (stored on `sources[].sourceRole` at each ingest):

1. **HR or not.** When the tenant's reconciliation config lists `hrSourceTags`, a source is HR when its name contains one of them. Without a config (or with an empty list) the source's connector decides (`CorrelationConfigService.isHrSourceName`): the source is HR when it comes from a connector whose manifest declares the `ingest` capability (CSV HR, JSON API HR; the "HR" category of the marketplace), under the connector's own id (`csv-hr`, `json-api-hr`), the `sourceSystem` set in its installed config, or the `sourceSystem` of a Design Studio source node (`ConnectorConfigService.isHrSourceName`). Every other source (Entra, AD, `manual-ui`, SCIM inbound, PAM) is a target.
2. An HR source whose connector is the configured primary (`contractTag: 'PRIMARY'` or `hrRole: 'primary'`) → `primary-hr`; another HR source when some connector is primary → `secondary-hr`; with no primary configured → `primary-hr`.
3. Non-HR sources → `target`. Writeback, orphan adoption and machine-identity sync pass `target` explicitly.

The merge starts from the stored profile as a plain object, so a target (`sourceRole: 'target'`) that is not the field's master only fills fields the profile leaves empty, whatever the merge order; a field's master, target or HR, and an HR source the rules above allow overwrite them.

---

## Fetch New Hires

`HrActivities.fetchNewHires()`:

1. **Prefer Identity (Onion)** — `findIdentitiesForOnboarding()` returns ACTIVE identities
2. **Fallback to User** — legacy `findAll()` when no identities exist
3. **DTO mapping** — Uses `metadata.primaryHrSource` and `primaryContractExternalId` for `sourceSystem` / `sourceUserId`

---

## HR Write-Back

Not implemented. `HrActivities.writeBackToHr(sourceUserId, workEmail, primaryHrSource?)` is a stub: it logs and returns `{ success: true }`, no workflow calls it, and nothing is written to any HR system. The intended design:

- Write-back targets the **primary HR source** only
- `primaryHrSource` indicates which connector to use
- When Entra/AD generates work email, it flows to the primary HR system

---

## Implementation Locations

| Component | File |
| --- | --- |
| LinkedAccount schema | `backend/src/modules/identity/schemas/identity.schema.ts` |
| Reconciliation merge logic | `backend/src/modules/identity/reconciliation.service.ts` |
| Source role resolution | `backend/src/modules/identity/identity-correlation.service.ts` (`getSourceRoleForSource`), `backend/src/modules/correlation-config/correlation-config.service.ts` (`isHrSourceName`) |
| HR activities | `backend/src/activities/hr.activities.ts` |
| Connector config | `backend/src/modules/connectors/connector-config.service.ts` |
| StandardUserDto | `backend/src/shared/dtos/standard-user.dto.ts` |
| National ID hashing and removal | `backend/src/modules/identity/national-id.ts`, `backend/src/infrastructure/services/correlation-hash.service.ts`, `backend/migrations/20261125000000-strip-raw-national-id.ts` |

---

## Related Documents

| Doc | Purpose |
| --- | --- |
| [docs/oldtasks/MULTI_HR_INGESTION_PLAN.md](../../../../../docs/oldtasks/MULTI_HR_INGESTION_PLAN.md) | Original plan, roadmap, open questions |
| [DATABASE_ARCHITECTURE.md](./DATABASE_ARCHITECTURE.md) | Onion model, Identity collection |
| [HUB_AND_SPOKE.md](./HUB_AND_SPOKE.md) | Inbound/outbound flows, mastery |
| [docs/architecture/core/DATAFLOWS.md](../../../../../docs/architecture/core/DATAFLOWS.md) | Multi-HR flow diagram |

## Leavers and the primary HR source

HR leaver detection (`modules/leavers/docs/ARCHITECTURE.md`) acts only on identities whose `metadata.primaryHrSource` is the syncing source (or, with no primary resolved, whose first source it is). A secondary contract that ends, or a secondary feed that drops the person, never offboards them. Detection reads the source's own `rawData` (`customAttributes.hrStatus`, `endDate`) rather than the merged profile.

## Movers and the merged profile

HR mover detection (`modules/mover/docs/ARCHITECTURE.md`) runs after leaver detection for every identity the syncing source delivered, and compares the **merged profile** (after survivorship) with the identity's access baseline, for the trigger attributes `departmentName`, `jobTitle`, `location`, `managerEmail`. Which source wins a field is decided by the merge, not by the mover: a secondary source's sync starts a mover run only when it changed the merged value.

## HR rows of deleted identities

Offboarding soft-deletes the Golden Record (`deletedAt`), and an HR feed such as CSV HR keeps delivering the person's row. Correlation (`IdentityCorrelationService.ensureIdentityFromUser`) looks for a live identity first (source key, then the correlation rules). A row no live identity matches is checked against the deleted ones, by its source key, else by a confident correlation rule match (`CorrelationRuleEngine.findCorrelatedIdentity` with `deleted: true`, most recently deleted first). Such a row never mints a second identity (`IdentityDeletedMatchService`, `deleted-identity-rows.ts`):

| Row | Result |
| --- | --- |
| Terminated or ended: the HR status word or end date gives a leaver signal under the tenant's leaver policy (`evaluateLeaverSignal`, as leaver detection reads them), or the status is `TERMINATED` / `DELETED` | No change |
| Active, with a start date after the deletion | Rehire: the identity takes the row's email (its old address may belong to a new hire now), `deletedAt` / `deletedBy` cleared, the kill switch (`controls.isLoginDisabled`) and access baseline its offboarding left removed, then the row is ingested as an update, so the profile takes the HR status. The identity is marked `metadata.rehiredAt` / `rehiredFrom` (the syncing source), and every provisioning entry of the earlier employment is closed (`DEPROVISIONED`, also a target that keeps no account, which offboarding left `SYNCED`; `writebackComplete` false), so nothing counts as onboarded and onboarding writes the new accounts back. Audited as `identity.status_changed` (`DELETED` to the new status, reason `rehire (...)`). HR joiner detection records the rehire as a joiner of that source (`modules/joiners/docs/ARCHITECTURE.md`). A rehire whose row carries an address a live identity has now (a new hire took the former employee's address) is not revived: reviving failed on the unique email index at every sync. The row is held on that identity's conflict like a record no rule matches whose email is taken (§ Correlation conflicts: `matchedBy: 'email'`, confidence 0, `rowsHeldForConflictReview`), and the deleted identity stays as it is. A new address from HR ends it: the next sync revives the rehire |
| Any other active row (no start date, or one before the deletion) | No change. Logged with the identity id and the email masked, counted in `activeRowsOfDeletedIdentities` of the ingest result |

A row that changes nothing throws `DeletedIdentityRowIgnored` (HTTP 409 for other callers); the HR ingest counts it apart from `ingested` and `errors`, so the run stays a full sync for leaver detection.

The email is unique among live identities only, so a new hire can take a former employee's address. A match by the email alone (the `email` rule, or a source key that is the row's email because the row has no HR id) therefore does not count when the row carries an employee number and the deleted identity's records carry others (`isAnotherEmployee`): the row is a new person and is minted. A former employee who comes back with the same employee number is still found (the `employeeNumber` rule, or the source key). An HR row carries an employee number when its connector maps one: a CSV HR `columnMap` or JSON API HR `fieldMap` entry with the target `employeeNumber` puts it in `sources[].rawData.employeeNumber`, where the `employeeNumber` rule looks (before fix round 2 both connectors dropped it, so the rule never matched an HR row).


## National ID correlation

The `hashedNationalId` correlation rule matches records by a national identity number (Finnish HETU, SSN), which is restricted data (Finnish Data Protection Act, GDPR art. 87). Only its hash is kept.

| Step | What happens |
| --- | --- |
| Read | `IdentityCorrelationService.ensureIdentityFromUser` reads the tenant's correlation settings strictly (`CorrelationConfigService.getCorrelationConfig(tenantId, { strict: true })`): when the blueprint cannot be read it throws `CorrelationConfigUnavailableError` (a 503 `ServiceUnavailableException`) and stores nothing, instead of falling back to the default email rule, which would leave a custom national ID field in the record. Every other write that stores a reconciled profile reads them strictly too, before it writes (`pushSourceAndReconcile`, the controls, Merge and Link), as does `hrOwnersOf` (the PATCH 409 and `GET /identity/:id/mastery`): the defaults lack the Brain's `fieldMasteryOverrides`, so the profile would be stored as the default mastery merges it. The suggestion of link candidates keeps the fallback. An HR ingest run then fails as a whole (`HrIngestionService` rethrows it, no run report, so leaver detection never sees it) and the next sync tries again; an activity that stores a record (onboarding, bulk provisioning) is retried by Temporal. It reads the value from the field the rule names (`nationalIdSourceField`, default `hetu`), else from `customAttributes.<field>` (`national-id.ts`). An HR source delivers it through a column or key mapped to `customAttributes.<key>` |
| Hash | `CorrelationHashService.hash`: HMAC-SHA256 of the value trimmed, uppercased and without hyphens and spaces, under the tenant key HMAC(`CORRELATION_HMAC_SECRET`, tenantId). `131085-999X` and `131085999x` give the same hash; two tenants give different ones. The hash goes to `correlationId` on the record and is stored as `profile.correlationId` (unique per tenant). A `correlationId` the record brings is dropped when the tenant has the rule: the rule matches only on the hash computed here |
| Remove | Before anything holds the record (rawData, the profile, a held conflict row, events, logs), the rule's field and `hetu` are removed from it and from its `customAttributes`, whether or not the value was hashed. `hetu` is removed also for a tenant without the rule. A StandardUserDto field (such as `email` or `employeeNumber`) is never removed from the top level of a record, even when a rule names it |
| Values stored before | Values HR delivered under a key before the tenant's rule named it (the rule added, or its field changed, after the migration ran) are stored raw. Saving the Brain config with a rule whose field is new (`POST /blueprints/save`) starts, in the background, the migration's removal for that tenant (`national-id-cleanup.ts`, `cleanStoredNationalIdsAfterSave`): the rule's field and `hetu` leave `sources[].rawData`, `profile.customAttributes`, the access baseline and held rows, and an identity gets the hash of its value as `profile.correlationId` unless another identity has it (logged by id: merge them). The API log line `[national-id cleanup]` gives the counts; a failure is logged and never fails the save, and saving again runs it again. Bulk rollback snapshots are not rewritten: a restore removes the keys itself (`restoreHubState`) |
| Match | The rule (confidence 0.95) looks up `profile.correlationId` with the record's hash, among live identities and, for a rehire, soft-deleted ones (`CorrelationRuleEngine`) |
| Update | An update of a stored identity (`PATCH /identity/:id`, SCIM inbound `PUT` and `PATCH`, `IdentityMutationService.update`) loses the same keys before the write and before `identity.updated` is built, also from the previous values the event reports (a value the profile still held). An update that can hold a national ID (a `customAttributes`, a `correlationId` or a key that is no StandardUserDto field) reads the settings strictly, as ingest does. With the rule and the secret the hash becomes `profile.correlationId` (`IdentityCorrelationService.takeHashedNationalId`, the same function ingest uses), and one that another identity of the tenant already has is refused with 409, nothing changed; under the rule a `correlationId` the body brings is dropped. A body whose only change was the national ID writes nothing. A bulk rollback (`IdentityMutationService.restoreHubState`, `restoreConflictFlags`) writes back no national ID the snapshot holds (profile, sources' rawData, held row) |
| Bulk provisioning | `BulkProvisioningService.startBulkProvisioning` takes the national ID out of each user before the workflow starts (the same `takeNationalId`, settings read strictly), so the workflow input and the Temporal history hold none; with the rule and the secret its hash goes in the user's `nationalIdHash` (null without one), and a `correlationId` or `nationalIdHash` the body brings is always removed. The Hub save of the operation (`activities/bulk-provisioning-hub.ts`) hands that hash to `ensureIdentityFromUser` as `options.nationalIdHash`, which a tenant with the rule matches on when the record carries no national ID of its own, and saves neither field from the user (a batch started before `nationalIdHash` existed carries the hash in `correlationId`, as that build put it) |
| Distributed transaction | `ReconciliationService.startDistributedTransaction` (`POST /reconciliation/distributed-transaction`, whose `user` passes unknown fields through) takes the national ID out of the user before the workflow starts, as bulk provisioning does, so the workflow input and the Temporal history hold none; with the rule and the secret its hash goes in as the user's `correlationId`. The workflow's Hub save (`IdentityActivities.saveToHub`) hands a `correlationId` it gets to `ensureIdentityFromUser` as `options.nationalIdHash` |

Without `CORRELATION_HMAC_SECRET`, or with one shorter than 16 characters, nothing is hashed: national ID correlation is off and the values are dropped unhashed. The API and the worker still start (tenants without the rule need no secret) and log one warning naming the variable. `POST /blueprints/save` refuses a correlation config with a Hashed National ID rule while the server has no usable secret (400 on `connectorConfigs.euroid-core.correlationConfig.rules.<i>.strategy`, `blueprint-validation.ts`). Before the 2026-11-25 follow-ups a missing secret hashed with a fixed key from the source code, the same for every tenant, and the raw value was stored as it came in `sources[].rawData` and `profile.customAttributes`; migration `20261125000000-strip-raw-national-id` removes those values (also from the bulk rollback snapshots still kept), repairs such hashes for tenants with the rule (it refuses to run without the secret while any tenant has the rule, since the raw values are the only way to rebuild them) and removes them for the others, whose `profile.correlationId` it never makes or changes otherwise (`docs/DEPLOYMENT.md`, Upgrading to the 2026-11-25 release).

## Correlation conflicts

A record that matches an existing identity only with low confidence (below the tenant's `confidenceThreshold`, or a match whose first and last names both differ under `conflictAction: review`) is not attached to it. The matched identity gets `metadata.correlationConflict`, `requiresReview` and `conflictDetails` (both records' snapshots), and `GET /identity/conflicts` lists it. What happens to the record depends on its email, which is unique among the tenant's live identities (a partial unique index over `deletedAt: null`; existing databases get it from `migrations/20261123000001-identity-email-unique-among-live.ts`):

| Record | Result |
| --- | --- |
| No live identity has its email | An identity is minted for it (`correlationStatus: uncorrelated`, in the uncorrelated queue) and `conflictDetails.incomingIdentityId` names it. Its later rows update that identity by their source key |
| A live identity already has its email | Nothing is minted: the record is held in `conflictDetails.incomingSource` (source name, external id, raw data). `RowHeldForConflictReview` is thrown (HTTP 409 for other callers); the HR ingest counts it in `rowsHeldForConflictReview`, apart from `ingested` and `errors`, so the run stays a full sync. Each sync until the review holds it again, refreshing the held record and its snapshot without another `correlation.conflict` |

An identity holds one open conflict at a time. While it is open, a record of another source key leaves it as it is: a held record waits (it is held again at its next sync after the review), a minted one waits in the uncorrelated queue, and neither emits `correlation.conflict`. Before the 2026-11-25 release the second record replaced the first one's conflict, so two held records alternated at every sync.

A record of a new person past the tenant's identity limit (`settings.maxIdentities`, `identity-limit.ts`) mints nothing: `IdentityLimitReached` (HTTP 409 for other callers) is thrown before any write, and the HR ingest counts the row in `rowsHeldForIdentityLimit` with the limit in `identityLimit`, apart from `ingested` and `errors`. Each sync reads it again, so the first sync after the limit is raised creates the identity. Rows of people who have an identity (updates, rehires, correlations) are never held for the limit (`docs/architecture/infrastructure/ARCHITECTURE_MULTI_TENANCY.md`, Identity limit).

A record that no correlation rule matches (rules without `email`, or another employee number), or that several identities match, would be minted; when a live identity already has its email, minting failed on the unique email index at every sync. Such a record is held on that identity's conflict the same way (`flagCorrelationConflict`, `conflict-held-rows.ts`): `conflictDetails.matchedBy: 'email'`, `confidence: 0`, the record in `incomingSource`, counted in `rowsHeldForConflictReview`. A record whose email only a soft-deleted identity has is minted (see § HR rows of deleted identities for when it is a rehire instead).

Emails are compared without case. Every write stores the email trimmed and lower-cased (`backend/src/shared/utils/email.ts`: the POST and PATCH `/identity` and ingest DTOs, `ensureIdentityFromUser` for every Hub write, the update path SCIM uses, and reconcile), and every lookup asks for that form (the `email` rule, the held-row check, `findIdentityByEmail`). So `jane.doe@x.fi` from HR and `Jane.Doe@x.fi` from the IdP are one identity. Before the 2026-11-25 release the comparison was exact, and two live identities could hold one address in different cases; migration `20261125000003-identity-email-lowercase` lower-cases every stored email except such pairs, which it raises as correlation conflicts (`matchedBy: 'email'`, confidence 0, `incomingIdentityId` the other one) for a Merge. Until then reconcile keeps the casing of the one whose lower-cased form the other holds, so neither sync fails on the unique index.

Review (`POST /identity/:id/resolve-conflict`, `identity-merge.ts`):

- **Merge** adds the incoming record to the matched identity: the minted identity's sources, or the held record. A merge neither removes nor moves accounts: while the minted identity has an account in a target (an identity minted for a low-confidence record is a joiner like any other and may be onboarded), the merge is refused with a 409 that names the systems. "Has an account" is the mover's rule (`hasProvisionedAccount`: provisioned, not deprovisioned since), without the targets that keep no account (File outbound, Google Sheets, Discord webhook). The admin deletes the minted identity first (Delete user, which offboards it), then merges: a minted identity that offboarding soft-deleted is merged, keeping its deletion, and the kept identity does not take its links to the removed accounts (target sources holding a provisioning entry's account id), whose data would otherwise overwrite the kept identity's, an Entra ID mastered email for instance. A merge ends fully merged with the conflict closed, or with nothing changed, the conflict open and a 409 that says why (the minted identity has an account, another identity has the merged email, the incoming identity was merged away or removed, the held record now belongs to another identity, or an identity changed meanwhile). There is no transaction, so the order makes it safe: the minted identity is soft-deleted and releases its email (`merged-<id>@released.invalid`) first, then the kept identity takes the sources, the closed conflict and its reconciled profile in one save; if that save fails, the minted identity is put back. A merge that went through emits `identity.deleted` for the minted identity (`reason: merged-into-target`, actor `merge-resolution`), as Link does, so the access graph removes its node and the audit log and the identity's timeline record the deletion; one that offboarding had deleted was reported then and is not reported again. Which email the kept identity ends with is the merge's choice under the survivorship rules above (the email's master, else the primary HR source's email; a secondary HR source's only when the primary has none), so it may be the incoming record's. Linking an uncorrelated identity in the queue (`POST /identity/:id/link`) merges the same way, the account refusal included, and also closes the target's conflict about that identity. The queue (`GET /identity/uncorrelated`, `IdentityUncorrelatedService.findUncorrelatedIdentities`) lists the live uncorrelated and ambiguous identities, then those that offboarding soft-deleted and that hold no account (`offboarded: true`): an identity the admin deleted because Link refused its accounts stays there, and Link merges it, keeping its deletion (no second `identity.deleted`). Create standalone takes it out of the queue, still deleted. A deleted identity that still has an account is not listed, and its Link keeps the 409; one that a merge took (`wasMergedAway`) is gone (404).
- After a Merge or Link the kept identity may hold two records of one source (two `csv-hr` rows). A sync replaces the entry with its own source key, else the only entry of its source (a re-keyed record), else it adds one (`sourceEntryIndex`, `identity-helpers.ts`); before the 2026-11-25 release it replaced the first entry of the source name, so the other record was overwritten and then deduplicated away.
- **Split** keeps both identities and clears the flags. A held record cannot be split off (409): no identity can take its email. Merge it, or correct the email in its source.
- **Dismiss** clears the flags. A held record's next sync holds it again.
