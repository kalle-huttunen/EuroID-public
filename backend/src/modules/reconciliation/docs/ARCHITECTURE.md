# Reconciliation & Drift Detection - The 2026 Standard

> **Module:** Reconciliation (Pillar 4 — Eyes)
> **Cross-cutting:** [Data Flows](../../../../../docs/architecture/core/DATAFLOWS.md) | [Event Bus](../../../../../docs/architecture/core/EVENT_BUS_ARCHITECTURE.md) | [Temporal Workflows](../../../../../docs/architecture/infrastructure/TEMPORAL_WORKFLOWS.md)

Reconciliation is the most **computationally expensive** and **dangerous** part of the system because it can trigger **mass-deletes** if it misinterprets data. The Critical Safety Protocol below is mandatory.

---

## 🎯 The Core Problem

**"The Map is Not the Territory."**

* **Desired State (Hub):** "Alice should have Standard User access."
* **Actual State (Target):** "Alice has System Administrator access (because a SysAdmin manually changed it at 3 AM)."

This discrepancy is called **Drift**. A 2026 Identity Platform must detect and fix this automatically **without human intervention**.

---

## ⚠️ Reconciliation Landmines (Critical Safety Protocol)

Reconciliation engines have the power to "correct" data. If misconfigured, they can **"correct" your entire company out of existence**.

### 🧨 Landmine 1: The "Doomsday" Sync (Empty List)

* **The Trap:** The Connector API fails silently and returns an empty array `[]` instead of an error.
* **The Explosion:** The Reconciliation Engine thinks "Oh, 10,000 users were deleted in AD. I must delete them in the Hub to match." The system wipes out the entire database.
* **The 2026 Fix: Sanity Thresholds (Circuit Breakers).** **PLANNED:** no such threshold exists in the code (the Circuit Breaker item in the checklist below is open); the target design is:
  * If a sync operation attempts to delete/disable **>5% of total records**, STOP EVERYTHING.
  * Raise a P1 alert: "Abnormal Churn Detected." Require manual admin override to proceed.

### 🧨 Landmine 2: The "Tug-of-War" (Circular Sync)

* **The Trap:**
  * Hub Policy enforces "Title = Associate".
  * Admin manually changes Title to "Manager" in AD.
  * Recon runs → Sees mismatch → Reverts AD to "Associate".
  * AD Connector runs → Sees "Manager" (from audit log) → Updates Hub to "Manager".
  * Loop repeats forever.
* **The Explosion:** Infinite processing loop, CPU burn, and Admin frustration.
* **The 2026 Fix: Attribute Authority (Mastery).**
  * Rule: "AD is Read-Only for Titles."
  * The Recon Engine **ignores** inbound changes for fields where the Target is not the Master.
  * It only enforces the **Outbound** Policy.

---

## 🏗️ Architecture: The Loop

We don't just "provision." We run a **continuous control loop**.

```mermaid
graph TD
    Target[Target System (e.g. Entra ID)] -->|1. Discovery| LinkedAcc[Linked Account (Raw Data)]
    Hub[Hub Golden Record] -->|2. Policy Eval| Intent[Provisioning Intent]
    
    LinkedAcc -->|3. Compare| Recon{Reconciliation Engine}
    Intent -->|3. Compare| Recon
    
    Recon -->|Match?| OK[✅ Sync]
    Recon -->|Mismatch?| Drift[⚠️ DRIFT DETECTED]
    
    Drift -->|Option A| AutoFix[⚡ Auto-Remediate (Revert)]
    Drift -->|Option B| Ingest[📥 Absorb (Update Hub)]
```

---

## 🔍 Types of Drift

### 1. Account Drift (The "Orphan" Problem)

* **Scenario:** An account exists in Salesforce (`jdoe@acme.com`), but no matching user exists in the Hub (e.g., ex-employee).
* **Risk:** High (Ghost accounts / License waste).
* **Action:** Link (if human found) or Deprovision (if no owner).

### 2. Attribute Drift (The "Data Quality" Problem)

* **Scenario:** Hub says Department = Sales. Target says Department = Marketing.
* **Risk:** Medium (Policy calculations might be wrong).
* **Action:** Enforce Master. If HR is Master, overwrite Target. If Target is Master (e.g., Email in AD), update Hub.

### 3. Entitlement Drift (The "Shadow Access" Problem)

* **Scenario:** Hub says Role = Standard. Target says Role = Global Admin.
* **Risk:** Critical (Privilege Escalation).
* **Action:** Revert Immediately. This is a security violation.

