# EuroID — Test Scenario: Dual-Source HR with Admin Provisioning

> **Purpose:** Concrete test data for validating end-to-end flows described in [USER_FLOWS.md](USER_FLOWS.md).
> This file contains scenario-specific numbers, names, and expected outcomes. The generic flows in USER_FLOWS.md work with any data set.

---

## Test Scenario Overview

**Goal:** Admin configures EuroID from scratch — login, set up connectors (2 inputs, 1 output: File Outbound for demo), configure roles/policies (Tietohallinto Admin + Engineering Access), run impact simulation, and deploy.

**Manual-first flow:** All ingestion and discovery is manual — no automatic sync. Test via simulation before live deployment.

---

## Test Data Numbers

| Location | Count | Notes |
|----------|-------|-------|
| **Input 1** (CSV HR) | 20 persons | First HR source |
| **Input 2** (JSON API HR) | 35 persons | Second HR source |
| **Total input records** | 55 | 20 + 35 |
| **Unique identities** (after correlation) | 50 | 5 persons appear in both sources → merged |
| **Output 3** (File Outbound) | 50 persons | Provisioning commands written to JSONL (demo). In production: Entra ID + Active Directory |
| **Tietohallinto dept** | 5 persons | Admin accounts: Entra ID roles + groups, AD groups |
| **Engineering dept** | ~10 persons | Developers group in Entra ID |
| **Admin accounts (production)** | 5 linked accounts | Created via PAM when using real Entra/AD connectors |

---

## Correlation Scenarios

10 of the 50 identities exercise varying matching scenarios:

| Scenario | Behavior |
|----------|----------|
| Exact match | Auto-link when `firstName+lastName` matches target |
| Fuzzy name match | Flag for review (e.g. "Robert" vs "Bob") |
| Ambiguous (1:many) | Multiple candidates → never auto-link, flag for review |
| Uncorrelated | Manual link in Uncorrelated Queue |
| Conflict resolution | Merge/Split/Dismiss on the identity page (`/identities/:id`, Profile tab) |

---

## Test Policies

| Priority | Policy Name | Condition | Actions | Matched Users |
|----------|-------------|-----------|---------|---------------|
| P1 | Tietohallinto Admin Access | `departmentName == "Tietohallinto"` | 2 Entra roles + 1 Entra group + 1 AD group | 5 (Timo Aalto, Riikka Tuominen, Hanna Karjalainen, Pekka Jokinen, Tiina Ahonen) |
| P2 | Engineering Access | `departmentName == "Engineering"` | 1 Entra group (Developers) | ~10 |

**Role Bundle:** "Tietohallinto Admin" — `assign_role User Administrator` + `assign_role Helpdesk Administrator` + `assign_group SG-IT-Admins` (Entra) + `assign_group CN=IT-Admins` (AD)

---

## Expected Outcomes

### Impact Simulation

- Total users analyzed: 50
- Tietohallinto admin operations: 5 users × 4 actions = 20 operations
- Engineering group assignments: ~10 users × 1 action = ~10 operations
- No policy match: ~35 users (no policy-driven provisioning)
- Overall Risk: **MEDIUM** (admin role assignments + 30% of users affected)
- Circuit Breaker: Not triggered

### Post-Deploy State

