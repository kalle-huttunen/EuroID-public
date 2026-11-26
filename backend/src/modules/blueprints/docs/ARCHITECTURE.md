# Simulation & Impact Analysis - The 2026 Standard

> **Module:** Blueprints (Pillar 6 — Safety)
> **Cross-cutting:** [Data Flows](../../../../../docs/architecture/core/DATAFLOWS.md) | [Policy Engine](../../policy/docs/ARCHITECTURE.md)

## 🎯 The Core Problem

**"Automation is a force multiplier for mistakes."**

* **Scenario:** An admin updates a policy: "Remove `All-Staff` group from contractors."
* **The Mistake:** They forgot that the CEO is tagged as a "Contractor" in the HR system due to a clerical error.
* **The Result:** The CEO loses access to email and Slack instantly.
* **The Solution:** **Deterministic Simulation.** We must see the future state *before* we commit the change.

---

## ⚠️ Simulation Landmines (Critical Safety Protocol)

A simulation that gives false confidence is worse than no simulation at all.

### 🧨 Landmine 1: The "Stale Data" Mirage

* **The Trap:** The Simulation runs against a cached "Entitlement Catalog" that is 3 days old. The real execution runs against live data.
* **The Explosion:** The Simulation says "No Impact". You click deploy. The real run revokes access for 50 employees hired yesterday (who weren't in the cache).
* **The 2026 Fix: Versioned Snapshots.**
  * Display the "Data Freshness" timestamp prominently in the Simulation UI.
  * **Rule:** If data is > 24 hours old, force a "Discovery Sync" before allowing the simulation to complete.

### 🧨 Landmine 2: The "Sampling Bias" Trap

* **The Trap:** You test the policy on "5 Random Users". They all look fine. You deploy.
* **The Explosion:** The policy breaks for the CEO, Service Accounts, and Admin users because they weren't in the random sample.
* **PLANNED Fix: Mandatory Edge Case Injection.**
  * > **PLANNED**: Canary list injection is not yet implemented. Currently simulation evaluates every Hub identity (paged through `findAllPaginated()`).
  * Target design: Every simulation automatically includes a "Canary List" (CEO, 2 Admins, 1 Service Account, 1 edge case).

### 🧨 Landmine 3: The "Memory Bomb"

* **The Trap:** An admin clicks "Simulate All" for 100,000 users. The backend tries to load all User DTOs into memory.
* **The Explosion:** Node.js runs out of heap memory (OOM). The entire Identity Hub crashes.
* **Current Implementation:** Simulation is **synchronous**: `PolicyEngineService.simulate()` streams the Hub's users in pages (`identityQuery.findAllPaginated()`, `POLICY_PAGE_SIZE`, default 500) and evaluates them within one request. Results are capped at 20 matched users in the response.
  * > **ROADMAP:** Job-based streaming architecture — process users in chunks of 100, write to temp MongoDB collection, UI polls for progress.

---

## 🏗️ Architecture: The "Shadow" Engine

We don't need a separate "Simulation Engine." We reuse the **Policy Engine** but divert its output.

```mermaid
graph TD
    Admin[Admin updates Policy] -->|1. Request Simulation| SimAPI[Simulation API]
    
    subgraph "The Sandbox"
    SimAPI -->|2. Snapshot| Users[Fetch Sample + Canary Users]
    Users -->|3. Run| Engine{Policy Engine (Dry Run)}
    
    Engine -->|4. Generate| Intent[Provisioning Intent]
    end
    
    Intent -->|5. Compare| Diff{Diff Engine}
    State[Current State] -->|Compare| Diff
    
    Diff -->|6. Report| Report[Impact Analysis Report]
```

---

## ⚙️ The Simulation Logic

### 1. The "Dry Run" Flag

> **PLANNED**: `PolicyEngineService` has no `generateProvisioningIntent` method and no `dryRun` flag; this section is
> the target design. Today `POST /policy/simulate` calls `PolicyEngineService.simulate()` and
> `POST /blueprints/impact-analysis` calls `PolicyEngineService.evaluate()` per user (`ImpactAnalysisService`). The
> only `dryRun` in the module belongs to `POST /blueprints/impact-analysis` (default `true`): it makes the Entra UPN
> metadata synthetic, without live Entra calls (`impact-entra-metadata.service.ts`).

The Policy Engine's `generateProvisioningIntent` method accepts a flag:

```typescript
async generateProvisioningIntent(
  user: StandardUserDto, 
  dryRun: boolean = false
): Promise<ProvisioningIntent> { ... }
```

When `dryRun` is true, the engine **does not** fetch live data from connectors. It uses the cached **Entitlement Catalog** to resolve IDs (e.g., it assumes `Group 'Sales'` = `GUID-123`).

### 2. The Diff Engine

This is a pure function that compares **Current Reality** vs. **Proposed Intent**.

```typescript
// Input: Two JSON objects
// Output: A "Patch" list
const diff = calculateDiff(currentAccess, proposedIntent);

// Result Example:
[
  { 
    user: "alice@acme.com",
    system: "Entra ID",
    action: "REMOVE",
    target: "Group: All-Staff",
    risk: "CRITICAL" // Why? Because 'All-Staff' is flagged as a birthright group.
  },
  {
    user: "bob@acme.com",
    system: "Salesforce",
    action: "ADD",
    target: "Profile: Standard User",
    risk: "LOW"
  }
]
```

### 3. Simulation Modes

**Current implementation:** A single synchronous mode that evaluates ALL users in-memory. No sampling or background job.

> **PLANNED:**
> * **Quick Check (Sampling):** 5 random users + Canary List. Returns in < 1 second.
> * **Full Impact (Blast Radius):** All users via a background Temporal Workflow with progress polling.

---

## 🎨 UI Concept: The "Blast Radius" View

Before an admin clicks "Save Policy," they see this modal:

```
┌─────────────────────────────────────────────────────────────────┐
│  ⚠️ Impact Analysis: "Update Contractor Policy"                 │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  📉 Blast Radius                                                │
│  This change will affect 142 users.                             │
│                                                                 │
│  🔴 Revocations (High Risk)                                     │
│  • Removing "All-Staff" from 12 users                           │
│  • Removing "E3 License" from 1 user                            │
│                                                                 │
│  🟢 Additions (Low Risk)                                        │
│  • Adding "Vendor-Portal" to 130 users                          │
│                                                                 │
│  🔍 Drill Down                                                  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ User         | Action         | Resource      | Risk      │  │
│  ├──────────────┼────────────────┼───────────────┼───────────┤  │
│  │ J. Bezos (CEO) | 🔴 REMOVE      | Email Access  | CRITICAL  │  │
│  │ A. Contractor  | 🟢 ADD         | Wifi Access   | LOW       │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  [Download CSV]                     [Cancel] [Confirm Change]   │
└─────────────────────────────────────────────────────────────────┘
```

---

## 🛡️ Risk Scoring (The AI Guardrail)

The system assigns a **Risk Score** to every operation based on heuristics.

**Current implementation:** each delta's `riskLevel` comes from `computeRiskLevel()` (`impact-delta.util.ts`):

| Operation | Context | Risk Score | Reason |
| --- | --- | --- | --- |
| **CREATE** | Any | Low | Standard provisioning. |
| **UPDATE** | With reasons | Medium | Attribute change. |
| **REMOVE / DISABLE** | Standard user | **High** | Access revocation. |
| **REMOVE / DISABLE** | **VIP user** | **CRITICAL** | VIP Safety Net. |

> **PLANNED enhancements:** Cost impact scoring for licenses, mass modification anomaly detection (>500 users).

The overall risk of an analysis comes from `assessRisk()` (`impact-delta.util.ts`), over the share of users affected
(any delta other than `NO_CHANGE`) and the number of `REMOVE`/`DISABLE` deltas, against `RISK_THRESHOLDS`
(`impact-analysis.types.ts`): critical above 30% or 10 removals, high above 15% or 5, medium above 5% or any removal,
else low. `circuitBreakerTriggered` is set when the affected share exceeds `DEFAULT_RISK_THRESHOLD` (10%).

**The Circuit Breaker:**
If the Total Risk Score > Threshold, the "Confirm" button is disabled. The admin *must* request **Peer Review** (Two-Person Rule) to proceed.

> **PLANNED**: there is no peer review step. When `circuitBreakerTriggered` is set, the impact
> analysis modal shows an error banner ("Circuit breaker triggered ... Cannot proceed without override.",
> `features/blueprints/components/ImpactRiskBanner.tsx`). A critical last simulation makes the deploy readiness
> check "Impact Analysis" a warning with `acknowledgementRequired`: the Deploy modal disables Deploy until the deployer
> ticks the confirmation, and `POST /blueprints/deploy` answers 422 without `acknowledgeCriticalRisk: true`
> (`pipeline.service.ts`); `pipeline.deployed` then carries `acknowledgedRisk: 'critical'`. A simulation older than the
> last canvas save (`pipelineConfig.canvasSavedAt`, set by `saveBlueprint`) fails the check: Deploy needs an impact
> analysis of the canvas as saved.

**Concurrent saves:** the canvas has a revision (`canvasRevision`, counted by every `saveBlueprint`; a canvas saved
before revisions reads as 0). `GET /blueprints/latest` returns it as `revision`, the Design studio sends it back with
`POST /blueprints/save`, and the save answers the new one. A save whose `revision` is no longer the stored one answers
409 and changes nothing (the revision is part of the update's filter, so of two saves of one revision exactly one
goes through); the studio then tells the admin to reload. A save without `revision` (a client from before this
release) is still stored, unchecked, and its `CONFIG_CHANGED` audit entry says so (`revisionChecked: false`);
`revision` becomes required in the next release.

---

## 🔄 Data Flow: Running a Simulation

1. **Admin:** Modifies the "Sales Policy" in the UI Draft State.
2. **Frontend:** Sends `POST /api/v1/policy/simulate` with the draft policy (or `POST /api/v1/blueprints/impact-analysis` for blueprint-level analysis).
3. **Backend (Controller):**
   * Runs `PolicyEngineService.simulate(draftPolicy)`: streams the Hub's users in pages (`identityQuery.findAllPaginated()`) and evaluates each user synchronously.
   * Results capped at 20 matched users in response.
4. **Backend (Analysis):**
   * Calculates the "Net Change."
   * Applies Risk Scoring rules.
5. **Frontend:** Displays the "Blast Radius" visualization.

---

## 🚀 Future Roadmap

1. **Time-Travel Simulation:** "What if we had applied this policy *last month*? Would it have prevented the outage?"
2. **Cost Forecasting:** "Applying this policy will increase our Azure AD licensing bill by $4,500/month."
3. **Automatic Rollback:** If the real-world execution deviates from the simulation by > 5% (e.g., API errors), automatically halt the rollout.
