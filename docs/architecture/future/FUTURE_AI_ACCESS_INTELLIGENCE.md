# FUTURE: AI-Powered Access Intelligence

> **Status:** Phase 1 COMPLETE (2026-02-22). Phase 2 (ML Enhancement) not yet implemented.
>
> **Implemented:** Rubber-stamp detection (F-12), peer group deviation scoring (F-13), smart access recommendations (F-14), nightly batch workflow, risk scoring 7th factor integration. See `backend/src/modules/intelligence/docs/ARCHITECTURE.md`.

## Overview

EuroID's current `PolicySuggestionService` uses rule-based heuristics to detect birthright patterns and coverage gaps. An AI Access Intelligence layer would add ML-based analysis for **rubber-stamp detection** in access reviews, **peer group modeling** for anomaly detection, **predictive risk scoring**, and **smart access recommendations** — using the rich data EuroID already collects.

---

## Problem Statement

- Access reviews may suffer from "rubber-stamping" — reviewers approving everything without scrutiny
- Anomaly detection uses static rules (time-based, peer deviation); no learning from historical patterns
- Access request recommendations are absent — users browse the full catalog with no guidance
- Risk scoring uses fixed weights; no adaptation to tenant-specific risk patterns
- Role mining detects birthrights but doesn't discover implicit roles from actual access patterns

---

## Intelligence Modules

### 1. Rubber-Stamp Detection

Analyze access review decisions to identify reviewers who approve without adequate scrutiny.

**Signals:**
- Approval rate > 95% across campaigns
- Average decision time < 30 seconds
- No justification text on approvals
- Bulk approve patterns (10+ decisions in < 5 minutes)
- Reviewer approves entitlements outside their domain knowledge

**Output:**
- Reviewer quality score (0-100) per campaign
- Flagged decisions for re-review
- Reviewer trust degradation: low-quality reviewers get escalation overrides
- Dashboard: campaign completion quality metrics

```typescript
// Collection: reviewer_quality_scores
{
  tenantId: string,
  reviewerId: string,
  campaignId: string,
  qualityScore: number,              // 0-100
  signals: {
    approvalRate: number,            // 0-1
    avgDecisionTimeSeconds: number,
    bulkApproveCount: number,
    noJustificationRate: number,
  },
  flaggedDecisions: string[],        // ReviewItem IDs
  calculatedAt: Date,
}
```

### 2. Peer Group Modeling

Build dynamic peer groups from organizational attributes and detect outlier access patterns.

**Approach:**
- Group identities by `(department, jobTitle, location)` tuples
- For each peer group, compute the entitlement baseline (entitlements held by > 60% of group)
- Flag identities with entitlements unique to them within their peer group
- Flag identities missing entitlements that > 80% of peers have (coverage gap)

**Output:**
- Per-identity peer deviation score (factor in risk scoring)
- "You have access that none of your peers have" alerts
- "Most people in your role also have X" recommendations during access requests
- Feed into `PolicySuggestionService` as enhanced birthright candidates

```typescript
// Collection: peer_groups
{
  tenantId: string,
  groupKey: string,                  // Hash of (department, jobTitle, location)
  attributes: {
    department: string,
    jobTitle: string,
    location?: string,
  },
  memberCount: number,
  entitlementBaseline: [{
    entitlementId: string,
    holdRate: number,                // 0-1 (fraction of group that has it)
  }],
  outliers: [{
    identityId: string,
    uniqueEntitlements: string[],    // Entitlements only this person has
    missingBaseline: string[],       // Baseline entitlements they lack
    deviationScore: number,          // 0-100
  }],
  calculatedAt: Date,
}
```

### 3. Predictive Risk

Enhance risk scoring with temporal patterns and trajectory analysis.

**Signals beyond current 7 factors:**
- Rate of entitlement accumulation (increasing = higher risk)
- Access review history (repeatedly flagged = higher risk)
- Anomaly recurrence (same anomaly type multiple times)
- Credential state (expired password, no MFA = higher risk)
- Peer deviation trend (diverging from group over time)

**Output:**
- Predictive risk indicator: "risk likely to increase" vs "stabilizing"
- Automated risk tier assignment for governance workflows
- Risk trajectory chart in dashboard (30-day rolling)

### 4. Smart Access Recommendations

During access request submission, recommend entitlements based on peer group and role context.

**Approach:**
- When user opens access request form, fetch their peer group baseline
- Show "Recommended for your role" section with entitlements held by > 70% of peers but not by requester
- Sort requestable catalog by relevance (peer hold rate × governance level)
- Show "Unusual request" warning if entitlement is held by < 5% of peer group