The two Sync Now runs before Deploy (Flow 3) record the 50 new identities as joiners: nothing is provisioned yet, the ingest results show `joiners.waiting` 20 and 30 (the 5 people JSON API HR also delivers were minted by the CSV sync). Deploy starts no workflow. The first full sync of each source after Deploy picks its joiners up: with 50 active identities a sync may onboard max(2, min(10, 5% of 50)) = 2 people on its own, so each source's 20 or 30 joiners wait as one batch on Governance > Joiners, movers and leavers, tab HR joiners. Approving both starts one onboarding run per person (50), the approver as actor; each identity's timeline says "Onboarding started by HR sync". Flow 17 in [USER_FLOWS.md](USER_FLOWS.md#flow-17-hr-driven-joiner).

```
Total: 55 input records → 50 unique identities (50 joiners, onboarded after Deploy and approval)
  └── 5 Tietohallinto staff get: Entra roles (User Admin + Helpdesk Admin)
      + Entra group (SG-IT-Admins) + AD group (CN=IT-Admins)
  └── ~10 Engineering staff get: Entra group (Developers)
  └── ~35 remaining: No policy-driven provisioning

Admin Policy Flow (production with real connectors):
  └── 5 Tietohallinto staff matched by P1
  └── 5 linked admin accounts created (adm-{name}@example.com)
  └── Each admin account gets: User Administrator + Helpdesk Administrator roles
      + SG-IT-Admins (Entra) + CN=IT-Admins (AD)
```

### Database State After Full Flow

| Collection | Documents | Content |
|-----------|-----------|---------|
| `admin_users` | 1 | Super-admin account (hashed password) |
| `blueprints` | 1 | Canvas state: 4 nodes (2 sources + Brain + File Outbound), edges, configs |
| `connector_configs` | 3 | CSV HR, JSON API HR, File Outbound (demo target) |
| `identities` | 50 | Onion Model documents with linked accounts + provisioning state |
| `identities` (admin accounts) | 5 | Linked admin accounts: identity documents with `parentIdentityId` and `adminTier`, listed in the parent's `linkedAdminAccounts` (Tietohallinto, in production with real connectors) |
| `policies` | 2 | "Tietohallinto Admin Access" (P1, High) + "Engineering Access" (P2, Low), both ACTIVE |
| `role_bundles` | 1 | "Tietohallinto Admin" (2 roles + 2 groups) |
| `audit_events` | ~100+ | All actions logged: installs, configs, policy creates, deploy, provisions |
| `drift_records` | 0 | None yet (fresh deploy, reconciliation hasn't run) |

---

## HR Leaver Test Case

Flow 10 in [USER_FLOWS.md](USER_FLOWS.md#flow-10-hr-driven-leaver), with the default leaver policy (3 misses; at most 10 leavers or 5% of active identities per sync). Automated as `backend/test/workflows/hr-leaver.workflow.e2e-spec.ts` (`TEMPORAL_E2E=1`).

| Step | CSV HR feed (`Status`, `End Date` columns) | Expected |
|------|---------|----------|
| 1 | 60 active people, one with `Status: Terminated`, one with an `End Date` two days ago | 62 identities; 2 offboarding workflows (`leaver:terminated`, `leaver:end-date`); allowance is 3 (5% of 62) |
| 2 | Same feed without 12 of the active people, synced three times | After the third sync: no offboarding starts, one pending batch of 12 (`missing-from-source`) on Governance > Joiners, movers and leavers, Pending approval tab |
| 3 | Approve the batch | 12 offboarding workflows start (`leaver:missing-from-source`) |
| 4 | Sync the same feed again | No new leaver, no workflow started twice |

With the 20-person CSV of the main scenario, 5% of 20 is one leaver, so a sync with two or more leavers waits for approval unless the policy is raised.

---

## HR Mover Test Case

Flow 12 (12.5 to 12.8) in [USER_FLOWS.md](USER_FLOWS.md#flow-12-mover-access-change), with the default mass-mover policy (at most 10 movers or 5% of active identities per sync, at least 2). Automated as `backend/test/workflows/hr-mover.workflow.e2e-spec.ts` (`TEMPORAL_E2E=1`). The identities must be provisioned (a SYNCED target, which records their access baseline) before the move.

| Step | CSV HR feed (`Department`, `Status` columns) | Expected |
|------|---------|----------|
| 1 | 41 active people in Sales, provisioned | No mover run (access matches the baseline) |
| 2 | Two people move to Engineering; a third gets `Status: Terminated` and a new department | 2 mover workflows (trigger `hr-sync`, before `departmentName: Sales`), timeline "Access change started by HR sync"; the terminated person is offboarded, not moved |
| 3 | Six more people move to Finance | No mover starts; one pending batch of 6 on Governance > Joiners, movers and leavers, HR movers tab (allowance 2: 5% of 41) |
| 4 | Approve the batch | 6 mover workflows start, the admin as actor |
| 5 | Sync the same feed again | No mover starts twice |

With the 20-person CSV of the main scenario, the floor of 2 lets a sync move two people without approval.

---

## HR Joiner Test Case

Flow 17 in [USER_FLOWS.md](USER_FLOWS.md#flow-17-hr-driven-joiner), with the default mass-joiner policy (at most 10 joiners or 5% of active identities per sync, at least 2). Automated as stages 1 and 5 of `backend/test/workflows/jml-end-to-end.workflow.e2e-spec.ts` (`TEMPORAL_E2E=1`, File outbound target).

| Step | CSV HR feed and admin action | Expected |
|------|---------|----------|
| 1 | Three new people, pipeline not deployed | 3 identities, no workflow; `joiners: { detected: 3, waiting: 3, pipelineStatus: 'DRAFT' }` |
| 2 | Impact analysis, Deploy | No workflow |
| 3 | Same feed again | No onboarding starts; one pending batch of 3 on the HR joiners tab (allowance 2 for 3 active identities) |
| 4 | Approve the batch | 3 onboarding workflows (memo `reason: joiner:hr-sync:csv-hr`), one File outbound line each; timeline "Onboarding started by HR sync" with the admin as actor |
| 5 | Same feed again | No workflow |
| 6 | Pause the pipeline; a fourth person joins | No workflow; `joiners: { detected: 1, waiting: 1, pipelineStatus: 'PAUSED' }` |
| 7 | Resume; same feed again | 1 onboarding workflow, started by the sync (actor `system:hr-sync`) |
| 8 | Same feed again | No workflow |

A row with `Status: Terminated` among the new people is never onboarded, and a `Start Date` after today waits until the first sync on or after that day (`backend/src/modules/joiners/joiner-detection.integration.spec.ts`).

---

## HETU Correlation Test Case

> **Scenario:** A single person (Matti Virtanen) has 2 employment contracts across 2 HR source systems — both share the same HETU (Finnish national ID: `131085-999X`). The Brain must correlate them into **one identity** with a primary + secondary contract.

### How Matching Works

An HR row first looks for an identity by its source key (`sources.sourceName` + `sources.externalId`). Only when none has it do the correlation rules run, in order, first match wins (`HrIngestionService` → `IdentityService.saveOrUpdate()` → `IdentityCorrelationService.ensureIdentityFromUser()`, `correlation/correlation-rule.engine.ts`). The rules come from the Brain's "Identity Correlation" tab, saved in the blueprint (`connectorConfigs['euroid-core'].correlationConfig`); with none saved the only rule is `email` (`correlation-config.service.ts`). If Matti has:
- **Workday**: `matti.virtanen@company.fi` (permanent contract)
- **HR API**: `matti.virtanen.consultant@company.fi` (consultant contract)

the default `email` rule creates **2 separate identities**. A `hashedNationalId` rule links them.

### HETU Correlation Flow

| Step | What Happens | Component | Detail |
|------|-------------|-----------|--------|
| 1 | Admin adds the rule "Hashed National ID" with source field `hetu` and moves it first | Design studio, Brain → "Identity Correlation" tab (`IdentityCorrelationTab.tsx`) | Save refuses the rule without a source field (the API takes one without and reads `hetu`), and refuses the rule while the server has no `CORRELATION_HMAC_SECRET` (16+ characters): without it nothing is hashed and national IDs are dropped |
| 2 | Maps HETU in each HR source | CSV HR `columnMap`, JSON API HR `fieldMap` | Workday: `"HETU": "customAttributes.hetu"`; HR API: `"personalId": "customAttributes.hetu"`. The rule reads `hetu` from the record or its `customAttributes` |
| 3 | Workday ingestion | `ensureIdentityFromUser()` | No source key or rule matches: **Creates new identity** with `profile.correlationId` = HMAC-SHA256 of the HETU without hyphens and spaces under the tenant's key (`CorrelationHashService`, unique per tenant). The HETU itself is removed from the record first: it is in neither `sources[].rawData` nor `profile.customAttributes` (`national-id.ts`) |
| 4 | HR API ingestion | Same path | No source key match; the rule finds the identity by `profile.correlationId` (confidence 0.95). **Adds the HR API record to `sources[]`**, event `identity.correlated` |
| 5 | Primary resolution | `reconciliation.service.ts` | The primary HR source (`resolvePrimaryHrSource`: contract type, connector `contractTag`, ingest priority, then `sourcePriorityOrder`) alone writes contract-critical fields; for a field without a master its value wins and the secondary source fills gaps |
| 6 | Provisioning | Policy Engine → Connectors | **One Entra ID account** created (not two) |

### Edge Case: 5 People, Same HETU (Data Error)

A national ID match has confidence 0.95. The name check (`demographicSanityCheck`) applies only to matches below 0.9, so with the default `confidenceThreshold` (0.7) a HETU match links without review:

| Step | What Happens |
|------|-------------|
| 1 | First person ingested → new identity created |
| 2 | Persons 2-5: HETU match → linked to the first identity, no review, even when name and email differ |
| 3 | A record from a source the identity already has replaces that source's entry in `sources[]` (one entry per source) |

Review applies to weaker matches: a match below `confidenceThreshold`, or a match below 0.9 whose first and last names both differ when `conflictAction` is `review`, flags the matched identity (`metadata.correlationConflict`, event `identity.correlation_conflict`). An operator resolves it with `POST /api/v1/identity/:id/resolve-conflict` (`merge`, `split` or `dismiss`).