---

## ⚡ Scalable Reconciliation Patterns

### 1. Scatter-Gather (Batch Processing)

To handle 1M+ users, we do not loop sequentially.

1. **Parent Workflow:** Splits user base into 100 batches of 10k.
2. **Child Workflows:** 100 workers process batches in parallel.
3. **Aggregator:** Merges drift results.

### 2. Scheduled vs. Event-Driven

**Full Recon - The Streaming Pattern:**

No schedule starts a full reconciliation: `worker.ts` creates none. `dailyReconciliationWorkflow` runs when an operator starts it (`POST /reconciliation/start-daily`, **Run daily reconciliation** on the Reconciliation page).

* **❌ Anti-Pattern:** Fetching `findAll()` into memory. This causes OOM crashes at scale.
* **✅ The Standard:** **Cursor-based Streaming.**
    1. The Workflow opens a cursor on the `identities` collection.
    2. It processes users in **Batches of 100**.
    3. It fetches the corresponding target system accounts (bulk fetch or individual).
    4. It calculates drift, commits fixes, and clears memory before the next batch.
* **Pros:** Constant memory usage regardless of user count (10k or 10M).

**Delta Recon (Real-time):**

* The Connector listens to Webhooks or reads Audit Logs (stream).
* "Event: User added to Group X".
* **Pros:** Instant reaction.
* **Cons:** Can miss things if the webhook delivery fails.

### 3. Data Virtualization (Just-in-Time)

Volatile attributes (e.g., `lastLoginTime`, `batteryLevel`) are **not stored** in the Identity Hub.

* **Flow:** When a policy needs `lastLoginTime`, the Connector fetches it *live* during evaluation.
* **Benefit:** Reduces DB churn and ensures decisions use real-time data.

### 4. The Comparison Logic (Diff Engine)

The engine compares the **Desired State (Policy Intent)** vs. the **Actual State (Linked Account Raw Data)**.

```typescript
interface DriftReport {
  userId: string;
  system: string;
  
  // What we found vs What we expected
  discrepancies: {
    field: string;        // e.g. "groups"
    actual: string[];     // ["All-Staff", "Domain Admins"] (From Linked Account)
    expected: string[];   // ["All-Staff"] (From Policy Intent)
    diff: string[];       // ["+Domain Admins"] (The Drift)
    action: 'REVERT' | 'ABSORB' | 'IGNORE';
  }[];
  
  severity: 'LOW' | 'MEDIUM' | 'HIGH';
}
```

### 5. Remediation Policies (The "Fix")

We don't always auto-fix. We let the Policy Engine decide the response to drift based on **Severity** and **Attribute Authority**.

| Drift Type | Severity | Mastery Rule | Policy Response |
| --- | --- | --- | --- |
| New Group Membership | Low | Target Owned | **Absorb:** "Okay, update the Hub to reflect they are in this group." |
| License Upgrade | Medium | Hub Owned | **Alert:** "User upgraded to E5 manually. Revert or Approve?" |
| Admin Privilege | Critical | Strict Enforcement | **Auto-Revert:** "IMMEDIATELY remove Admin rights. Do not ask." |
| Orphan Account | High | N/A | **Disable:** "Disable account until claimed." |

---

## 🔄 Data Flow Example: "The Rogue Admin"

**The Event:** A frantic sysadmin manually adds `intern_bob` to the "Database Admins" group in AD to fix a P1 issue.

**Detection:**

* **Option A (Fast):** AD Connector sees the change via webhook.
* **Option B (Slow):** Nightly scan sees `intern_bob` in the group.

**Evaluation:**

* Reconciliation Engine checks **Attribute Authority:** "Who owns Group Memberships?" → **Hub (Policy Engine).**
* Engine asks: "Does Bob's Policy allow 'Database Admins'?" → **NO.**

**Reaction:**

* Drift Detected: `+Database Admins`.
* **Severity:** High (Unauthorized Privilege).
* **Action:** Revert.

**Execution:**

* Connector sends: `remove_group_member(user=bob, group=db_admins)`.
* Notification: Sent to Security Team ("Bob was briefly an admin - Remedied").

---

### 🏛️ Architectural Decision: Hybrid Group Governance (2026)

**Principle:** *Don't fight the tide.* Allow customers to create groups in AD/Entra for agility (e.g. "Project X" by a manager). **Classify** entitlements so we know which to enforce (Policy) and which to only observe (External).

