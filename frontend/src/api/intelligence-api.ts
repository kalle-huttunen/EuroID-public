/**
 * Intelligence Layer API
 *
 * API helper functions and React Query hooks for anomaly detection,
 * policy suggestions, access reviews, and analytics.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { axiosInstance } from './data';
import { API_BASE } from './constants';

// ── Types ────────────────────────────────────────────────────────────

export type AnomalyType =
  | 'TIME_BASED'
  | 'PEER_DEVIATION'
  | 'VELOCITY'
  | 'PRIVILEGE_ESCALATION'
  | 'ORPHAN_ACCESS';
export type AnomalySeverity = 'low' | 'medium' | 'high' | 'critical';
export type AnomalyStatus = 'open' | 'acknowledged' | 'dismissed' | 'resolved';

export interface Anomaly {
  _id?: string;
  anomalyId: string;
  identityId: string;
  type: AnomalyType;
  severity: AnomalySeverity;
  riskScore: number;
  title: string;
  description: string;
  evidence: {
    events: string[];
    pattern: string;
    details: Record<string, unknown>;
  };
  status: AnomalyStatus;
  detectedAt: string;
  acknowledgedBy?: string;
  resolvedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface AnomalyListResponse {
  data: Anomaly[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface RiskScoreEntry {
  identityId: string;
  riskScore: number;
  updatedAt: string;
}

/** Full composite risk score from risk-scoring module (identity_risk_scores) */
export type RiskFactorId =
  | 'entitlement_count'
  | 'high_risk_entitlements'
  | 'sod_violations'
  | 'anomaly_count'
  | 'admin_tier'
  | 'dormant'
  | 'peer_deviation';

export type RiskTrend = 'INCREASING' | 'STABLE' | 'DECREASING';

export interface RiskFactorEntry {
  factor: RiskFactorId;
  weight: number;
  rawValue: number;
  contribution: number;
}

export interface RiskScoreHistoryEntry {
  date: string;
  score: number;
}

export interface RiskScoreFull {
  tenantId: string;
  identityId: string;
  score: number;
  factors: RiskFactorEntry[];
  trend: RiskTrend;
  history: RiskScoreHistoryEntry[];
  calculatedAt: string;
}

export interface RiskScoreDistribution {
  buckets: { range: string; count: number }[];
  average: number;
  median: number;
}

export type SuggestionType =
  | 'BIRTHRIGHT_PATTERN'
  | 'ORPHAN_ENTITLEMENT'
  | 'REDUNDANT_POLICY'
  | 'COVERAGE_GAP';

export interface PolicySuggestion {
  _id?: string;
  suggestionId: string;
  type: SuggestionType;
  confidence: number;
  title: string;
  description: string;
  suggestedPolicy?: unknown;
  evidence?: {
    totalUsers: number;
    matchingUsers: number;
    percentage: number;
    sampleUserIds?: string[];
    affectedEntitlements?: string[];
  };
  status: 'pending' | 'accepted' | 'dismissed' | 'expired';
  acceptedBy?: string;
  dismissedBy?: string;
  dismissReason?: string;
  resultingPolicyId?: string;
}

export interface PolicySuggestionListResponse {
  data: PolicySuggestion[];
  total: number;
}

export type CampaignStatus = 'DRAFT' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED';

export interface CampaignRecurrence {
  enabled: boolean;
  frequency?: 'MONTHLY' | 'QUARTERLY' | 'SEMI_ANNUAL' | 'ANNUAL';
  nextRunAt?: string;
  previousCampaignId?: string;
}

export interface CampaignEscalation {
  enabled: boolean;
  escalateAfterDays: number;
  escalateTo: 'MANAGER' | 'ADMIN';
}

export interface ReviewCampaign {
  _id?: string;
  campaignId: string;
  name: string;
  description?: string;
  scope: { type: 'department' | 'role' | 'system' | 'all'; value?: string };
  status: CampaignStatus;
  createdBy: string;
  deadline: string;
  autoRevokeOnExpiry: boolean;
  stats: {
    totalItems: number;
    approved: number;
    revoked: number;
    pending: number;
    expired: number;
  };
  recurrence?: CampaignRecurrence;
  escalation?: CampaignEscalation;
  templateCampaignId?: string;
  /** Outcome counts of the revocations, set at completion when something was revoked. */
  revocationSummary?: {
    removed: number;
    alreadyGone: number;
    manualActionNeeded: number;
    failed: number;
  };
}

