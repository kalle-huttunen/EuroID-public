# Privileged Access Management (PAM) Architecture

> **Module:** Privileged Access (Extended — supports Pillar 2 Brain)
> **Cross-cutting:** [Data Flows](../../../../../docs/architecture/core/DATAFLOWS.md) | [Identity Hub](../../identity/docs/HUB_AND_SPOKE.md)

## Overview

EuroID implements a **Linked Admin Identity** model for privileged access management. When a policy assigns a privileged role (e.g., M365 Global Admin), the system creates a separate admin identity in the Identity Hub rather than adding the privilege to the user's daily-driver account.

This follows Microsoft's recommended tiered admin model and aligns with NIST SP 800-53 AC-6 (Least Privilege).

---

## Tiered Admin Model

| Tier | Examples | Admin Account Required | Approval Required |
|------|----------|----------------------|-------------------|
| **Tier 0** (Global/Enterprise) | Global Admin, Exchange Admin, Security Admin, Privileged Role Admin | Always | Always |
| **Tier 1** (Service) | User Admin, Groups Admin, License Admin, Intune Admin | Always | Configurable |
| **Tier 2** (Helpdesk) | Password Admin, Helpdesk Admin, Reports Reader | Configurable (`PAM_TIER2_REQUIRES_ADMIN_ACCOUNT`) | No |

---

## Linked Admin Identity Model

Admin identities are **first-class Identity documents** in the Hub with `employmentType: ADMIN_ACCOUNT` and a `parentIdentityId` link back to the primary user.

```
    Primary Identity (kalle@contoso.com)
    ├── profile: { firstName: Kalle, ... }
    ├── provisioning: [ { target: entra-id, status: SYNCED } ]
    └── linkedAdminAccounts: [
          {
            identityId: "ObjectId(admin-identity)",
            adminTier: "TIER_0",
            status: "ACTIVE",
            activatedAt: Date
          }
        ]

    Admin Identity (adm-kalle@contoso.com)
    ├── profile: { firstName: Kalle, employmentType: ADMIN_ACCOUNT, ... }
    ├── parentIdentityId: "ObjectId(primary-identity)"
    ├── adminTier: "TIER_0"
    └── provisioning: [ { target: entra-id, status: SYNCED } ]
```

### Why Separate Accounts?

1. **Blast radius reduction**: Compromised daily-driver account doesn't grant admin access
2. **MFA enforcement**: Admin accounts can have stricter MFA policies
3. **Audit clarity**: Admin operations are clearly attributable to admin identities
4. **Lifecycle independence**: Admin access can be activated/deactivated without affecting regular access
5. **Compliance**: SOX and ISO 27001 require separation of administrative and regular access

---

## Data Flow

### Admin Account Creation (Policy-Triggered)

```
    HR Sync ──▶ Identity Hub ──▶ Policy Engine
                                      │
                                      ▼
                              PolicyProvisioningIntent
                              ├── operations: [ regular entitlements ]
                              └── adminOperations: [
                                    { type: group, targetId: "Global Admin",
                                      adminTier: TIER_0 }
                                  ]
                                      │
                        ┌─────────────┴──────────────┐
                        ▼                            ▼
                Regular Provisioning         Admin Account Workflow
                (daily-driver account)       (Temporal)
                                                     │
                                                     ▼
                                        1. Check: linked admin exists?
                                        2. If not: create Identity (adm-*)
                                        3. Run onboarding for admin identity
                                        4. Assign privileged entitlements
                                        5. Update parent.linkedAdminAccounts
                                        6. Audit: ADMIN_ACCOUNT_CREATED
```

### Admin Account Lifecycle (just-in-time)

A linked admin account stands **disabled** in every target system and is enabled only for a privileged session.

```
    Entry status on the parent (linkedAdminAccounts[].status):

    PENDING ──activate──▶ ACTIVATING ──all enabled──▶ ACTIVE ──expiry / deactivate──▶ INACTIVE
                              │                                                         ▲
                              └──enable failed, identity deleted, ended early───────────┘
                                 (activationError; every account disabled again)
```