---

#### 1. The Two Types of Groups

Add a flag to the **Entitlement** schema: `origin: 'POLICY' | 'EXTERNAL'`.

**Type A: Policy Groups (The "Iron Grip")**

* **Definition:** Groups created and defined by the Policy Engine (e.g. "All Staff", "Sales Dept").
* **Source of Truth:** **EuroID Hub.**
* **Behavior:** **Strict Enforcement.**
* **Scenario:** A local admin manually adds "Bob" to "All Staff" in AD.
* **System Reaction:** Reconciliation detects **Drift**. Because this is a Policy Group, it **Auto-Reverts** (removes Bob from the group) to match the policy.

**Type B: Ad-Hoc Groups (The "Open Hand")**

* **Definition:** Groups created directly in the Target System (e.g. "Friday Lunch Club", "Project Alpha").
* **Source of Truth:** **Target System** (AD/Entra).
* **Behavior:** **Discovery & Visibility.**
* **Scenario:** A manager creates "Project Alpha" in Entra ID.
* **System Reaction:**
  * **Discovery:** Import Wizard or nightly sync detects the new group.
  * **Absorb:** Add "Project Alpha" to the **Entitlement Catalog** in MongoDB with `origin: 'EXTERNAL'`.
  * **Governance:** It appears in the **Access Review Dashboard** for audit; we do **not** revert manual membership changes.

---

#### 2. How to Handle "Hybrid" Access

**Killer feature:** Allow users to **request access** to Ad-Hoc groups via the platform.

1. Manager creates "Project Alpha" in AD.
2. EuroID discovers it (catalog with `origin: EXTERNAL`).
3. User logs into Self-Service Portal.
4. User sees "Project Alpha" in the catalog and clicks **Request Access**.
5. EuroID provisions the user into the AD group.

---

#### 3. UI Recommendation

In **Identity Hub** or **Group List**, add a **Source** column and **Governance Mode**:

| Group Name   | Source     | Governance Mode                          |
|-------------|------------|------------------------------------------|
| All Users   | 🛡️ Policy  | Strict (manual changes reverted)         |
| Sales Dept  | 🛡️ Policy  | Strict (manual changes reverted)         |
| Project X   | ☁️ External | Open (manual changes synced back)        |
| Legacy App  | ☁️ External | Open (manual changes synced back)        |

---

#### 4. Data Model: Entitlement Schema

```typescript
interface Entitlement {
  nativeId: string;       // GUID or SKU id
  name: string;           // "All Staff", "Project Alpha"
  type: 'Group' | 'License';
  system: string;         // "entra-id", "active-directory"
  origin: 'POLICY' | 'EXTERNAL';   // Classification flag
  governanceLevel: 'STRICT' | 'OPEN';  // STRICT = revert drift, OPEN = absorb only
  metadata?: Record<string, any>;
}
```

* **Catalog:** Persist in MongoDB (`entitlement_catalog`). Discovery upserts with `origin: 'EXTERNAL'`; policies register their groups as `origin: 'POLICY'`. A policy names a group by `params.groupName`, so its row has no `nativeId` until discovery finds the group by name and adds it. `nativeId` is unique per tenant and system among the rows that have one (partial unique index; existing databases get it from `migrations/20261122000001-entitlement-catalog-native-id-index.ts`), so a system holds any number of rows without one.
* **Reconciliation:** When correcting group drift, only **remove** users from groups where `origin === 'POLICY'`. For `EXTERNAL`, absorb into catalog and do not revert.

## Run Settings

`POST /reconciliation/start-daily` (operator) takes the run's settings, checked by `ReconciliationConfigSchema` (`reconciliation.controller.ts`; the type is `ReconciliationConfig` in `backend/src/workflows/workflow-types.ts`). **Run daily reconciliation** on the Reconciliation page (`frontend/src/features/reconciliation/daily-reconciliation-body.ts`, the confirmation in `daily-reconciliation.tsx`) scans `entra-id` always and `ad` and `scim` when the tenant installed their connectors (the only systems `fetchUserFromSystem` reads), with `requireApprovalForDeletes: true` and no scan scope; its confirmation offers auto-correct, on by default (`MISSING_USER` and `STATUS_MISMATCH`), off for a report-only run.