/**
 * What revoking a reviewed entitlement did at campaign close: removed, already gone, needs an
 * admin to remove it by hand (EuroID cannot), or failed (the access may still be there).
 */
export type RevocationOutcome = 'removed' | 'already-gone' | 'manual-action-needed' | 'failed';

export interface ReviewRevocation {
  outcome: RevocationOutcome;
  detail?: string;
  /** Why it failed, or what an admin must do. */
  reason?: string;
  at: string;
}

export interface ReviewEntitlement {
  system: string;
  type: string;
  name: string;
  nativeId?: string;
  policyManaged: boolean;
  riskLevel?: string;
  /** The holder's account in the target when the item was generated. */
  accountId?: string;
  revocation?: ReviewRevocation;
}

export type ReviewDecision = 'pending' | 'approved' | 'revoked' | 'expired';

export interface ReviewItem {
  _id?: string;
  itemId: string;
  campaignId: string;
  identityId: string;
  identityEmail: string;
  identityName: string;
  reviewerId: string;
  entitlements: ReviewEntitlement[];
  decision: ReviewDecision;
  decidedBy?: string;
  decidedAt?: string;
  justification?: string;
  previousDecision?: 'APPROVED' | 'REVOKED';
  previousDecisionDate?: string;
  previousCampaignId?: string;
  escalatedFrom?: string;
  escalatedAt?: string;
}

export interface UpcomingOffboarding {
  identityId: string;
  email: string;
  displayName: string;
  endDate: string;
  daysRemaining: number;
  blastRadius: {
    affectedSystems: string[];
    entitlements: Array<{ system: string; name: string; type: string }>;
    totalEntitlements: number;
    riskLevel: string;
  };
  computedAt: string;
  stale: boolean;
}

export interface LicenseForecast {
  system: string;
  license: string;
  /** Units in use as discovery last read them; null until discovery has run. */
  currentCount: number | null;
  /** Units the tenant has (enabled), or the configured cap; null when unknown. */
  capacity: number | null;
  countsObservedAt?: string;
  /** null while currentCount is unknown. */
  projectedCount: number | null;
  daysToCapacity?: number;
  trend: 'growing' | 'stable' | 'declining';
  monthlyRate: number;
  insufficientData?: boolean;
}

export interface SeasonalPattern {
  month: number;
  year: number;
  averageOnboardings: number;
  peakOnboardings: number;
  isAnomalous: boolean;
  label?: string;
}

// ── API Functions ─────────────────────────────────────────────────────

export async function fetchAnomalies(params: {
  identityId?: string;
  type?: string | string[];
  severity?: string | string[];
  status?: string;
  page?: number;
  limit?: number;
}): Promise<AnomalyListResponse> {
  const search = new URLSearchParams();
  if (params.identityId) search.set('identityId', params.identityId);
  if (params.type)
    (Array.isArray(params.type) ? params.type : [params.type]).forEach((t) =>
      search.append('type', t),
    );
  if (params.severity)
    (Array.isArray(params.severity) ? params.severity : [params.severity]).forEach((s) =>
      search.append('severity', s),
    );
  if (params.status) search.set('status', params.status);
  if (params.page) search.set('page', String(params.page));
  if (params.limit) search.set('limit', String(params.limit));
  const res = await axiosInstance.get<AnomalyListResponse>(
    `${API_BASE}/anomalies?${search.toString()}`,
  );
  return res.data;
}

export async function fetchRiskScores(limit = 50): Promise<RiskScoreEntry[]> {
  const res = await axiosInstance.get<RiskScoreEntry[]>(
    `${API_BASE}/anomalies/risk-scores?limit=${limit}`,
  );
  const data = res.data;
  return Array.isArray(data) ? data : [];
}

/** Full composite risk scores from risk-scoring module */
export async function fetchRiskScoresFull(params?: {
  top?: number;
  minScore?: number;
}): Promise<RiskScoreFull[]> {
  const search = new URLSearchParams();
  if (params?.top != null) search.set('top', String(params.top));
  if (params?.minScore != null) search.set('minScore', String(params.minScore));
  const qs = search.toString();
  const res = await axiosInstance.get<RiskScoreFull[]>(
    `${API_BASE}/risk-scores${qs ? `?${qs}` : ''}`,
  );
  return Array.isArray(res.data) ? res.data : [];
}