- **Standing state**: the connector mappers create a linked admin identity's accounts disabled (Entra ID `accountEnabled: false`, AD `userAccountControl` 514, SCIM `active: false`, Okta `STAGED`: created with `activate=false`, so it cannot sign in before a session) and write the same on every update while its profile is not `ACTIVE` (`shared/utils/linked-admin-profile.ts`: `employmentType: ADMIN_ACCOUNT` with `sourceSystem: euroid-pam`; every other identity keeps the old mapping). After provisioning a target, `adminAccountProvisioningWorkflow` asks for a disable-only run (patch `admin-account-provisioning:settle-standing-state`, activity `settleAdminAccountState`) unless a session is open.
- **Activate** (`PUT /admin-accounts/:adminId/activate`): the checks (live admin identity and parent, the parent or `connector-admin`/`super-admin`) stay in `PrivilegedAccessService`; `PrivilegedSessionService.activate` starts `privilegedSessionWorkflow` (`workflows/privileged-session.workflow.ts`, id `t-<tenant>-pam-session-<adminId>`, TenantId search attribute, `PamSessionService`) with the tier's `PAM_TIER*_MAX_HOURS`. The workflow sets the entry ACTIVATING, enables each provisioned account (`workflows/privileged-session-accounts.ts`: Entra ID `enableEntraUser`, AD `setAdUserEnabled`, SCIM `setScimUserActive`, Okta `setOktaUserEnabled` (unsuspend; a `STAGED` user is activated, `PROVISIONED`, and Okta emails its owner the activation link, so the account can be used once its owner finishes it); GitHub, ServiceNow and targets without accounts are skipped and logged), and only then records ACTIVE with `activatedAt`, `expiresAt`, the admin profile ACTIVE and `pamTargetState: enabled` (`PamSessionStateService.recordActive`, which reads the deletion again first), emitting `admin_account.activated`. The API waits up to `PAM_ACTIVATION_WAIT_MS` (default 15 s) for the entry's outcome under its `sessionId`: 200 `{ state: "ACTIVE", expiresAt }`, 202 `{ state: "ACTIVATING" }` when the wait ends first, 502 with the reason when enabling failed, 409 while a session or disable run of the admin identity runs.
- **Activation failure**: an account that fails after its activity's retries, an account the target does not have, no account to enable, the identity deleted, or an end signal before the session was active: the workflow disables every account again and records the entry INACTIVE with `activationError` (`recordFailed`). Nothing stays enabled; the admin profile never turns ACTIVE.
- **Session end**: a durable timer until `expiresAt`, or the `endPrivilegedSession` signal. Then every account (read again) is disabled; the entry turns INACTIVE with `deactivatedAt`, the admin profile INACTIVE, `pamTargetState: disabled`, and `admin_account.deactivated` carries the reason (`expired`, `deactivated`, `offboarded`). An account that cannot be disabled leaves `pamTargetState: enabled` and `disableError` on the entry; the hourly sweep retries.
- **Deactivate** (`PUT /admin-accounts/:adminId/deactivate`): signal-with-start: a running session gets the end signal; with none running a disable-only run starts, so the accounts end disabled either way. Waits like activate: 200 `{ state: "INACTIVE" }` (or `"PENDING"`), 202 `{ state: "DEACTIVATING" }`. The admin identity's `provisioning[]` entries stay as they are, since offboarding reads them to find the accounts to remove. Before 2026-11-25 the code meant to mark every entry DEPROVISIONED; with Mongoose 9 that update stored the entries unchanged, and offboarding an admin identity still targets an entry marked so when its account id (Entra ID object id, AD DN, SCIM id) is stored (`getOffboardingTargets`, `identity-provisioning.service.ts`); without one the deprovision could never find the account and would fail on every rerun.
- **Hourly sweep** (`runEntitlementExpiryCheck`, `entitlement-expiry.activities.ts`): an ACTIVE entry whose `expiresAt` has passed gets its session ended as a deactivation (a safety net for the timer). Then `PrivilegedSessionService.convergeStandingState` starts a disable-only run for every live admin identity whose `pamTargetState` is not `disabled` (unset for admin accounts provisioned before sessions existed) and whose entry is not ACTIVE or ACTIVATING, unless one of its runs is running; at most `PAM_STANDING_STATE_SWEEP_LIMIT` (default 50) per tenant and sweep, the rest in the next sweep, and the count is logged.
- **Okta accounts waiting for activation**: a session's first enable activates a `STAGED` Okta account, which makes it `PROVISIONED` until its owner finishes the activation Okta emailed. Okta suspends only an `ACTIVE` user, so disabling a `PROVISIONED` one fails (422, `OktaProvisioningService.setUserEnabled`): the session records `pamTargetState: enabled` and the failure on the entry, and the hourly sweep suspends it once the owner has activated it. Before, the session counted it as disabled, and an owner who activated after the session ended had an `ACTIVE` account outside any session that the sweep skipped. While it waits, the sweep starts no run for it: `convergeStandingState` takes a status reader from the hourly activity (`OktaService.getUserStatus`, read only) and skips an admin identity whose `disableError` names Okta failures only while Okta still says `PROVISIONED` or `STAGED` (`pam-okta-activation.ts`); a failure in another system, a failed read or any other status starts the run as before. Once the account has waited `PAM_ACTIVATION_PENDING_ALERT_DAYS` (default 7; since Okta's `statusChanged`, else since the session ended), the sweep emits `admin_account.activation_pending` (`parentIdentityId`, `targetSystem`, `targetStatus`, `pendingSince`, `alertAfterDays`; audited, webhooks) once, marked by the entry's `activationPendingAlertedAt`, which a disable that succeeds clears.
- **Offboarding ends the session**: the linked admin lookup at the start of an offboarding (`getLinkedAdminIdentities`, patch `offboarding:linked-admin-cascade`) signals the running sessions of the person (when it is an admin identity) and of each live linked admin identity before their accounts are removed; `PamSessionEndHandler` signals it on `identity.deleted` (any other deletion). A session ended before it was active disables what it enabled; a deleted admin identity is never enabled.
- **Offboard**: offboarding soft-deletes the identity it runs for. Offboarding a parent identity offboards its live admin identities first (patch `offboarding:linked-admin-cascade`, `workflows/offboarding-linked-admins.ts`): each by a child offboarding under `t-<tenant>-offboard-<adminId>`, one after another, before the parent's own targets. An admin account whose offboarding fails (or leaves a target failed) counts as a failed target of the parent: the parent is suspended, not deleted, and the result's `linkedAdmins` names it. One whose offboarding already runs elsewhere is recorded as `running-elsewhere` and not waited for; right before the parent would be deleted its live admin identities are read again, and one still live (that offboarding has not finished, or it was linked meanwhile) counts as failed, so the parent stays suspended until a rerun finds none. Closing the parent's last failed target by hand is refused (409) while one is live. Offboarding an admin identity removes every account its `provisioning[]` names, whatever the PAM session status (see "Deleted identities" below).

