/**
 * useRiskScoreEnrichment — Identity map building and score enrichment
 */

import { useMemo } from 'react';
import type { IStandardUser } from '../../../interfaces';
import type { RiskScoreFull, RiskFactorId } from '@api/intelligence-api';

const FACTOR_LABELS: Record<RiskFactorId, string> = {
  entitlement_count: 'Entitlements',
  high_risk_entitlements: 'High-risk',
  sod_violations: 'SoD',
  anomaly_count: 'Anomalies',
  admin_tier: 'Admin tier',
  dormant: 'Dormant',
  peer_deviation: 'Peer deviation',
};

/** A factor's label; a factor id without one (added in the backend later) reads as words. */
function factorLabel(factor: string): string {
  const label = FACTOR_LABELS[factor as RiskFactorId];
  if (label) return label;
  const words = factor.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function getDisplayName(user: IStandardUser | undefined): string {
  if (!user) return '';
  const n = [user.firstName, user.lastName].filter(Boolean).join(' ');
  return n || user.displayName || user.email || '';
}

interface RiskScoreSource {
  identityId: string;
  riskScore?: number;
  score?: number;
}

export interface EnrichedRiskScore {
  identityId: string;
  score: number;
  name: string;
  email: string;
  department: string;
  openAnomalies: number;
  trend?: string;
  topFactors: string;
  history?: { date: string; score: number }[];
  factors?: { factor: RiskFactorId; rawValue: number; contribution: number }[];
}

interface UseRiskScoreEnrichmentParams {
  identityData: IStandardUser[] | undefined;
  riskScores: RiskScoreSource[] | undefined;
  riskScoresFull: RiskScoreFull[] | undefined;
  allOpenAnomalies: { identityId: string }[];
}

export function useRiskScoreEnrichment({
  identityData,
  riskScores,
  riskScoresFull,
  allOpenAnomalies,
}: UseRiskScoreEnrichmentParams) {
  const identityMap = useMemo(() => {
    const map = new Map<string, IStandardUser>();
    (identityData || []).forEach((u) => {
      const id = u._id?.toString?.() || (u as IStandardUser & { id?: string }).id;
      if (id) map.set(id, u);
      if (u.email) map.set(u.email, u);
    });
    return map;
  }, [identityData]);

  const openAnomaliesByIdentity = useMemo(() => {
    const map = new Map<string, number>();
    allOpenAnomalies.forEach((a) => {
      map.set(a.identityId, (map.get(a.identityId) ?? 0) + 1);
    });
    return map;
  }, [allOpenAnomalies]);

  const enrichedRiskScores = useMemo((): EnrichedRiskScore[] => {
    const useFullScores = (riskScoresFull?.length ?? 0) > 0;
    const source = useFullScores ? riskScoresFull : riskScores;
    if (!source) return [];
    return source.map((r) => {
      const user = identityMap.get(r.identityId);
      const identityId = r.identityId;
      const score =
        'score' in r ? (r as RiskScoreFull).score : ((r as RiskScoreSource).riskScore ?? 0);
      const full = useFullScores ? (r as RiskScoreFull) : null;
      const topFactors =
        full?.factors
          ?.filter((f) => f.rawValue > 0)
          .sort((a, b) => b.contribution - a.contribution)
          .slice(0, 3)
          .map((f) => `${factorLabel(f.factor)}: ${f.rawValue}`)
          .join(', ') ?? '';
      return {
        ...r,
        identityId,
        score,
        name: getDisplayName(user) || identityId,
        email: user?.email ?? '-',
        department: user?.departmentName ?? user?.departmentCode ?? '-',
        openAnomalies: openAnomaliesByIdentity.get(identityId) ?? 0,
        trend: full?.trend,
        topFactors,
        history: full?.history ?? [],
        factors: full?.factors ?? [],
      };
    });
  }, [riskScoresFull, riskScores, identityMap, openAnomaliesByIdentity]);

  const useFullScores = (riskScoresFull?.length ?? 0) > 0;

  return {
    identityMap,
    enrichedRiskScores,
    openAnomaliesByIdentity,
    useFullScores,
  };
}

export { factorLabel, getDisplayName };
