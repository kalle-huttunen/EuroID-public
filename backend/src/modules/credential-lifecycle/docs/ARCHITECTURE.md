# Credential Lifecycle Module — Architecture

## Purpose

Tracks credential state (password expiry, MFA enrollment, passkeys, certificates) per identity per target system. Provides credential policy management for defining rotation rules, MFA requirements, and compliance thresholds.

## Collections

### `credential_inventory`
One document per identity × target system. Tracks:
- **Password**: lastRotated (the target's last password change), nextRotation (due date under the policy), status (COMPLIANT/EXPIRING_SOON/EXPIRED/UNKNOWN), statusReason (why UNKNOWN), rotationCount
- **observedAt**: when the nightly run last read the account
- **MFA**: enrolled, methods[], lastVerified
- **Passkeys**: count, devices[], lastUsed
- **Certificates**: thumbprint, notBefore, notAfter, status

**Unique index:** `{ tenantId, identityId, targetSystem }`

### `credential_policies`
Defines rotation rules scoped by connector type and/or employment type:
- **Target scope**: connectorTypes[], employmentTypes[], entitlementTiers[]
- **Password policy**: maxAgeDays, minLength, requireComplexity, preventReuse
- **Rotation policy**: enabled, intervalDays, notifyDaysBefore, vaultStorage
- **MFA requirement**: required, methods[], gracePeriodDays

## How the inventory is filled (observation)

Nothing writes `credential_inventory` from outside. The nightly credential rotation run
(`credentialRotationWorkflow`, Temporal Schedule `credential-rotation-nightly`, `CREDENTIAL_ROTATION_CRON`,
default `0 3 * * *`) fills it first, per active tenant (the schedule names no tenant), in
`activities/credential-inventory-refresh.ts` (`CredentialInventoryRefresh`, called by
`runCredentialRotationBatch`). The workflow lists the active tenants (`listCredentialRotationTenants`) and
calls `runCredentialRotationBatch` once per tenant, each call with its own 30-minute timeout and one retry
(`SCHEDULED_SYNC_RETRY`), so a slow or failing tenant does not stop the others; when a tenant's call still
fails, the run fails after the last tenant, naming each failed tenant and the reason (patch
`credential-rotation:per-tenant`; before it, one call ran every tenant under one timeout). Per tenant:

1. Every live identity with a `SYNCED` Entra ID or AD provisioning entry is one account to read, with the
   account id the target wrote back (the identity's target source). Rows are named `entra-id` and `ad`.
2. The account's credential state is read through `CredentialActivities` (`getEntraCredentialState`,
   `getEntraMfaStatus`, `getAdCredentialState`): the last password change, and the registered MFA methods
   for Entra ID (a failed MFA read keeps the row's MFA state and logs one warning per tenant).
3. The policy that applies (`resolvePolicy` with the system and the identity's employment type: a policy
   scoped to connector or employment types applies only to those, so one scoped to employment types never
   applies to an identity without one; the most specific wins, the oldest of equally specific ones) sets the
   status: `EXPIRED` once the password is older than `passwordPolicy.maxAgeDays` (`password.nextRotation`
   = last change + max age), `EXPIRING_SOON` within `rotationPolicy.notifyDaysBefore` of that (14 when the
   policy has no rotation settings), else `COMPLIANT`.
4. An account it cannot judge gets `UNKNOWN` with `password.statusReason`: the system is not configured for
   the tenant, the account could not be read (the error, emails and DN names masked), no account id was
   written back, no active policy applies, the policy sets no maximum age, or the target reports no password
   change date. No account is skipped.
5. Each row records `observedAt`. A run reads at most `CREDENTIAL_INVENTORY_REFRESH_LIMIT` accounts per tenant
   (default 500), the ones never read or read longest ago first, so a larger tenant is covered over several
   nights and its call stays well inside its 30 minutes.
6. Rows of accounts the identity no longer has (deprovisioned, identity deleted) are deleted.

Then rows not read in this run whose due date has passed move to `EXPIRED` (`recalculateStatuses` with a
zero warning window: their own policy's window is applied when they are next read).

Then the run reports the tenant's refresh once with `credential.inventory_updated` (aggregate id: the
tenant), counts only: `refreshed` (accounts read), `changed` (rows whose password status changed: a read row
whose status differs from the stored one, a new row included, and a row moved to `EXPIRED` above),
`unknown` (rows read and written `UNKNOWN`) and `removed` (rows deleted in step 6). Its payload schema keeps
only those four counts, so no identity, account or person reaches the audit log or a webhook through it.

## No automatic reset

The run resets no password. EuroID has no secret storage to hand a generated password to (the policy's
`rotationPolicy.vaultStorage` is stored but not implemented), and a password nobody receives locks a person
out and breaks a service account's consumers. A due credential stays `EXPIRED` with its `nextRotation`
unchanged until someone changes the password in the target and the next run reads the new date. Each run
reports it: `credential.expiring_soon` with `daysRemaining` 0 or less and `reason` "Not reset: automatic
reset needs secret storage, which EuroID does not have. Change the password in the target system."; up to
the run's batch size (50) of each kind per tenant, the ones reported longest ago (`dueReportedAt`) or never
first, so with more due than that each is still reported on a later night. A person's password (a memorized secret, NIST SP 800-63B)
is never to be reset automatically, also once secret storage exists: a future vault-backed reset is for
service accounts only (`profile.employmentType` `SERVICE_ACCOUNT`).

`rotationPolicy.enabled`, `intervalDays` and `vaultStorage`, `passwordPolicy.minLength`,
`requireComplexity` and `preventReuse`, `mfaRequirement` and `targetScope.entitlementTiers` are stored and
returned but nothing evaluates them. The Credential lifecycle page leaves them out of its policy form.

**What an admin sees:** Governance > Credential lifecycle (`/credentials`) lists the due and overdue
credentials and the ones that could not be checked with the reason, says that automatic reset is off, and
for policy-admins shows the compliance summary and the policies; the identity page has a Credentials tab
(docs/USER_FLOWS.md Flow 22). The audit log has a `credential.expiring_soon` entry per reported credential
and run, and a `credential.inventory_updated` entry per tenant and run.

## Services

| Service | Key Methods |
|---------|-------------|
| `CredentialInventoryService` | upsert, findByIdentity, findExpiring, findByStatus, findDueToReport, markDueReported, findObservations, deleteByIds, recalculateStatuses, getComplianceSummary |
| `CredentialPolicyService` | CRUD (a name taken in the tenant: 409), resolvePolicy(targetSystem, employmentType?) |

## API Endpoints

| Method | Path | Role | Description |
|--------|------|------|-------------|
| GET | `/api/v1/credential-lifecycle/inventory?status=&limit=` | operator | Credentials in one status (`COMPLIANT`, `EXPIRING_SOON`, `EXPIRED`, `UNKNOWN`), limit 1 to 1000 (default 100), earliest due first |
| GET | `/api/v1/credential-lifecycle/inventory/:identityId` | operator | Credentials for identity (its `_id`) |
| GET | `/api/v1/credential-lifecycle/inventory/:identityId/:targetSystem` | operator | One credential (404 when none) |
| GET | `/api/v1/credential-lifecycle/expiring?daysAhead=&limit=` | operator | Due within `daysAhead` (1 to 365, default 30), overdue included, `UNKNOWN` left out, earliest due first |
| GET | `/api/v1/credential-lifecycle/compliance` | policy-admin | Compliance summary |
| POST | `/api/v1/credential-lifecycle/policies` | policy-admin | Create policy (name taken: 409) |
| GET | `/api/v1/credential-lifecycle/policies` | policy-admin | List policies |
| GET | `/api/v1/credential-lifecycle/policies/:id` | policy-admin | One policy |
| PATCH | `/api/v1/credential-lifecycle/policies/:id` | policy-admin | Update policy (a sent settings object changes only the fields it names, one the policy lacks gets the create defaults; name taken: 409) |
| DELETE | `/api/v1/credential-lifecycle/policies/:id` | policy-admin | Delete policy |

## Domain Events

| Event | Emitted By |
|-------|-----------|
| `CREDENTIAL_EXPIRING_SOON` | Rotation run: each `EXPIRING_SOON` credential, and each `EXPIRED` one with `daysRemaining` <= 0 and `reason` (not reset). `externalId` has the name in an AD DN masked |
| `CREDENTIAL_INVENTORY_UPDATED` | Rotation run: once per tenant and run, counts only (`refreshed`, `changed`, `unknown`, `removed`) |

`credential.rotated` and `credential.rotation_failed` are withdrawn (2026-11-25), with the connector
password resets (`resetPassword` on the Entra ID, AD and Okta services and clients), Okta's credential
state and MFA reads, `markRotated`, `CredentialPolicyService.findActive` and `UpsertCredentialInventorySchema`:
EuroID resets no password, so nothing emitted them or called those. A webhook subscription that names
them stays valid and receives nothing from those names, as before.

## Dependencies

- Used by: Credential Rotation CronWorkflow (F-11) and its inventory refresh, which reads Entra ID and AD
  through the connector credential activities (F-10)
- No dependency on: Policy Engine, Connectors (those depend on this module's services)

## Security

- Credential **values** (passwords, tokens) are NEVER stored in this collection, and the run generates none
- Only **metadata** is tracked (last password change, due date, status, MFA methods, when it was read)
- Events carry no password; the AD distinguished name in `externalId` has its name masked