export async function fetchRiskScoreByIdentity(identityId: string): Promise<RiskScoreFull | null> {
  try {
    const res = await axiosInstance.get<RiskScoreFull>(`${API_BASE}/risk-scores/${identityId}`);
    return res.data;
  } catch {
    return null;
  }
}

export async function fetchRiskScoreDistribution(): Promise<RiskScoreDistribution> {
  const res = await axiosInstance.get<RiskScoreDistribution>(
    `${API_BASE}/risk-scores/distribution`,
  );
  return res.data;
}

export async function fetchAnomalyDetail(id: string): Promise<Anomaly> {
  const res = await axiosInstance.get<Anomaly>(`${API_BASE}/anomalies/${id}`);
  return res.data;
}

export async function acknowledgeAnomaly(id: string): Promise<Anomaly> {
  const res = await axiosInstance.post<Anomaly>(`${API_BASE}/anomalies/${id}/acknowledge`);
  return res.data;
}

export async function dismissAnomaly(id: string, reason?: string): Promise<Anomaly> {
  const res = await axiosInstance.post<Anomaly>(`${API_BASE}/anomalies/${id}/dismiss`, {
    reason,
  });
  return res.data;
}

/** POST /anomalies/:id/resolve (operator): status `resolved`, `resolvedAt` now. */
export async function resolveAnomaly(id: string): Promise<Anomaly> {
  const res = await axiosInstance.post<Anomaly>(`${API_BASE}/anomalies/${id}/resolve`);
  return res.data;
}

/** Rules that threw during a run: counts only, the causes are in the server log. */
export interface AnomalyRuleFailures {
  /** Distinct rules that failed for at least one identity. */
  rules: number;
  /** Identities with at least one failed rule. */
  identities: number;
  /** Per rule: the identities it failed for. */
  byRule: Partial<Record<AnomalyType, number>>;
}

/** Answer of POST /anomalies/analyze. */
export interface AnomalyAnalysisResult {
  /** Identities the rules ran for. */
  analyzed: number;
  /** Identities the run could cover: the tenant's for a batch, 1 for a found identity. */
  totalIdentities: number;
  /** New anomalies saved; one already open with the same type and pattern is not saved again. */
  anomaliesCreated: number;
  identityIds: string[];
  /** A failed rule found nothing it could report: what it would find is missing. */
  ruleFailures: AnomalyRuleFailures;
}

/**
 * POST /anomalies/analyze (super-admin). With `identityId` one identity, without it the first
 * page of identities (50 by default) of `totalIdentities`.
 */
export async function analyzeAnomalies(body?: {
  identityId?: string;
}): Promise<AnomalyAnalysisResult> {
  const res = await axiosInstance.post<AnomalyAnalysisResult>(
    `${API_BASE}/anomalies/analyze`,
    body ?? {},
  );
  return res.data;
}

export async function fetchPolicySuggestions(params: {
  type?: SuggestionType;
  status?: string;
  confidenceMin?: number;
  page?: number;
  limit?: number;
}): Promise<PolicySuggestionListResponse> {
  const search = new URLSearchParams();
  if (params.type) search.set('type', params.type);
  if (params.status) search.set('status', params.status);
  if (params.confidenceMin != null) search.set('confidenceMin', String(params.confidenceMin));
  if (params.page != null) search.set('page', String(params.page));
  if (params.limit != null) search.set('limit', String(params.limit));
  const res = await axiosInstance.get<PolicySuggestionListResponse>(
    `${API_BASE}/policy-suggestions?${search.toString()}`,
  );
  return res.data;
}

/** POST /policy-suggestions/:suggestionId/accept: the suggestion, with `resultingPolicyId`. */
export async function acceptSuggestion(id: string): Promise<PolicySuggestion> {
  const res = await axiosInstance.post<PolicySuggestion>(
    `${API_BASE}/policy-suggestions/${id}/accept`,
  );
  return res.data;
}

export async function dismissSuggestion(id: string, reason?: string): Promise<PolicySuggestion> {
  const res = await axiosInstance.post(`${API_BASE}/policy-suggestions/${id}/dismiss`, {
    reason,
  });
  return res.data;
}

export async function fetchCampaigns(params: {
  status?: CampaignStatus;
  page?: number;
  limit?: number;
}): Promise<{ data: ReviewCampaign[]; total: number }> {
  const search = new URLSearchParams();
  if (params.status) search.set('status', params.status);
  if (params.page != null) search.set('page', String(params.page));
  if (params.limit != null) search.set('limit', String(params.limit));
  const res = await axiosInstance.get<{ data: ReviewCampaign[]; total: number }>(
    `${API_BASE}/access-reviews/campaigns?${search.toString()}`,
  );
  return res.data;
}

