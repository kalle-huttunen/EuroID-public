# Intelligence Module — Architecture

> **Module:** `backend/src/modules/intelligence/`
> **Tasks:** F-12 (Rubber-Stamp Detection), F-13 (Peer Group Deviation), F-14 (Smart Recommendations)

## Purpose

Rule-based AI access intelligence that detects low-quality reviews, identifies access outliers via peer group modeling, and guides access requestors with peer-informed recommendations. Integrates as the 7th factor in EuroID's risk scoring engine.

---

## Algorithms

### 1. Rubber-Stamp Detection (F-12)

Scores reviewer quality per campaign using four binary signals:

```
qualityScore = 100
  - (approvalRate > 0.95 ? 30 : 0)
  - (avgDecisionTime < INTELLIGENCE_RUBBER_STAMP_THRESHOLD_MS ? 25 : 0)
  - (bulkApproveCount > 0 ? 20 : 0)
  - (noJustificationRate > 0.5 ? 25 : 0)
```

- **Decision time threshold**: `INTELLIGENCE_RUBBER_STAMP_THRESHOLD_MS` (default 30000, 30 s). Each score stores the threshold it was computed with as `decisionTimeThresholdSeconds`, which the Reviewer quality tab names; a score from before it was stored has none and used 30 s
- **Bulk approve**: `INTELLIGENCE_BULK_APPROVE_WINDOW_COUNT` (default 10) approvals within a 5-minute sliding window. Each score stores the rule it used as `bulkApproveWindowCount` and `bulkApproveWindowMinutes`, which the Reviewer quality tab names ("4 approvals within 5 min"); a score from before they were stored has neither and used 10 within 5 minutes
- **Flagged decisions**: approved + no justification + decision time < 15s
- **Trust levels**: HIGH (avg > 70), MEDIUM (avg > 40), LOW (avg <= 40)

Collection: `reviewer_quality_scores` (unique: `tenantId + reviewerId + campaignId`)

### 2. Peer Group Deviation (F-13)

Groups identities by `(departmentName, jobTitle)` and computes entitlement baselines:

1. Query all active identities, group by department + job title
2. Skip groups with fewer than `INTELLIGENCE_PEER_GROUP_MIN_SIZE` (default 3) members
3. Resolve the access each member holds (`HeldAccessService`): what the identity page calls Active. Group, license and role grants of the active policies (the SoD-free evaluation of the member's policy profile) on a target system where the member's account is `SYNCED` (`resolveStatus`), and the entitlements of the member's `ACTIVE` access requests (the member as beneficiary). The same definition as the access explorer resync. A member whose policy evaluation fails is left out; a group left with fewer than the minimum is not written
4. **Baseline** (`entitlementBaseline`): every entitlement a member holds, with its hold rate (share of members) and `grantedBy`: how the members holding it got it (`policy`, `request`, or both). An entitlement is named `system::nativeId`, as the request form's unusual-request check names a catalog entry: a request's system and the entitlement's native id (its name when it has none); a policy grant by the entitlement catalog entry of its target on that system, found by native id, else by name when exactly one entry with a native id has that name, with the entry's name (`entitlement-catalog/catalog-target-lookup.ts`, which the access graph keys a rule's grant by too). One a rule names by display name and others request is then one entitlement, held both ways. A target the catalog does not know (or names more than once) keeps `target::targetId` and its target id as the name. Stored groups take the new names at the next build
5. **Outliers**: members with entitlements held by < 20% of peers
6. **Missing baseline**: entitlements held by >= 80% of peers that a member lacks
7. **Deviation score**: `min(100, uniqueCount * 10 + missingCount * 5)`
8. **Removal**: after writing the groups, the build removes the tenant's groups it did not write (below the minimum size, or no identity has their attributes any more), so a lookup by member finds only current groups. If a build stops part way, groups it did not reach stay; the lookup takes the latest computed one

Collection: `peer_groups` (unique: `tenantId + groupKey`)

### 3. Smart Recommendations (F-14)

Peer-informed access request guidance:

- **Recommendations**: entitlements held by >= 70% of peers that this identity does not have, sorted by hold rate descending (top `INTELLIGENCE_RECOMMENDATION_MAX`, 10). What the identity page lists for the identity as Active or Pending counts as had (access on its way is not recommended). Not filtered by the catalog: each recommendation carries `grantedBy` (how the peers hold it), `requestable` (true when a catalog entry matches and is requestable; false with no entry or a not requestable one) and the entry's `riskLevel`
- **Unusual request warning**: against the group's baseline (held access, requests included): CRITICAL if no peer or < 5% of peers hold it, WARNING if < 20%

### 4. Risk Scoring Integration (7th Factor)

`getPeerDeviationScore(tenantId, identityId)` returns 0-100 for the risk scoring engine:
- Returns 0 if identity has no peer group
- Directly consumed by `RiskScoringService` as `peer_deviation` factor (weight 12%)

Rebalanced default weights (sum = 100):
| Factor | Weight |
|--------|--------|
| entitlement | 8 |
| highRisk | 22 |
| sod | 22 |
| anomaly | 13 |
| admin | 13 |
| dormant | 10 |
| peer_deviation | 12 |

---

## API Endpoints

| Method | Path | Role | Description |
|--------|------|------|-------------|
| GET | `/intelligence/reviewer-quality` | super-admin | All reviewer quality scores |
| GET | `/intelligence/reviewer-quality/:campaignId` | super-admin | Per-campaign scores |
| GET | `/intelligence/peer-groups` | policy-admin | List peer groups |
| GET | `/intelligence/peer-groups/:groupKey/outliers` | policy-admin | Outliers in group |
| GET | `/intelligence/recommendations/:identityId` | operator | Recommended entitlements |
| POST | `/intelligence/unusual-check` | operator | Check if request is unusual |

### Where the UI shows them

| Route | Page | Shown to |
|-------|------|----------|
| `GET /intelligence/reviewer-quality`, `GET /intelligence/reviewer-quality/:campaignId` | Access reviews > tab Reviewer quality (`frontend/src/features/intelligence/ReviewerQualityTab.tsx`); a completed campaign's modal opens it on that campaign | super-admin |
| `GET /intelligence/peer-groups`, `GET /intelligence/peer-groups/:groupKey/outliers` | Intelligence > Peer groups, `/intelligence/peer-groups` (`PeerGroupsPage.tsx`, the group in `PeerGroupModal.tsx`) | policy-admin |
| `GET /intelligence/recommendations/:identityId` | Identity page > tab Recommendations (`IdentityRecommendationsTab.tsx`) | operator |
| `POST /intelligence/unusual-check` | The access request form, for the signed-in user's identity (`frontend/src/features/access-requests/PeerCheckWarnings.tsx`) | operator |

The views only read: none grants or revokes access, and none can start the batch. User flow: `docs/USER_FLOWS.md` Flow 25. Nothing computes a reviewer's trust level across campaigns.

---

## Nightly Batch Workflow

`intelligence-batch.workflow.ts` runs at 4 AM (after risk scoring at 2 AM):

1. `runPeerGroupBuild`: rebuilds peer groups for all tenants (and removes the groups no longer formed); emits `intelligence.peer_group_updated` per tenant
2. `runReviewerQualityScoring`: scores unscored completed campaigns; emits `intelligence.reviewer_quality_scored` per tenant that had a campaign scored: `{ tenantId, campaignId, campaignIds, reviewersScoredCount }`, the campaigns scored in that tenant (`campaignId` is the first of them, kept for subscribers that read it) and the distinct reviewers scored in them

Activities: `intelligence.activities.ts` / `intelligence-activities.module.ts`

---

## Schemas

| Schema | Collection | Key Index |
|--------|-----------|-----------|
| `ReviewerQualityScore` | `reviewer_quality_scores` | `tenantId + reviewerId + campaignId` (unique) |
| `PeerGroup` | `peer_groups` | `tenantId + groupKey` (unique) |

---

## Dependencies

- `IdentityModule`: the policy profile of an identity (`buildProfileWithContractsForPolicy`) and `resolveStatus`
- `PolicyModule`: evaluate entitlements per identity
- Cross-module schemas: `ReviewItem`, `ReviewCampaign`, `Identity`, `EntitlementCatalog`, `AccessRequest`
- Consumed by: `RiskScoringModule` (7th factor)

---

## Configuration

| Env Var | Default | Purpose |
|---------|---------|---------|
| `INTELLIGENCE_RUBBER_STAMP_THRESHOLD_MS` | 30000 | Average decision time under which a reviewer's score loses 25 points |
| `INTELLIGENCE_BULK_APPROVE_WINDOW_COUNT` | 10 | Approvals within 5 minutes that cost a reviewer's score 20 points |
| `INTELLIGENCE_PEER_GROUP_MIN_SIZE` | 3 | Min group size for peer analysis |
| `INTELLIGENCE_RECOMMENDATION_MAX` | 10 | Max recommendations returned |
| `INTELLIGENCE_BATCH_CRON` | `0 4 * * *` | Nightly batch schedule |
| `RISK_WEIGHT_PEER_DEVIATION` | 12 | Peer deviation weight in risk scoring |