| Setting | What the run does with it |
| --- | --- |
| `targetSystems` | Compares each identity with its account in these systems, and runs orphan detection on each |
| `autoCorrect`, `autoCorrectTypes` | `reconcileBatchWorkflow` corrects a drift (`correctDrift`) when `autoCorrect` is on, the drift's type is listed, detection marked it correctable and its severity is not CRITICAL. One CRITICAL drift is corrected: a `STATUS_MISMATCH` whose hub status expects the account disabled (a leaver's account still enabled) is containment, and the run disables the account when `STATUS_MISMATCH` is listed (patch `reconcile-batch:status-containment`; a batch started before the worker ran it corrects no CRITICAL drift). Enabling an account grants access and is never auto-corrected |
| `requireApprovalForDeletes` | `true`: what cannot be undone or takes granted access away waits for a person. `GROUP_MISMATCH` and `LICENSE_MISMATCH` are not corrected and their drift stays open for **Correct one** (below): `correctDrift` has no correction for these yet, and theirs would remove a membership or a license. The orphan cleanups the run starts never delete: after the extended grace the account stays disabled even with `ORPHAN_AUTO_DELETE_AFTER_EXTENDED=true`, until [Delete] ([ORPHAN_DETECTION.md](./ORPHAN_DETECTION.md)). A disable is the reversible containment step and never waits: `ORPHANED_USER` (disables the account) and a `STATUS_MISMATCH` whose hub status expects the account disabled (disables it) are corrected as without the flag, so a leaver's account still enabled in a target is disabled at once, and so is an orphan account after the first grace period. `MISSING_USER` (creates the account) and `FIELD_MISMATCH` (rewrites attributes) are corrected too. Patches `reconcile-batch:approval-for-deletes` and `orphan-cleanup:approval-for-deletes`: a run or cleanup started before the worker ran them corrects and deletes as before. `false`: every eligible drift is corrected, and a cleanup follows the orphan config |
| `maxDriftsBeforeAlert`, `criticalDriftAlertThreshold` | After the gather the run counts its drifts one by one (`backend/src/workflows/reconciliation-alerts.ts`): at least `maxDriftsBeforeAlert` drifts, or at least `criticalDriftAlertThreshold` CRITICAL ones, puts `{ threshold, limit, found }` in the report's `alerts` (`GET /reconciliation/result/:workflowId`). 0 turns a threshold off. Orphan accounts are not counted. Patch `reconciliation:drift-threshold-alerts`: a run started before the worker ran it reads neither |
| `notifyOnDrift` | `true`: a run that reached a threshold calls `notifyDriftThresholdExceeded` once, which emits `reconciliation.drift_threshold_exceeded` (counts, `workflowId` and `runId`; no identity, account or address), so a webhook subscribed to it gets the alert, and mails `notifyEmail`. `false`: the report names the alerts and nothing is sent |
| `notifyEmail` | The address of a user of the tenant (an active admin user or an identity, `EmailRecipientsService.resolve`) that gets the alert mail (`drift-threshold-exceeded`, counts and a link to the Reconciliation page, once per run; [Email notifications](../../notifications/docs/ARCHITECTURE.md)). An address nobody in the tenant has gets no mail (an info log), and without `SMTP_HOST` no mail is sent |
| `notifySlack` | Refused with 400 ("Slack delivery is not available: subscribe a webhook to reconciliation.drift_threshold_exceeded instead"): EuroID has no Slack sender |
| `includedDepartments` | The scan scope (`backend/src/shared/utils/reconciliation-scope.ts`): the run scans only identities whose `profile.departmentName` or `profile.departmentCode` equals an entry, ignoring case ("Sales" matches "sales", never "Sales Support"). Absent or empty: every department. Orphan detection is not limited by it: an orphan account has no live identity to hold a department |
| `excludedUsers` | Identities the run never scans, so never corrects: an entry is an identity id (24 hex characters, matches `_id`) or an email address (matches `profile.email`, ignoring case); anything else is refused with 400. Orphan detection, per target system, leaves an excluded user's account alone too: one whose UPN or mail is an excluded email, or whose identity (TERMINATED or DELETED status, found as orphan detection finds it) has an excluded id or email. An offboarded (soft-deleted) identity is not found, so only its account's own UPN or mail matches then. Drifts recorded for an excluded identity before stay as they are |
| Page size | Each batch fetches its range in pages of at most `RECONCILIATION_PAGE_SIZE` identities (default 200, env of the worker), whatever the batch asks for, and only the fields detection reads (`_id`, `email`, `status`, the names, `sourceSystem`, `sourceUserId`, `employmentType`): one page is one activity result in the batch's history, and 5000 whole profiles went over Temporal's payload limit. A correction re-reads the stored identity (`correctDrift`); one no longer in the hub is not corrected |
| Scope consistency | The count (`getReconciliationUserCount`), the batch plan over that count and each batch's page fetch (`fetchHubUsersPage`) use the same filter (`IdentityQueryService.findUsersPageForReconciliation`, `backend/src/modules/identity/identity-scan-scope.ts`, sorted by `_id`), so batches neither skip nor repeat an identity. Patches `reconciliation:scan-scope` (recorded only by a run whose config has a scope) and `reconcile-batch:scan-scope`: a run started before the worker ran them scans every identity, a scope in its config or not |
| `enabled`, `cronSchedule` | Optional. A run starts on request; nothing schedules one (above). A `cronSchedule`, or `enabled: false`, is refused with 400 ("Reconciliation runs start on request: scheduled reconciliation is not available, so leave out cronSchedule and enabled: false"); `enabled: true` is accepted and not read |

