---
Last updated: 2026-02-23
---

# Data Retention Strategy

> **Spec:** [roadmap/ROADMAP.md](../roadmap/ROADMAP.md) Wave 1
> **Task:** `docs/oldtasks/CURRENT_TASK_21.md`

## Overview

EuroID implements a data retention strategy for compliance and storage hygiene:

- **TTL indexes** on hot collections auto-expire documents after a configurable period
- **Soft-delete** for identities — `deletedAt` instead of hard delete
- **DataRetentionService** — purge soft-deleted identities after retention period

---

## Per-Collection Retention Policy

| Collection               | TTL Field  | Default | Env Variable                   |
|--------------------------|------------|---------|--------------------------------|
| `user_events`            | `timestamp`| 365 days| `USER_EVENTS_RETENTION_DAYS`   |
| `transaction_logs`       | `startedAt`| 90 days | `WORKFLOW_RETENTION_DAYS`      |
| `audit_events`           | `timestamp`| 365 days| `AUDIT_RETENTION_DAYS`         |
| `rollback_snapshots`     | `createdAt`| 24 hours| `ROLLBACK_SNAPSHOT_TTL_HOURS`  |

`rollback_snapshots` holds the state a bulk provisioning or distributed transaction rollback restores (an Entra account's pre-change state, Golden Records), encrypted with `EncryptionService` and scoped by `tenantId`. Only its document id goes into the Temporal history and the workflow result. Keep the TTL longer than a bulk run (`workflowExecutionTimeout`, 6 hours): a rollback after expiry reports the change as not rolled back.

**Note:** Workflow execution data is sourced from Temporal Visibility API; no local `workflow_executions` collection. Temporal has its own retention configuration.

### TTL Behavior

- MongoDB TTL runs periodically (every ~60 seconds). Documents may linger briefly after expiry.
- Indexes are created at schema load; change env vars and restart to apply new retention.
- All documents must have the TTL date field. Ensure `createdAt`/`startedAt`/`timestamp` exist before adding TTL.
- **Archival buffer:** TTL for `audit_events` and `user_events` includes a 30-day buffer (retention + 30 days) so the archival workflow can export data to cold storage before TTL auto-deletes it.

---

## Soft-Delete vs Hard-Delete Flow

### Soft-Delete (Default)

When a user is deleted via `DELETE /identity/:id`:

1. The offboarding workflow runs (deprovision from Entra ID, etc.)
2. `IdentityService.markAsDeleted(id)` sets:
   - **Identity (Onion):** `deletedAt: <now>`, `deletedBy: 'offboarding-workflow'`
3. All read paths (`findAll`, `findById`, `findOne`, etc.) exclude soft-deleted by default (`deletedAt: null`).
4. Re-sync from HR (e.g. rehire) clears `deletedAt` and restores the identity.

### Hard Purge

`DataRetentionService.purgeDeletedIdentities(retentionDays)` permanently deletes documents where `deletedAt` is older than the cut-off.

- **Default retention:** `IDENTITY_SOFT_DELETE_RETENTION_DAYS` (default 30)
- **Admin endpoint:** `POST /api/v1/dev/retention/purge-deleted` (super-admin only)
- **Dry-run:** `POST /api/v1/dev/retention/dry-run` — reports counts without deleting

---

## GDPR "Right to Be Forgotten"

To hard-delete a specific identity on request (GDPR), use `DELETE /api/v1/identity/:id/gdpr-erase` (super-admin, header `X-Confirm-Erasure: true`; `?dryRun=true` only counts). It hard-deletes the identity and its rows in `user_events`, `audit_events`, `review_items`, `review_exclusions` and published `event_outbox` rows, the person's documents in the other collections that refer to the identity (redacting the records that stay, such as an NHI agent they own), their access graph node and their Elasticsearch audit documents, writes a `GDPR_ERASURE_EXECUTED` audit event and returns an attestation (`backend/src/modules/compliance-reporting/gdpr-compliance.controller.ts`, `gdpr-erasure.service.ts`).

Scope and limits: [GDPR_COMPLIANCE.md](../../../backend/src/modules/compliance-reporting/docs/GDPR_COMPLIANCE.md). Erasure does not reach cold storage: entries the nightly archival or the WORM audit export uploaded before the erasure stay in those objects (Known Limitations, item 5). Erasures run before commit `47fa1cd7` (2026-11-24) recorded no gap, so `GET /api/v1/audit/verify-integrity` reports the hash chain there as `broken_link` (Known Limitations, item 4).

---

## Cold Storage Archival

The `archivalWorkflow` (Temporal) exports `audit_events` and `user_events` to S3 or Azure Blob before TTL deletion, then deletes the exported documents. The worker schedules it (`archival-nightly`, cron `ARCHIVAL_CRON`, default `0 2 * * *`) only when `ARCHIVAL_ENABLED=true` and `ARCHIVAL_STORAGE_PROVIDER` is set; it is off by default. Turning either off pauses the existing schedule at the next worker start, and turning it on again resumes it (`syncOptionalSchedule`, `backend/src/infrastructure/temporal/schedule-upsert.ts`). It runs per tenant (tenant list from the `tenants` collection): each archive object holds one tenant's data under `<tenantId>/<collection>/<yyyy>/<mm>/`. Cutoffs are `AUDIT_RETENTION_DAYS` and `USER_EVENTS_RETENTION_DAYS`.

This is separate from the audit archive (`auditArchiveWorkflow`, `AUDIT_ARCHIVE_ENABLED`), which exports Merkle-checkpointed audit events to S3 with Object Lock and deletes nothing. `user_events` are only covered by `archivalWorkflow`.

- **Format:** NDJSON, gzipped
- **Metadata:** `archival_records` collection tracks batchId, storagePath, documentCount, date range
- **Batches:** the oldest documents past the cutoff, deleted by id once exported, so whatever is still past the cutoff is not archived yet (rows tied at a batch's last timestamp and events written late with an old timestamp come in a later batch). A batch whose delete failed after its upload is exported again on the next run: the archive can then hold a document twice, never lose one. Batch ids are the export objects' names
- **Env:** `ARCHIVAL_STORAGE_PROVIDER` (s3 | azure-blob), `ARCHIVAL_STORAGE_BUCKET`, etc. See `backend/.env.example`

---

## Environment Variables

| Variable                             | Default | Description                                    |
|--------------------------------------|---------|------------------------------------------------|
| `WORKFLOW_RETENTION_DAYS`           | 90      | TTL for transaction_logs                       |
| `USER_EVENTS_RETENTION_DAYS`        | 365     | TTL for user_events                           |
| `AUDIT_RETENTION_DAYS`              | 365     | TTL for audit_events                           |
| `ROLLBACK_SNAPSHOT_TTL_HOURS`       | 24      | TTL for rollback_snapshots                     |
| `IDENTITY_SOFT_DELETE_RETENTION_DAYS` | 30    | Days before hard purge of soft-deleted users   |
| `ARCHIVAL_ENABLED`                  | false   | Worker schedules `archivalWorkflow` (needs `ARCHIVAL_STORAGE_PROVIDER`) |
| `ARCHIVAL_CRON`                     | `0 2 * * *` | Archival schedule                          |

---

## Admin Endpoints

| Method | Path                             | Role        | Description                    |
|--------|----------------------------------|-------------|--------------------------------|
| POST   | `/api/v1/dev/retention/purge-deleted` | super-admin | Purge soft-deleted identities |
| POST   | `/api/v1/dev/retention/dry-run`  | super-admin | Dry-run purge report           |
| GET    | `/api/v1/dev/retention/config`   | viewer      | Current retention config       |

---

## Scheduling (Optional)

The purge can be wired to a cron or Temporal workflow for scheduled execution. For now, it is manual/admin-triggered via the endpoint above.

---

*Task 108 recap: Cold Storage Archival section added. TTL buffer (30 days) documented. archivalWorkflow, archival_records, S3/Azure adapters.*