---

## Implementation Strategy

### Phase 1: Rule-Based Foundation (No ML Required) — ✅ COMPLETE (2026-02-22)
- ✅ Rubber-stamp detection via aggregation queries on review decisions (`intelligence.service.ts`)
- ✅ Peer group modeling via nightly batch computation (`intelligence-batch.workflow.ts`)
- ✅ Smart recommendations via peer group entitlement baseline lookup
- ✅ Peer deviation integrated as 7th risk scoring factor (weight 12%)
- ✅ 6 REST API endpoints in `intelligence.controller.ts`

### Phase 2: ML Enhancement (Optional)
- Train anomaly detection model on historical access patterns
- Clustering for automatic peer group discovery (beyond static attributes)
- Time-series analysis for predictive risk trajectories
- Requires: ML runtime (Python sidecar or cloud ML service)

---

## Temporal Workflow

```
Temporal CronWorkflow (nightly, after risk scoring)
        │
        ▼
  1. Build/refresh peer groups
     (group by department + jobTitle + location)
        │
        ▼
  2. Compute entitlement baselines per group
     (count entitlement hold rates)
        │
        ▼
  3. Detect outliers per group
     (unique entitlements, missing baseline)
        │
        ▼
  4. Score reviewer quality
     (only for campaigns completed in last 30 days)
        │
        ▼
  5. Update risk score with peer deviation factor
     (integrate with existing RiskScoringService)
        │
        ▼
  6. Emit events: PEER_GROUP_UPDATED, REVIEWER_QUALITY_SCORED
```

---

## API Endpoints (Proposed)

| Method | Path | Role | Description |
|--------|------|------|-------------|
| `GET` | `/api/v1/intelligence/peer-groups` | policy-admin | List peer groups with stats |
| `GET` | `/api/v1/intelligence/peer-groups/:groupKey/outliers` | policy-admin | Outlier identities in group |
| `GET` | `/api/v1/intelligence/recommendations/:identityId` | operator | Recommended entitlements for identity |
| `GET` | `/api/v1/intelligence/reviewer-quality` | super-admin | Reviewer quality scores |
| `GET` | `/api/v1/intelligence/reviewer-quality/:campaignId` | super-admin | Per-campaign reviewer quality |
| `POST` | `/api/v1/intelligence/unusual-check` | operator | Whether a requested entitlement is unusual for the identity's peer group |

---

## Integration Points

| Existing System | Integration |
|----------------|-------------|
| `RiskScoringService` | Add peer deviation as 7th risk factor |
| `PolicySuggestionService` | Feed peer group baselines as birthright candidates |
| `AnomalyService` | Peer deviation signals as anomaly source |
| `AccessRequestPortal` | "Recommended" section in entitlement browser |
| `AccessReviewService` | Reviewer quality scores on campaign dashboards |

---

## Implementation Checklist

**Phase 1 — Rule-Based Foundation**
- [x] Create `reviewer_quality_scores` schema and reviewer quality scoring (rubber-stamp detection via aggregation queries), built in `IntelligenceService` (no `ReviewerQualityService`)
- [x] Create `peer_groups` schema and the peer group build (nightly batch), built in `IntelligenceService` (no `PeerGroupService`); it groups by department + jobTitle, location is not used
- [x] Implement entitlement baseline computation and outlier detection per peer group
- [x] Implement smart recommendations endpoint (`GET /intelligence/recommendations/:identityId`)

**Phase 2 — Integration & API**
- [x] Add peer deviation as additional risk factor in `RiskScoringService`
- [ ] Feed peer group baselines into `PolicySuggestionService` as birthright candidates
- [x] Create `intelligence` controller with proposed API endpoints (peer-groups, outliers, reviewer-quality)
- [x] Create nightly Temporal CronWorkflow (peer groups, reviewer quality, risk score integration): `intelligence-batch.workflow.ts` builds peer groups and scores reviewers; the risk scoring run reads the peer deviation
- [x] Add unit and integration tests for all services
- [x] Update API_CHANGELOG.md and backend README inventory

---

## Related Docs

| Doc | Relevance |
|-----|-----------|
| `../../../backend/src/modules/risk-scoring/docs/ARCHITECTURE.md` | Peer deviation integrates as additional risk factor |
| `../../../backend/src/modules/access-requests/docs/ARCHITECTURE.md` | Smart recommendations shown during request |
| `../../../backend/src/modules/policy/docs/ARCHITECTURE.md` | Peer groups feed birthright policy suggestions |
