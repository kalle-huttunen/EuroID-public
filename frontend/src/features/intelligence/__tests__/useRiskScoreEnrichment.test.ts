import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useRiskScoreEnrichment } from '../hooks/useRiskScoreEnrichment';
import type { RiskFactorId, RiskScoreFull } from '@api/intelligence-api';

// A composite score as GET /risk-scores sends it. risk-scoring.service.ts emits these seven factors.
const fullScore = (factors: RiskScoreFull['factors']): RiskScoreFull => ({
  tenantId: 'dev-tenant',
  identityId: 'id-1',
  score: 74,
  factors,
  trend: 'INCREASING',
  history: [],
  calculatedAt: '2026-11-22T10:00:00.000Z',
});

const topFactorsOf = (score: RiskScoreFull) =>
  renderHook(() =>
    useRiskScoreEnrichment({
      identityData: [],
      riskScores: [],
      riskScoresFull: [score],
      allOpenAnomalies: [],
    }),
  ).result.current.enrichedRiskScores[0].topFactors;

describe('useRiskScoreEnrichment top factors', () => {
  it('labels every factor the backend emits', () => {
    const topFactors = topFactorsOf(
      fullScore([
        { factor: 'peer_deviation', weight: 0.15, rawValue: 0.4, contribution: 30 },
        { factor: 'dormant', weight: 0.05, rawValue: 60, contribution: 29 },
        { factor: 'admin_tier', weight: 0.1, rawValue: 50, contribution: 28 },
        { factor: 'anomaly_count', weight: 0.25, rawValue: 3, contribution: 25 },
        { factor: 'sod_violations', weight: 0.2, rawValue: 1, contribution: 24 },
        { factor: 'high_risk_entitlements', weight: 0.25, rawValue: 1, contribution: 23 },
        { factor: 'entitlement_count', weight: 0.15, rawValue: 5, contribution: 22 },
      ]),
    );
    expect(topFactors).toBe('Peer deviation: 0.4, Dormant: 60, Admin tier: 50');

    const rest = topFactorsOf(
      fullScore([
        { factor: 'anomaly_count', weight: 0.25, rawValue: 3, contribution: 25 },
        { factor: 'sod_violations', weight: 0.2, rawValue: 1, contribution: 24 },
        { factor: 'high_risk_entitlements', weight: 0.25, rawValue: 1, contribution: 23 },
      ]),
    );
    expect(rest).toBe('Anomalies: 3, SoD: 1, High-risk: 1');
    expect(
      topFactorsOf(
        fullScore([{ factor: 'entitlement_count', weight: 0.15, rawValue: 5, contribution: 9 }]),
      ),
    ).toBe('Entitlements: 5');
  });

  it('shows a factor the frontend does not know by a readable form of its id', () => {
    const topFactors = topFactorsOf(
      fullScore([
        { factor: 'login_velocity' as RiskFactorId, weight: 0.1, rawValue: 7, contribution: 12 },
      ]),
    );
    expect(topFactors).toBe('Login velocity: 7');
    expect(topFactors).not.toContain('undefined');
  });
});