---

## Policy Engine Integration

The Policy Engine checks each generated operation against the Entitlement Catalog:

```typescript
// After evaluating conditionGroups and generating operations:
for (const operation of allOperations) {
  const catalogEntry = await catalogService.findBySystemAndNativeId(
    operation.target, operation.targetId
  );

  if (catalogEntry?.requiresAdminAccount) {
    // Redirect to admin operations
    adminOperations.push({
      ...operation,
      adminTier: catalogEntry.adminTier,
    });
  } else {
    // Keep as regular operation
    regularOperations.push(operation);
  }
}
```

### Extended PolicyProvisioningIntent

```typescript
interface PolicyProvisioningIntent {
  operations: Operation[];           // Regular entitlements (daily-driver)
  adminOperations?: AdminOperation[];  // Privileged entitlements (admin identity)
  sodWarnings?: SodViolation[];
}

interface AdminOperation extends Operation {
  adminTier: 'TIER_0' | 'TIER_1' | 'TIER_2';
}
```

---

## Entitlement Catalog Configuration

Entitlements are classified by tier and admin-account requirement:

```typescript
// entitlement_catalog collection
{
  system: "entra-id",
  name: "Global Administrator",
  nativeId: "62e90394-69f5-4237-9190-012177145e10",
  type: "Group",
  origin: "EXTERNAL",
  riskLevel: "CRITICAL",

  // PAM fields
  adminTier: "TIER_0",
  requiresAdminAccount: true,
}
```

### Default Tier Classifications

These are seeded during setup for well-known Entra ID directory roles:

| Role | Tier | requiresAdminAccount |
|------|------|---------------------|
| Global Administrator | TIER_0 | true |
| Exchange Administrator | TIER_0 | true |
| SharePoint Administrator | TIER_0 | true |
| Security Administrator | TIER_0 | true |
| Privileged Role Administrator | TIER_0 | true |
| User Administrator | TIER_1 | true |
| Groups Administrator | TIER_1 | true |
| License Administrator | TIER_1 | true |
| Intune Administrator | TIER_1 | true |
| Password Administrator | TIER_2 | configurable |
| Helpdesk Administrator | TIER_2 | configurable |
| Reports Reader | TIER_2 | configurable |

### Entra Connector Setup

