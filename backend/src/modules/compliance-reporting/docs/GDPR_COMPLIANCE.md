# GDPR Compliance Mapping

> **Module:** Compliance Reporting
> **Cross-cutting:** [Data Retention](../../../../../docs/architecture/security/DATA_RETENTION.md) | [Platform Auth](../../../../../docs/architecture/security/PLATFORM_AUTH_ARCHITECTURE.md)

> **Status:** Audited against the code on 2026-11-22 (first written for CURRENT_TASK_118)
> **Last Updated:** 2026-11-24

---

## Overview

This document maps GDPR articles to their technical implementation in EuroID. Each row cites the code that implements it. Status is one of:

- **Implemented**: the cited code implements the requirement as described.
- **Partial**: some of it exists; the reason says what is missing.
- **Planned**: no code implements it yet; the reason says what exists instead, if anything.

All routes are served under the global prefix `api/v1` (`backend/src/infrastructure/config/global-prefix.ts`, applied in `backend/src/main.ts`). The GDPR controller is `@Controller('identity')` in `backend/src/modules/compliance-reporting/gdpr-compliance.controller.ts`.

The UI is the GDPR requests page (`/compliance/gdpr`, operator and above; `frontend/src/features/compliance/GdprPage.tsx`): a person found with `GET /api/v1/identity?q=&includeDeleted=true` (offboarded people included), their access export, consent records and, for a super-admin, erasure with a dry run first. Steps: `docs/USER_FLOWS.md` Flow 20.

---

## Article Mapping

| GDPR Article | Requirement | EuroID Implementation | Endpoint / Feature | Status |
|---|---|---|---|---|
| **Art. 6**: Lawfulness of Processing | Track lawful basis and consent per data subject | `consents` collection with per-identity, per-purpose records: `backend/src/modules/compliance-reporting/schemas/consent.schema.ts`, `backend/src/modules/compliance-reporting/consent.service.ts` | `POST /api/v1/identity/:id/consent`, `DELETE /api/v1/identity/:id/consent/:purpose`, `GET /api/v1/identity/:id/consent` | Partial: consent is recorded and reported, but no other module reads it, so nothing blocks processing without consent; grant and revoke emit no audit event |
| **Art. 15**: Right of Access | Provide all personal data held about a data subject | DSAR export reads `identities`, `user_events`, `audit_events`, `review_items`, `review_exclusions`, `consents`, the subject's access (the policy and request grants the identity page lists), every other collection the erasure reaches (read from `gdpr-erasure-scope.ts`, each target's `dsar` view in `dsar-scope-views.ts`: the subject's records with their fields, without other people's personal data or credential material) and the subject's linked admin identities with the same sections: `backend/src/modules/compliance-reporting/dsar-export.service.ts` | `GET /api/v1/identity/:id/dsar-export` | Implemented for EuroID's own MongoDB data. Not exported: copies of what the package holds (the Elasticsearch audit documents, the access graph node, outbox events not yet delivered) and the accounts in connected target systems, which the target holds |
| **Art. 17**: Right to Erasure | Delete all personal data on request | Erasure service hard-deletes the identity's documents in every collection that refers to it (redacting the records that stay), its access graph node and its Elasticsearch audit documents, and returns an attestation: `backend/src/modules/compliance-reporting/gdpr-erasure.service.ts`, `gdpr-erasure-scope.ts`, `gdpr-erasure-external-stores.ts` | `DELETE /api/v1/identity/:id/gdpr-erase` | Partial: the stores listed under "Out of reach" keep what they hold, `event_outbox` only loses `published` rows, and there is no transaction (see Cascade Scope) |
| **Art. 20**: Right to Data Portability | Export data in machine-readable format | DSAR export returns one structured JSON package: `backend/src/modules/compliance-reporting/dsar-export.service.ts` | `GET /api/v1/identity/:id/dsar-export` (JSON) | Partial: JSON only |
| **Art. 30**: Records of Processing | Maintain logs of all processing activities | SHA-256 hash-chained audit log with `DATA_EXPORTED` and `GDPR_ERASURE_EXECUTED` actions: `backend/src/modules/audit/audit.service.ts`, `backend/src/modules/audit/schemas/audit-event.schema.ts` | `GET /api/v1/audit` (role `viewer`), `GET /api/v1/audit/verify-integrity` (role `super-admin`): `backend/src/modules/audit/audit.controller.ts` | Partial: `verifyIntegrity` re-hashes every event, checks the links and the chain positions (`seq`) and reports deleted events, telling the ones an erasure removed (recorded on its `GDPR_ERASURE_EXECUTED` entry) from others; events written before hash version 2 (2026-11-24) have hashes that do not cover the payload; consent changes are not logged |
| **Art. 33**: Breach Notification | Notify authorities within 72 hours of breach | None | None | Planned: no incident or breach workflow exists in `backend/src` |