## Drift Records and Their API

Drift records live in MongoDB `drift_records` (`schemas/drift.schema.ts`), per tenant. A record's `userId` is the identity's `_id`; an orphan drift's (`ORPHAN_ACCOUNT`, `orphan-detection.service.ts`) is the target account id. `status` is `open`, `corrected`, `ignored` or `quarantined`.

* **Written by reconciliation** (`detectUserDrift` in `backend/src/activities/reconciliation.activities.ts` → `DriftService.recordDetection`): every run, scheduled or for one user, stores an identity's drifts (`MISSING_USER`, `FIELD_MISMATCH`, `STATUS_MISMATCH`) under its `_id`, one open record per identity, target system, type and field. A repeated run updates that record (values, severity, `updatedAt`) and keeps its `detectedAt`. A drift an admin ignored stays ignored while the run finds the same hub and target values; with other values it is a new open drift. An open drift of a target system the run read and no longer finds is closed `corrected` (`correctedAt`, `drift.resolved` with `resolutionAction: no_longer_detected`), and an auto-correction the run made closes its drift the same way (`reconciliation_auto_correct`). Texts and ids name the identity by `_id`, never by email (`MISSING_USER` description, the correction id `<system>:<_id>:<type>`).
* **What a run compares** (`compareAccountState`, `backend/src/activities/reconciliation-account-state.ts`): only what the account lookup returns (Entra ID, AD and SCIM `getUserByEmail`: the account's id, UPN, mail, display name and enabled state; AD's lookup has no display name). The enabled state is compared with the one provisioning writes for the hub status (`targetAccountEnabled`, `backend/src/shared/utils/linked-admin-profile.ts`, the rule the Entra ID, AD and SCIM mappers use): enabled for `ACTIVE` and `PENDING`, disabled for every other status, and a linked admin account only during its privileged session. A difference is a CRITICAL `STATUS_MISMATCH` (field `status`, hub value the expected `ENABLED` or `DISABLED`, target value the account's); the one that disables is auto-correctable, the one that enables is not. The display name is compared when the hub record has one (provisioning writes it then), ignoring case and surrounding spaces: a difference is a MEDIUM `FIELD_MISMATCH` on `displayName`, auto-correctable in Entra ID only (re-provisioning), reported elsewhere. The email is not compared (the account was found by it), and no other attribute is: no lookup returns one, and compared against nothing every hub value was a drift. A `STATUS_MISMATCH` correction (the run's, **Correct one** below) sets the expected state: Entra ID by the email, AD by the DN of the account the email finds (`AdService.setUserEnabled`), SCIM by the user whose userName or email it is (`SCIMService.setActive`); an account the target no longer has fails the correction.
* **A target system reconciliation cannot read** (`reconciliation-target-config.ts`): no connector config installed, an installed AD config without host or Root Base DN, a SCIM config without base URL, or a failed connector call. It is an error for that system, never "no account": no drift is raised or closed for it, nothing is auto-corrected there, and the reason (the missing setting named) is in the detection result's `systemErrors` and once per batch in the batch result's `errors` (`ad: AD connector config is incomplete (empty: host): ...`). Read as "no account", it raised `MISSING_USER` for every user, auto-corrected for the active ones.
* **Open drifts per identity** (`GET /reconciliation/drifts/open-counts?userIds=<_id>,<_id>`, at most 100 ids, `DriftService.countOpenByUser`): `{ success, counts: { <_id>: <open drifts> } }`, an identity without an open drift left out. The Identity hub's Sync column reads it, one request per page (`frontend/src/api/reconciliation-api.ts` `fetchOpenDriftCounts`, 100 ids per request).

