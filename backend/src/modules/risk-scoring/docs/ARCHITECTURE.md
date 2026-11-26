# Risk Scoring Architecture

> **Module:** Risk Scoring (Extended — supports Pillar 4 Eyes)
> **Cross-cutting:** [Temporal Workflows](../../../../../docs/architecture/infrastructure/TEMPORAL_WORKFLOWS.md)

## Overview

EuroID computes a **composite risk score (0-100)** for every identity, recalculated nightly via a Temporal CronWorkflow.
The score aggregates seven signals (entitlement count, entitlement criticality, SoD violations, anomaly history, admin tier, account dormancy and peer deviation) to enable risk-based governance decisions.

---

## Risk Score Model

```typescript
// Collection: identity_risk_scores
{
  tenantId: string,
  identityId: string,
  score: number,                    // 0-100

  factors: [{
    factor: string,                 // Factor identifier
    weight: number,                 // Percentage weight (sums to 100)
    rawValue: number,               // Raw metric value
    contribution: number,           // Weighted contribution to final score
  }],

  trend: "INCREASING" | "STABLE" | "DECREASING",
  history: [{ date: Date, score: number }],   // Last 30 data points

  calculatedAt: Date,
}
```

---

## Scoring Formula

Weights come from the environment (`infrastructure/config/risk-scoring.config.ts`); the defaults sum to 100.

| Factor | Weight (env var, default) | Input Source | Normalization |
|--------|--------|-------------|---------------|
| Entitlement count | `RISK_WEIGHT_ENTITLEMENT`, 8% | Identity provisioning state | `min(count / orgAverage * 50, 100)` |
| High-risk entitlements | `RISK_WEIGHT_HIGH_RISK`, 22% | EntitlementCatalog (`riskLevel: HIGH\|CRITICAL`) | `min(count * 25, 100)` |
| SoD violations | `RISK_WEIGHT_SOD`, 22% | `SodService` (active violations) | `min(count * 33, 100)` |
| Anomaly history | `RISK_WEIGHT_ANOMALY`, 13% | `anomalies` of the identity in the last `RISK_ANOMALY_LOOKBACK_DAYS` (default 90) days that are `open` or `acknowledged` (a dismissed or resolved one does not count) | `min(count * 20, 100)` |
| Admin tier | `RISK_WEIGHT_ADMIN`, 13% | Identity `adminTier`, else its ACTIVE `linkedAdminAccounts` entries whose admin identity is not deleted (one query; an entry whose `identityId` is no ObjectId names no identity and is skipped) | Tier 0=100, Tier 1=60, Tier 2=30, None=0 |
| Dormant account | `RISK_WEIGHT_DORMANT`, 10% | `provisioning.started`/`completed` audit entries | none in the last `RISK_DORMANCY_DAYS` (default 90) days = 100, else 0 |
| Peer deviation | `RISK_WEIGHT_PEER_DEVIATION`, 12% | `IntelligenceService.getPeerDeviationScore()`: the identity's outlier score in its peer group | already 0-100; 0 without a peer group |

**Final score** = SUM(factor.rawNormalized * factor.weight / 100)

The entitlement, high-risk and SoD factors come from one policy evaluation (`PolicyEngineService.evaluateForRiskScoring`). When it fails, the identity gets no new score (its previous one stays, the nightly batch counts an error): read as "no entitlements", it wrote a low score with a DECREASING trend.

### Trend Calculation

Comparing current score to previous calculation:
- **INCREASING**: delta > +5
- **DECREASING**: delta < -5
- **STABLE**: delta between -5 and +5

---

## Data Flow

```
    Temporal CronWorkflow (nightly)
              │
              ▼
    listRiskScoreTenants: the active tenants
              │
              ▼  one runRiskScoreTenant activity per tenant
    ┌──────────────────────────────────────────────┐
    │  For each active identity (paginated, 100):   │
    │                                               │
    │  1. Count entitlements (from provisioning)    │
    │  2. Count HIGH/CRITICAL (from catalog)        │
    │  3. Check SoD violations (from SodService)    │
    │  4. Count anomalies (from AnomalyService)     │
    │  5. Check admin tier (from identity)           │
    │  6. Check dormancy (last activity date)        │
    │  7. Peer deviation (IntelligenceService)      │
    │                                               │
    │  ──▶ Calculate weighted score                 │
    │  ──▶ Upsert identity_risk_scores document     │
    │  ──▶ Update trend (compare to previous)       │
    │  ──▶ Trim history to last 30 entries          │
    └──────────────────────────────────────────────┘
              │
              ▼
    Emit RISK_SCORES_CALCULATED domain event per tenant
    (summary: total processed, avg score, top 10)
```

Each tenant is scored in its own activity (`runRiskScoreTenant`, patch `risk-score-calculation:per-tenant`): it
heartbeats after every identity (the offset of the next one, the counts and the organisation's average entitlement
count) and, when Temporal retries it (a timeout, a worker restart; 5 attempts of up to 2 hours), resumes from the last
heartbeat instead of starting over. A tenant that fails for good counts as one error and the next tenant is scored.
After 50 tenants the workflow continues as new with the rest, the same run time and the counts so far. Runs started
before the patch score every tenant in one 30-minute activity (`runRiskScoreBatch`).

---

## API Endpoints

```
GET /api/v1/risk-scores?top=100&minScore=50     Top risky users
GET /api/v1/risk-scores/:identityId             Score for specific identity
GET /api/v1/risk-scores/distribution            Histogram data (buckets)
```

### Distribution Response

```json
{
  "buckets": [
    { "range": "0-10",  "count": 450 },
    { "range": "11-25", "count": 320 },
    { "range": "26-50", "count": 180 },
    { "range": "51-75", "count": 40 },
    { "range": "76-100","count": 10 }
  ],
  "average": 22,
  "median": 18
}
```

---

## Module Structure

```
backend/src/modules/risk-scoring/
├── risk-scoring.module.ts
├── risk-scoring.service.ts
├── risk-scoring.controller.ts
└── schemas/
    └── risk-score.schema.ts
```

---

## Frontend Dashboard

`frontend/src/features/intelligence/RiskDashboard.tsx`

- **Risk distribution histogram** (Ant Design Charts)
- **Top 20 risky users** table with score, trend arrow, top factors
- **Per-user factor breakdown** (expandable row)
- **Risk trend sparklines** (30-day history)

---

## Downstream Consumers

| Consumer | How Risk Score Is Used |
|----------|----------------------|
| Access Review | High-risk users prioritized in certification campaigns |
| Compliance Reports | Risk posture summary in SOX/ISO reports |
| Anomaly Detection | Risk score informs anomaly severity classification |

---

## Related Docs

| Doc | Relevance |
|-----|-----------|
| [`policy/docs/ARCHITECTURE.md`](../../policy/docs/ARCHITECTURE.md) | SoD violations feed into risk score |
| [`intelligence/docs/ARCHITECTURE.md`](../../intelligence/docs/ARCHITECTURE.md) | Peer groups behind the peer deviation factor |
| [`docs/architecture/infrastructure/TEMPORAL_WORKFLOWS.md`](../../../../../docs/architecture/infrastructure/TEMPORAL_WORKFLOWS.md) | `risk-score-calculation.workflow.ts` |
| [`identity/docs/DATABASE_ARCHITECTURE.md`](../../identity/docs/DATABASE_ARCHITECTURE.md) | `identity_risk_scores` collection |