---

## Right to Erasure (Article 17)

### Endpoint

```
DELETE /api/v1/identity/:id/gdpr-erase
DELETE /api/v1/identity/:id/gdpr-erase?dryRun=true
```

### Authorization

- **Role:** `super-admin` only (`@Roles('super-admin')` in `backend/src/modules/compliance-reporting/gdpr-compliance.controller.ts`)
- **Confirmation:** Non-dry-run requests require `X-Confirm-Erasure: true` header, otherwise the controller returns 403
- **Status:** Implemented

### Cascade Scope

The person's linked admin identities (identities with `parentIdentityId` = the person; a person has one per admin tier, with the person's name and the admin UPN) are erased in the same run, before the person, with the whole scope below. Each gets its own `GDPR_ERASURE_EXECUTED` entry (its metadata names the `parentIdentityId`; the person's entry names them in `linkedAdminIdentityIds`) and its own counts in the attestation's `linkedAdminIdentities`. Accounts in connected systems are left as they are, the person's and the admin identities' alike: offboarding removes them (offboarding a person offboards their linked admin accounts first), so offboard before erasing.

| Collection | Delete Criteria | Notes |
|---|---|---|
| `identities` | `_id = identityId` | Hard delete (not soft) |
| `user_events` | `userId = identityId` | All timeline events |
| `audit_events` | `resourceId = identityId`, `action != GDPR_ERASURE_EXECUTED`, read before the erasure entry is written; exactly those entries (by `_id`) are deleted | Retains the `GDPR_ERASURE_EXECUTED` event, which is written before the delete, and those of earlier dry runs. The attestation counts the entries read; the erasure entry records their chain positions (`removedSeqs`) and, for entries written before hash version 2, their hashes (`removedLegacyHashes`), so the hash chain check reports the gap as this erasure. Positions and hashes name no person on their own; the Merkle checkpoints and the WORM archive keep the same hashes |
| `review_items` | `identityId = identityId` | Access review items |
| `review_exclusions` | `identityId = identityId` | Access review exclusions, active and lifted (with the reviewer and the justification) |
| `event_outbox` (model `OutboxEvent`) | `aggregateId = identityId` and `status = published` | Only published rows are deleted; pending and failed rows stay. The attestation counts use the same filter |

The other collections that refer to the identity (`gdpr-erasure-scope.ts`), each filtered by the identity's tenant:

| Collection | Criteria | Action |
|---|---|---|
| `consents` | `identityId` | Deleted |
| `credential_inventory` | `identityId` | Deleted (account ids, password and MFA state) |
| `identity_risk_scores`, `risk_scores` | `identityId` | Deleted |
| `anomalies` | `identityId` | Deleted (free-text title and description, evidence) |
| `joiner_events`, `leaver_events`, `offboarding_records`, `mover_batch_items` | `identityId` | Deleted (a mover item holds the changed attribute values) |
| `upcoming_offboardings` | `identityId` | Deleted (email, name, end date) |
| `drift_records` | `userId = identityId` | Deleted (email and name of the person's accounts' drifts) |
| `access_requests` | `targetIdentityId = identityId`, or `requesterId = identityId` without a target | Deleted: the requests for the person. Requests the person made for someone else, or approved, are that person's records and stay |
| `agent_identities` | `owner.identityId` | Kept: `owner.email` becomes `(erased)`, and so do `createdBy` and `revokedBy` when they are that owner email in any case (an admin who created or revoked an agent of their own; the acting admin's email otherwise stays), and the agent is marked ownerless (`ownerlessReason: erased`): it gets no new credential until a super-admin gives it a new owner (`POST /api/v1/nhi/:agentId/owner`) or revokes it. Each agent not marked before (at the owner's offboarding) and not revoked gets the warning audit entry `AGENT_IDENTITY_OWNERLESS` and the event `nhi.owner_lost` (reason `erased`; ids only), as at offboarding (`NhiOwnershipService.markOwnerless`, called before the deletes). The owner id stays and resolves to nobody |
| `peer_groups` | `memberIds` or `outliers.identityId` | Kept: the id is pulled from `memberIds` and `outliers` (`memberCount` and the baselines follow on the next peer group run) |
| `policy_suggestions` | `evidence.sampleUserIds` | Kept: the id is pulled from the sample |

Then, after MongoDB (so an event in flight finds no identity or email to write back), the stores outside it (`gdpr-erasure-external-stores.ts`):

| Store | Criteria | Action |
|---|---|---|
| Access graph (Neo4j), `access_graph` | `(:Identity {id, tenantId})` | `DETACH DELETE`: the node (with the email) and its edges. Neo4j not configured: nothing to erase |
| Elasticsearch audit index, `elasticsearch_audit_events` | `tenantId` and `resourceId = identityId`, not `GDPR_ERASURE_EXECUTED` | Deleted by query after the bulk buffer is flushed and the index refreshed: the same set the erasure deletes from `audit_events`, so `POST /api/v1/analytics/v2/backfill` brings back nothing it erased (and skips the entries of an erased identity a batch read before the erasure deleted them) |

A store the API cannot reach (Neo4j configured but not connected, no Elasticsearch connection, or the call fails) is named in the attestation's `notReached` and in the erasure entry; the rest is erased. The remedy needs no second erasure: `POST /api/v1/access-explorer/resync` prunes the node of an identity MongoDB no longer has, and an index rebuilt from MongoDB (DEPLOYMENT.md, "After the deploy") holds none of the person's erased entries.

Out of reach (the erasure does not touch them):

- **Other people's records naming the person**: access requests the person made for someone else or approved (`requesterEmail`, `approvalSteps.approverEmail`), review items where the person is the reviewer, and the manager fields (`profile.managerId`, `managerEmail`) on the Golden Records of the person's reports, which HR masters and the next sync writes again.
- **Audit entries filed under another resource** (an NHI agent's entries with `ownerIdentityId`, access request events) and entries where the person is the actor. The same applies to the Elasticsearch index, which mirrors `audit_events`.
- **Short-lived operational copies**, which expire on their own: `email_notifications` (recipient, subject and body; 30 days), `webhook_delivery_attempts` (event bodies; 30 days, and the receiver already has them), `dead_letter` (failed event payloads; 90 days), `transaction_logs` (`targetUser`; `WORKFLOW_RETENTION_DAYS`, 90 days by default), `rollback_snapshots` (encrypted pre-change snapshots of bulk operations; `ROLLBACK_SNAPSHOT_TTL_HOURS`), and `event_outbox` rows not yet published.
- **Orphan drift records** of accounts adopted into the identity (`orphanDetails.adoptedIdentityId`, with the account name).
- **Temporal workflow history** and **cold-storage archives**: see Known Limitations.

Deletes run in parallel with `Promise.all`, not in a transaction.

### Attestation

The erasure endpoint returns an attestation document (the response only; it is not stored as a separate document, the stored record is the `GDPR_ERASURE_EXECUTED` audit event with the counts in its metadata). `erasedBy` is the JWT email, or `unknown` if absent. `collectionsAffected` lists only collections with a count above zero, and `documentCounts` uses the keys `identities`, `user_events`, `audit_events`, `review_items`, `review_exclusions`, `outbox_events`, the collections of the table above (`consents`, `credential_inventory`, ..., `policy_suggestions`; for a kept record, the number of records the person was taken out of), `access_graph` and `elasticsearch_audit_events`. The graph and index counts are what was deleted (the erasure entry, written first, has the counts read before). `notReached` lists the stores not reached, empty when all were, for the person and their linked admin identities together. `linkedAdminIdentities` lists the person's linked admin identities erased with them (counted, on a dry run), each as `{ identityId, adminTier, collectionsAffected, documentCounts, notReached }` with the same keys; empty when the person has none.

```json
{
  "erasedAt": "2026-02-17T12:00:00.000Z",
  "erasedBy": "dpo@company.com",
  "identityId": "abc123",
  "collectionsAffected": ["identities", "user_events", "audit_events", "review_items"],
  "documentCounts": {
    "identities": 1,
    "user_events": 42,
    "audit_events": 15,
    "review_items": 3,
    "review_exclusions": 1,
    "outbox_events": 0,
    "consents": 2,
    "agent_identities": 1,
    "access_graph": 1,
    "elasticsearch_audit_events": 15
  },
  "dryRun": false,
  "notReached": [],
  "linkedAdminIdentities": [
    {
      "identityId": "def456",
      "adminTier": "TIER_0",
      "collectionsAffected": ["identities", "user_events"],
      "documentCounts": { "identities": 1, "user_events": 4, "access_graph": 1 },
      "notReached": []
    }
  ]
}
```

### Dry-Run Mode

Pass `?dryRun=true` to preview what would be deleted without deleting. Returns the same attestation structure with `dryRun: true`. A dry run still writes a `GDPR_ERASURE_EXECUTED` audit event (severity `critical`, `dryRun: true` in its metadata), and needs no confirmation header. Status: Implemented.

---

## Data Subject Access Request (Articles 15 & 20)

### Endpoint

```
GET /api/v1/identity/:id/dsar-export
```

### Authorization

- **Role:** `super-admin` or `operator` (`backend/src/modules/compliance-reporting/gdpr-compliance.controller.ts`)
- **Status:** Implemented for Art. 15; Art. 20 is Partial (JSON only; see the Art. 15 and 20 rows)

### Export Package

Returns a structured JSON containing the identity's data from `identities`, `user_events`, `audit_events`, `review_items`, `review_exclusions` and `consents`, the identity's access, its records in every other collection of the erasure scope (`records`; the scope and the export read one list, `ERASURE_TARGETS` in `gdpr-erasure-scope.ts`, so a collection added to the erasure is exported too, and `dsar-export.service.spec.ts` fails when one is not), and the same sections for each linked admin identity:

```json
{
  "exportedAt": "2026-02-17T12:00:00.000Z",
  "exportedBy": "operator@company.com",
  "dataSubjectId": "abc123",
  "identity": { /* full Identity document */ },
  "timeline": [ /* all UserEvent documents */ ],
  "auditTrail": [ /* all AuditEvent documents */ ],
  "accessReviews": [ /* all ReviewItem documents */ ],
  "accessReviewExclusions": [ /* all ReviewExclusion documents of the identity, active and lifted */ ],
  "entitlements": [ /* the identity's grants as GET /identity/:id/entitlements lists them: entitlement, type, system, source, grantedBy, status */ ],
  "consents": [ /* one per purpose: purpose, status (granted, revoked, expired; a granted one past its expiry reads expired), grantedAt, revokedAt (withdrawn), expiresAt, method */ ],
  "records": { /* per collection of gdpr-erasure-scope.ts but consents: credential_inventory (metadata only), identity_risk_scores, risk_scores, anomalies, joiner_events, leaver_events, offboarding_records, mover_batch_items, upcoming_offboardings, drift_records, access_requests, agent_identities (the agents the subject owns: what they are and their state, and `createdBy` / `revokedBy` when that was the subject), peer_groups (the group and the subject's own outlier entry), policy_suggestions (which suggestions sample the subject). Left out: tenant and version fields, who decided, acknowledged or dismissed, approvers and a manager who requested, other members, an agent's credential fingerprint */ },
  "linkedAdminIdentities": [ /* each: { identity, timeline, auditTrail, accessReviews, accessReviewExclusions, entitlements, consents, records } */ ],
  "attestation": "Generated per GDPR Article 15 — Right of Access and Article 20 — Right to Data Portability"
}
```

### Audit Trail

A `DATA_EXPORTED` audit event is emitted on each export (`logFireAndForget` in `dsar-export.service.ts`, with record counts in its metadata). It is fire-and-forget, so a failed audit write does not fail the export. Status: Implemented.

---

## Consent Management (Article 6)

### Schema

Consent records are stored in the `consents` MongoDB collection (`backend/src/modules/compliance-reporting/schemas/consent.schema.ts`), one per tenant, identity and purpose (a unique index; migration `20261126000001-consent-unique-per-purpose` removed the duplicates two grants at once could make), with the following fields. Status: Implemented.

| Field | Type | Description |
|---|---|---|
| `identityId` | string | Identity this consent belongs to |
| `purpose` | string | Processing purpose (e.g., `data_processing`, `analytics`, `marketing`, `provisioning_to_entra`) |
| `status` | enum | `granted`, `revoked`, `expired` |
| `grantedAt` | Date | When consent was granted |
| `revokedAt` | Date | When consent was revoked |
| `grantedBy` | string | Actor who recorded the consent |
| `method` | string | How consent was collected, e.g. `web-form`, `api`, `email`, `contract` (free text, not validated) |
| `expiresAt` | Date | Expiry (optional): a granted record past it is marked `expired` when a list or the report reads it |
| `tenantId` | string | Tenant isolation |

### Endpoints

| Method | Path | Roles | Description |
|---|---|---|---|
| `POST` | `/api/v1/identity/:id/consent` | `super-admin`, `operator` | Grant consent for a purpose (upsert per tenant, identity and purpose). A grant again replaces `method` and `expiresAt` with the request's (removed when it sends none) and clears `revokedAt`. 404 when the identity is not in the caller's tenant (an offboarded one counts); an `expiresAt` that is not a date is 400 |
| `DELETE` | `/api/v1/identity/:id/consent/:purpose` | `super-admin`, `operator` | Revoke consent for a purpose (sets `status: revoked`, keeps the record) |
| `GET` | `/api/v1/identity/:id/consent` | `super-admin`, `operator`, `viewer` | List all consents for an identity (granted ones past `expiresAt` marked `expired` first) |
| `GET` | `/api/v1/identity/compliance/consent-report` | `super-admin`, `operator` | Aggregate consent status per purpose for the tenant (granted ones past `expiresAt` marked `expired` first) |

Status: Implemented, with the Art. 6 gaps listed in the Article Mapping table.

### Consent Report

The consent report counts consent records, and `totalIdentities` is the number of distinct identities that have at least one consent record (not all identities in the tenant). It returns:

```json
{
  "tenantId": "dev-tenant",
  "totalIdentities": 150,
  "byPurpose": [
    { "purpose": "data_processing", "granted": 140, "revoked": 5, "expired": 5 },
    { "purpose": "analytics", "granted": 100, "revoked": 30, "expired": 20 }
  ]
}
```

---

## Known Limitations

1. **Temporal workflow history** is stored by the Temporal server, outside MongoDB, and erasure does not touch it. Its payloads (workflow inputs such as an onboarding's `targetEmail`, activity arguments and results such as profiles and drift results, signals, memos and results) are encrypted with AES-256-GCM under a key derived from `ENCRYPTION_KEY` (`backend/src/infrastructure/temporal/temporal-payload-codec.ts`; `backend/src/infrastructure/secrets/docs/ARCHITECTURE.md` § Temporal Payloads), so the Temporal database and UI show none of that data in clear. Workflow ids and types, the `TenantId` search attribute and failure messages stay readable (an activity error that names a person keeps the name). Closed histories are deleted after the namespace's retention period; one that must go sooner is purged separately via the Temporal Admin API.
2. **Consent expiration** happens on read: a granted consent past `expiresAt` is marked `expired` when the identity's consents are listed or the report is built (no job runs it, so the stored status of a record nobody reads can lag; every answer is current). A grant again with a new expiry makes it granted again.
3. **MongoDB transactions**: Erasure uses parallel delete calls (not a single transaction). After a partial failure, re-running the erasure completes the cleanup only while the identity document still exists, because the endpoint returns 404 once `identities` is deleted.
4. **Hash chain after erasure**: Erasure deletes `audit_events` rows and its `GDPR_ERASURE_EXECUTED` entry records what it removed (`removedSeqs`, `removedLegacyHashes`), so `verifyIntegrity` reports the gap in `erasureGaps` and stays `valid`. The link of the event after an erased one cannot be checked (the event it links to is gone). Erasures before 2026-11-24 recorded nothing: a window holding the event after their deleted entries still answers `valid: false` (`broken_link`), and nothing repairs that. A Merkle checkpoint keeps an erased entry's hash as a leaf: the checkpoint check counts it in `eventsMissing`.
5. **Cold-storage archives are out of reach.** Erasure deletes from MongoDB and the read models built from it, not from object storage. Two exports keep personal data there: the nightly archival (`archivalWorkflow`, with `ARCHIVAL_ENABLED=true`) uploads `audit_events` and `user_events` past their retention as NDJSON, raw (actor, resource name, description, payload), and deletes them from MongoDB; the daily WORM export of Merkle checkpoints (`auditArchiveWorkflow`, with `AUDIT_ARCHIVE_ENABLED=true`) uploads hashes and metadata only, unless `AUDIT_ARCHIVE_INCLUDE_PAYLOAD=true` adds the actor, resource name, description and payload, under S3 Object Lock (COMPLIANCE mode) that nobody can delete before `AUDIT_WORM_RETENTION_DAYS`. A person's entries archived before their erasure stay in those objects. Nothing in EuroID finds or rewrites them: an erasure that must reach them is done in the storage, by hand (the archival objects are per tenant under `<tenantId>/<collection>/<yyyy>/<mm>/`, listed in `archival_records`), and is not possible for a WORM object under retention. Leave `AUDIT_ARCHIVE_INCLUDE_PAYLOAD` off where erasure must be complete, and record the archives in the records of processing as a retention exception (GDPR Art. 17(3)(b) or (e)) where they are kept.