export async function fetchCampaign(campaignId: string): Promise<ReviewCampaign> {
  const res = await axiosInstance.get<ReviewCampaign>(
    `${API_BASE}/access-reviews/campaigns/${campaignId}`,
  );
  return res.data;
}

export async function createCampaign(body: {
  name: string;
  description?: string;
  scope: { type: 'department' | 'role' | 'system' | 'all'; value?: string };
  deadline?: string;
  autoRevokeOnExpiry?: boolean;
  allowSelfReview?: boolean;
  selfReviewRiskLevels?: string[];
  recurrence?: { enabled: boolean; frequency: 'MONTHLY' | 'QUARTERLY' | 'SEMI_ANNUAL' | 'ANNUAL' };
  escalation?: { enabled: boolean; escalateAfterDays: number; escalateTo: 'MANAGER' | 'ADMIN' };
}): Promise<ReviewCampaign> {
  const res = await axiosInstance.post<ReviewCampaign>(
    `${API_BASE}/access-reviews/campaigns`,
    body,
  );
  return res.data;
}

export async function activateCampaign(campaignId: string): Promise<ReviewCampaign> {
  const res = await axiosInstance.post<ReviewCampaign>(
    `${API_BASE}/access-reviews/campaigns/${campaignId}/activate`,
  );
  return res.data;
}

/** Cancel a DRAFT or ACTIVE campaign (super-admin); the reason goes to the audit log. */
export async function cancelCampaign(campaignId: string, reason: string): Promise<ReviewCampaign> {
  const res = await axiosInstance.post<ReviewCampaign>(
    `${API_BASE}/access-reviews/campaigns/${campaignId}/cancel`,
    { reason },
  );
  return res.data;
}

export async function fetchCampaignItems(
  campaignId: string,
  params?: { decision?: ReviewDecision; page?: number; limit?: number },
): Promise<{ data: ReviewItem[]; total: number }> {
  const search = new URLSearchParams();
  if (params?.decision) search.set('decision', params.decision);
  if (params?.page != null) search.set('page', String(params.page));
  if (params?.limit != null) search.set('limit', String(params.limit));
  const res = await axiosInstance.get<{ data: ReviewItem[]; total: number }>(
    `${API_BASE}/access-reviews/campaigns/${campaignId}/items?${search.toString()}`,
  );
  return res.data;
}

export async function decideReviewItem(
  itemId: string,
  decision: 'approved' | 'revoked',
  justification?: string,
): Promise<ReviewItem> {
  const res = await axiosInstance.post<ReviewItem>(
    `${API_BASE}/access-reviews/items/${itemId}/decide`,
    { decision, justification },
  );
  return res.data;
}

export async function fetchMyReviews(params?: {
  decision?: ReviewDecision;
  page?: number;
  limit?: number;
}): Promise<{ data: ReviewItem[]; total: number }> {
  const search = new URLSearchParams();
  if (params?.decision) search.set('decision', params.decision);
  if (params?.page != null) search.set('page', String(params.page));
  if (params?.limit != null) search.set('limit', String(params.limit));
  const res = await axiosInstance.get<{ data: ReviewItem[]; total: number }>(
    `${API_BASE}/access-reviews/my-reviews?${search.toString()}`,
  );
  return res.data;
}

export async function fetchUpcomingOffboardings(
  daysAhead = 30,
  refresh?: boolean,
): Promise<UpcomingOffboarding[]> {
  const params = new URLSearchParams();
  params.set('daysAhead', String(daysAhead));
  if (refresh) params.set('refresh', 'true');
  const res = await axiosInstance.get<UpcomingOffboarding[]>(
    `${API_BASE}/analytics/upcoming-offboardings?${params.toString()}`,
  );
  return Array.isArray(res.data) ? res.data : [];
}

export async function fetchUpcomingOffboardingByIdentity(
  identityId: string,
): Promise<UpcomingOffboarding | null> {
  try {
    const res = await axiosInstance.get<UpcomingOffboarding>(
      `${API_BASE}/analytics/upcoming-offboardings/${identityId}`,
    );
    return res.data;
  } catch {
    return null;
  }
}

export async function fetchLicenseForecast(daysAhead = 90): Promise<LicenseForecast[]> {
  const res = await axiosInstance.get<LicenseForecast[]>(
    `${API_BASE}/analytics/license-forecast?daysAhead=${daysAhead}`,
  );
  return Array.isArray(res.data) ? res.data : [];
}