* **Listing** (`GET /reconciliation/drifts`, `reconciliation.controller.ts` `DriftQuerySchema` → `DriftService.getDrifts`): filters `severity`, `type`, `targetSystem`, `status`, `userId`, `search` (name or email), newest first, `page` and `limit` (at most 100). The identity page reads one identity's open drifts with `userId=<_id>&status=open` (`frontend/src/api/reconciliation-api.ts` `fetchDrifts`), so a corrected or ignored drift leaves its Drift tab, badge, Profile indicators and identity map.
* **Correct one** (`POST /reconciliation/drifts/:id/correct`, `DriftService.autoCorrect`): `DriftCorrectionService.executeCorrection` finds the identity by the drift's `userId` (an older record's email as the fallback) and makes the change in the target (Entra ID; a `STATUS_MISMATCH` in Entra ID, AD or SCIM, as above; an orphan drift only changes status, its workflow does the rest). When it cannot, the answer is `400 Correction failed: <reason>` and the drift stays open; a missing identity is `User not found: identity <userId>`. Only an open drift, or a quarantined orphan drift (its cleanup is stopped first, `ORPHAN_DETECTION.md`), can be corrected: a corrected or ignored drift is `409 Drift <id> is <status>: only an open drift, or a quarantined orphan drift, can be corrected`, and nothing is written to the target (its stored value may be stale) or relabelled.
* **Bulk correct** (`POST /reconciliation/drifts/bulk-correct`, `DriftService.bulkAutoCorrect`): each open drift is corrected as above. The answer is `{ success, corrected, failed, failures: [{ driftId, error }] }`: every requested drift that was not corrected is in `failures`, with `Drift <id> not found`, `Drift <id> is <status>, not open`, or the same reason single correct gives. `success` is `false` when none was corrected. Each failure is logged with that reason, emails masked.
* **Ignore one** (`POST /reconciliation/drifts/:id/ignore`, `DriftService.ignoreDrift`): an open drift, or a quarantined orphan drift (still awaiting a decision; its cleanup is stopped first, `ORPHAN_DETECTION.md`), becomes `ignored`. A corrected or ignored drift is `409 Drift <id> is <status>: only an open drift, or a quarantined orphan drift, can be ignored` and stays as it is: relabelled, a corrected drift that recurs with the same values would never be recorded again. **Bulk ignore** (`POST /reconciliation/drifts/bulk-ignore`, `DriftService.bulkIgnore`) ignores the requested drifts that are open and answers how many.

## 🛠️ Implementation Checklist

### Backend

* [ ] **State Store:** MongoDB `linkedAccounts` inside the Identity document.
* [ ] **Diff Algorithm:** Logic to compare `linkedAccounts['ad'].groups` vs `policy.calculatedGroups`. Drift detection is built for missing accounts, profile fields and status (`detectUserDrift` → `DriftService.recordDetection`); groups are not compared (`reconciliation.activities.ts` only logs the group count).
* [ ] **Circuit Breaker:** Middleware that throws an error if deletions > 5%.
* [x] **Entitlement Catalog:** MongoDB `entitlement_catalog` with `origin` (POLICY | EXTERNAL) and `governanceLevel` (STRICT | OPEN). Discovery absorbs as EXTERNAL; policy save registers assign_group (Entra) as POLICY.
* [x] **Group Sync (Hybrid):** When removing users from groups, only remove from groups where catalog `origin === 'POLICY'`. EXTERNAL groups are left unchanged.

### Frontend (Drift Dashboard)

* [ ] **Drift Feed:** "15 drifts detected in the last 24h." The Reconciliation page shows open-drift counts and the drift list, newest first; no count per last 24 hours.
* [x] **Resolve Button:** Admin clicks "Accept Change" (Update Policy) or "Revert" (Fix Target). Built as **Auto-Fix** (fix the target) and **Ignore**, per drift and in bulk (`frontend/src/features/reconciliation/DriftList.tsx`); there is no Update Policy action.
* [ ] **Health Score:** "Your Identity Health is 92%."
* [x] **Group List / Identity Hub:** Add **Source** column (🛡️ Policy vs ☁️ External) and **Governance Mode** (Strict vs Open). Use `GET /api/v1/entitlement-catalog?system=entra-id` (or connector-entitlements with origin) to drive the UI.