Directory role discovery (Run Discovery on Entra ID) requires `RoleManagement.Read.Directory` (or `Directory.Read.All`) on the Entra app registration. Without it, discovery still runs but directory roles will not appear; groups and licenses are unaffected.

Role assignment and removal (provisioning) requires `RoleManagement.ReadWrite.Directory`. Without it, directory role sync will fail when policy intent includes role operations.

### AD Admin Group Classification (RID-Based)

For Active Directory, admin group classification is based on **well-known Windows RIDs** (Relative Identifiers) that are domain-agnostic. The classification follows the "dumb pipe" principle:

1. **AD Connector** (Hands): Discovers groups via LDAP, extracts the RID from `objectSid`, and returns it as raw metadata (`metadata.rid`)
2. **Entitlement Catalog** (Brain): `absorbDiscovered()` calls `PamFilterService.classifyByRid(rid)` to stamp `adminTier`, `requiresAdminAccount`, and `riskLevel` during ingestion
3. **Policy Engine**: Reads classified entitlements from catalog for PAM splitting

| RID | Group | Tier | Risk Level |
|-----|-------|------|------------|
| 512 | Domain Admins | TIER_0 | CRITICAL |
| 519 | Enterprise Admins | TIER_0 | CRITICAL |
| 518 | Schema Admins | TIER_0 | CRITICAL |
| 544 | Administrators (Builtin) | TIER_1 | HIGH |
| 548 | Account Operators | TIER_1 | HIGH |
| 549 | Server Operators | TIER_1 | HIGH |
| 551 | Backup Operators | TIER_2 | MEDIUM |
| 550 | Print Operators | TIER_2 | MEDIUM |

The canonical source of truth for this mapping is `PamFilterService.WELL_KNOWN_AD_ADMIN_RIDS` in `modules/policy/pam-filter.service.ts`.

---

## Naming Convention

Admin account UPN follows a configurable pattern (env var `ADMIN_UPN_PATTERN`, `infrastructure/config/pam.config.ts`; built by `admin-upn.ts`):

- Default: `adm-{firstName}.{lastName}@{domain}`
- Example: `adm-kalle.virtanen@contoso.com`
- Placeholders: `{firstName}`, `{lastName}`, `{domain}` (the primary identity's email domain) and `{tier}` (`t0`, `t1`, `t2` for TIER_0, TIER_1, TIER_2).
- Name parts are lowercased with whitespace removed. Letters with diacritics become their ASCII base letter (`Mäkinen`: `makinen`), a few letters without a decomposition are spelled out (`ß`: `ss`, `ø`: `o`), and characters Entra ID does not allow in a UPN's local part are dropped. A name that gave an ASCII UPN before gives the same UPN now; existing admin identities keep theirs.

The admin UPN is the admin identity's email, unique among live identities (the partial unique email index of `identity.schema.ts`). Creating a linked admin (`POST /api/v1/privileged-access/:parentId/admin-accounts`, and `adminAccountProvisioningWorkflow` through `getOrCreateLinkedAdminIdentity`) returns the tier's live admin identity when the parent has one (idempotent). Otherwise `PrivilegedAccessService.freeAdminUpn` picks the UPN:

| Who holds the pattern's UPN | Result |
|---|---|
| Nobody live | The UPN |
| Another person's identity (a namesake's admin account, any live identity) | The next numeric suffix at the end of the local part (`adm-ada.lovelace2@...`), up to `ADMIN_UPN_MAX_SUFFIX` (default 20); none free is a 409 |
| The same person's admin account of another tier | 409: the pattern has no `{tier}`, so the person cannot have a second admin account. The message names `ADMIN_UPN_PATTERN` and `{tier}`; set e.g. `adm-{firstName}.{lastName}-{tier}@{domain}` to give a person one admin account per tier |

The 409 messages name no address: from `getOrCreateLinkedAdminIdentity` they reach the workflow history in clear. Soft-deleted identities count for nothing here: a tier whose admin identity was deleted gets a new one (the old `linkedAdminAccounts` entry stays), and a soft-deleted identity's address can be reused.

In Entra ID the admin account is created under exactly this UPN (`EntraProvisioningService.resolveAdminUpn`), never under a `firstname.lastname` fallback, which would make it look like the person's daily account: a UPN outside the Entra ID default domain, or one another Entra ID account holds, fails that target (422, not retried) with a message that names the default domain and `ADMIN_UPN_PATTERN`, never the address.

### Deleted identities