export async function fetchSeasonalPatterns(): Promise<SeasonalPattern[]> {
  const res = await axiosInstance.get<SeasonalPattern[]>(`${API_BASE}/analytics/seasonal-patterns`);
  return Array.isArray(res.data) ? res.data : [];
}

// ── React Query Keys ───────────────────────────────────────────────────

export const intelligenceKeys = {
  all: ['intelligence'] as const,
  anomalies: (params?: object) => ['intelligence', 'anomalies', params] as const,
  anomaliesPrefix: () => ['intelligence', 'anomalies'] as const,
  anomaly: (id: string) => ['intelligence', 'anomaly', id] as const,
  riskScores: () => ['intelligence', 'risk-scores'] as const,
  riskScoresFull: (params?: object) => ['intelligence', 'risk-scores-full', params] as const,
  riskScoreByIdentity: (id: string) => ['intelligence', 'risk-score', id] as const,
  riskScoreDistribution: () => ['intelligence', 'risk-score-distribution'] as const,
  campaignsPrefix: () => ['intelligence', 'campaigns'] as const,
  campaignPrefix: () => ['intelligence', 'campaign'] as const,
  myReviewsPrefix: () => ['intelligence', 'my-reviews'] as const,
  suggestions: (params?: object) => ['intelligence', 'suggestions', params] as const,
  /** Every suggestions list: `suggestions()` ends in `undefined`, which matches no list query. */
  suggestionsPrefix: () => ['intelligence', 'suggestions'] as const,
  campaigns: (params?: object) => ['intelligence', 'campaigns', params] as const,
  campaign: (id: string) => ['intelligence', 'campaign', id] as const,
  campaignItems: (id: string, params?: object) =>
    ['intelligence', 'campaign', id, 'items', params] as const,
  myReviews: (params?: object) => ['intelligence', 'my-reviews', params] as const,
  upcomingOffboardings: (days?: number) => ['intelligence', 'upcoming-offboardings', days] as const,
  offboardingByIdentity: (id: string) => ['intelligence', 'upcoming-offboarding', id] as const,
  licenseForecast: (days?: number) => ['intelligence', 'license-forecast', days] as const,
  seasonalPatterns: () => ['intelligence', 'seasonal-patterns'] as const,
};

// ── Anomaly hooks (detail modal) ──────────────────────────────────────

/** One anomaly by its `anomalyId`, the id the `/anomalies/:id` routes take. */
export function useAnomaly(id: string | null) {
  return useQuery({
    queryKey: intelligenceKeys.anomaly(id ?? ''),
    queryFn: () => fetchAnomalyDetail(id as string),
    enabled: !!id,
  });
}

/** What an anomaly change can move: every anomaly list and detail, and the risk scores. */
function invalidateAnomalyViews(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: intelligenceKeys.anomaliesPrefix() });
  void qc.invalidateQueries({ queryKey: ['intelligence', 'anomaly'] });
  void qc.invalidateQueries({ queryKey: intelligenceKeys.riskScores() });
  void qc.invalidateQueries({ queryKey: ['intelligence', 'risk-scores-full'] });
}

/** A status change that answers the updated anomaly, which becomes the detail at once. */
function useAnomalyStatusMutation<TVars extends { id: string }>(
  run: (vars: TVars) => Promise<Anomaly>,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSuccess: (anomaly, vars) => qc.setQueryData(intelligenceKeys.anomaly(vars.id), anomaly),
    onSettled: () => invalidateAnomalyViews(qc),
  });
}

/** Acknowledge (operator). */
export function useAcknowledgeAnomaly() {
  return useAnomalyStatusMutation(({ id }: { id: string }) => acknowledgeAnomaly(id));
}

/** Dismiss with an optional reason (operator). */
export function useDismissAnomaly() {
  return useAnomalyStatusMutation(({ id, reason }: { id: string; reason?: string }) =>
    dismissAnomaly(id, reason),
  );
}

/** Resolve (operator). */
export function useResolveAnomaly() {
  return useAnomalyStatusMutation(({ id }: { id: string }) => resolveAnomaly(id));
}

/** Run the anomaly rules for one identity, or for the first page of identities (super-admin). */
export function useAnalyzeAnomalies() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: analyzeAnomalies,
    onSettled: () => invalidateAnomalyViews(qc),
  });
}