Activation grants privileged access, so it needs a live admin identity of a live parent. Deactivation only takes access away and works on any admin identity, so a session can always be ended (`privileged-access.service.ts`, covered by `privileged-access-deleted.integration.spec.ts`).

| Call | Admin identity deleted | Parent identity deleted or gone |
|---|---|---|
| `POST /:parentId/admin-accounts` | not applicable | 404, nothing created |
| `PUT /admin-accounts/:adminId/activate` | 404, no session started | 409 "cannot be activated: its parent identity ... is deleted", no session started |
| `PUT /admin-accounts/:adminId/deactivate` and the hourly expiry sweep | session ended (accounts disabled) | session ended (accounts disabled) |
| `GET /admin-accounts` | left out | listed with `parentDeleted: true`; the Privileged access page shows "Parent identity deleted" and offers Deactivate only while ACTIVE |
| `GET /:parentId/admin-accounts` | its entry left out | 404 |

Deleting an admin identity (offboarding, `IdentityMutationService.markAsDeleted`) also ends its entry on the parent: an `ACTIVE` or `PENDING` entry becomes `INACTIVE` with `deactivatedAt` set (an entry already `INACTIVE` keeps its time). The enum has no value of its own for it; none is needed, since activation refuses a deleted admin identity and a session never records a deleted one ACTIVE, so the entry cannot turn `ACTIVE` again. Risk scoring's admin tier factor counts an `ACTIVE` entry only while its admin identity is live, so entries left `ACTIVE` by deletions before 2026-11-25 do not count either.

---

## Module Structure

```
backend/src/modules/privileged-access/
├── privileged-access.module.ts
├── privileged-access.service.ts       (linked admin identities, the activate/deactivate checks)
├── privileged-access.controller.ts
├── admin-upn.ts                       (ADMIN_UPN_PATTERN: ASCII names, {tier}, suffix)
├── privileged-session.service.ts      (activate/deactivate waits, the hourly sweeps)
├── pam-session.service.ts             (starts and signals privilegedSessionWorkflow)
├── pam-session-state.service.ts       (the session's reads and writes, through its activities)
├── pam-session-end.handler.ts         (identity.deleted ends the session)
└── dtos/
    └── create-admin-account.dto.ts

backend/src/workflows/privileged-session.workflow.ts   (+ privileged-session-accounts.ts, -id.ts)
backend/src/activities/privileged-access.activities.ts (session activities on the default queue)
```

### API Endpoints

```
GET    /api/v1/privileged-access/admin-accounts
GET    /api/v1/privileged-access/:parentId/admin-accounts
POST   /api/v1/privileged-access/:parentId/admin-accounts
PUT    /api/v1/privileged-access/admin-accounts/:adminId/activate
PUT    /api/v1/privileged-access/admin-accounts/:adminId/deactivate
```

---

## Security Controls

1. **MFA enforced**: All admin identities must have MFA enabled (policy action: `enable_mfa`)
2. **SoD validation**: Admin entitlements are checked against SoD policies
3. **Audit trail**: All admin lifecycle events logged (`ADMIN_ACCOUNT_CREATED`, `ADMIN_ACCOUNT_ACTIVATED`, `ADMIN_ACCOUNT_DEACTIVATED`)
4. **Tier 0 approval**: Tier 0 assignments require approval via the Access Request workflow (when available)
5. **Just-in-time accounts**: admin accounts are disabled in the target systems outside a privileged session; a session enables them for at most `PAM_TIER*_MAX_HOURS` (TIER_0 8 h, TIER_1 24 h, TIER_2 72 h by default)
6. **Time-bound access**: Admin entitlements support `expiresAt` for temporary privilege elevation

---

## Related Docs

| Doc | Relevance |
|-----|-----------|
| [`policy/docs/ARCHITECTURE.md`](../../policy/docs/ARCHITECTURE.md) | How policies generate admin operations |
| [`access-requests/docs/ARCHITECTURE.md`](../../access-requests/docs/ARCHITECTURE.md) | Approval workflows for privileged access |
| [`identity/docs/DATABASE_ARCHITECTURE.md`](../../identity/docs/DATABASE_ARCHITECTURE.md) | Identity schema with `linkedAdminAccounts` |
| [`docs/architecture/infrastructure/TEMPORAL_WORKFLOWS.md`](../../../../../docs/architecture/infrastructure/TEMPORAL_WORKFLOWS.md) | `admin-account-provisioning.workflow.ts`, `privileged-session.workflow.ts` |
