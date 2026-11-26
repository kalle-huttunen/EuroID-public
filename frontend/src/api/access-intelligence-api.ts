/**
 * Access intelligence API (backend `modules/intelligence`, routes under `/intelligence`): reviewer
 * quality scores (super-admin), peer groups and a group's outliers (policy-admin), an identity's
 * recommended entitlements and the unusual-request check (operator). The nightly intelligence
 * batch computes the scores and the groups; no route computes them on demand. Identities are keyed
 * by `_id`, campaigns by `campaignId`, peer groups by `groupKey`.
 */
import { useQueries, useQuery } from '@tanstack/react-query';
import { axiosInstance } from '@api/data';
import { API_BASE } from '@api/constants';
import { PAGE_SIZES } from '@config/pagination';
import type {
  IAccessRecommendation,
  IPeerGroupOutlier,
  IPeerGroupPage,
  IReviewerQualityPage,
  IUnusualRequestWarning,
} from '../interfaces';

const INTELLIGENCE_API = `${API_BASE}/intelligence`;
const enc = encodeURIComponent;

export const REVIEWER_QUALITY_PAGE_SIZE = PAGE_SIZES.MEDIUM;
export const PEER_GROUP_PAGE_SIZE = PAGE_SIZES.MEDIUM;

/** Under `intelligence`, so the intelligence prefix covers them too. */
export const accessIntelligenceKeys = {
  reviewerQualityPrefix: () => ['intelligence', 'reviewer-quality'] as const,
  reviewerQuality: (campaignId: string | undefined, page: number) =>
    ['intelligence', 'reviewer-quality', campaignId ?? 'all', page] as const,
  /** Every peer group list page and every group's outliers. */
  peerGroupsPrefix: () => ['intelligence', 'peer-groups'] as const,
  peerGroups: (page: number) => ['intelligence', 'peer-groups', 'list', page] as const,
  outliers: (groupKey: string) => ['intelligence', 'peer-groups', 'outliers', groupKey] as const,
  recommendations: (identityId: string) => ['intelligence', 'recommendations', identityId] as const,
  unusualCheck: (identityId: string, entitlementId: string) =>
    ['intelligence', 'unusual-check', identityId, entitlementId] as const,
  /** Under `identity`, so every identity change reads it again. */
  identityIdByEmail: (email: string) => ['identity', 'v2', 'by-email', email, 'id'] as const,
};

/**
 * GET /intelligence/reviewer-quality (super-admin), or with a campaign
 * GET /intelligence/reviewer-quality/:campaignId: one page, lowest score first.
 */
export async function fetchReviewerQuality(
  campaignId: string | undefined,
  page: number,
  limit: number = REVIEWER_QUALITY_PAGE_SIZE,
): Promise<IReviewerQualityPage> {
  const url = campaignId
    ? `${INTELLIGENCE_API}/reviewer-quality/${enc(campaignId)}`
    : `${INTELLIGENCE_API}/reviewer-quality`;
  const { data } = await axiosInstance.get<IReviewerQualityPage>(url, { params: { page, limit } });
  return data;
}

export function useReviewerQuality(campaignId: string | undefined, page: number, enabled = true) {
  return useQuery({
    queryKey: accessIntelligenceKeys.reviewerQuality(campaignId, page),
    queryFn: () => fetchReviewerQuality(campaignId, page),
    enabled,
  });
}

/** GET /intelligence/peer-groups (policy-admin): one page, largest group first. */
export async function fetchPeerGroups(
  page: number,
  limit: number = PEER_GROUP_PAGE_SIZE,
): Promise<IPeerGroupPage> {
  const { data } = await axiosInstance.get<IPeerGroupPage>(`${INTELLIGENCE_API}/peer-groups`, {
    params: { page, limit },
  });
  return data;
}

export function usePeerGroups(page: number) {
  return useQuery({
    queryKey: accessIntelligenceKeys.peerGroups(page),
    queryFn: () => fetchPeerGroups(page),
  });
}

/** GET /intelligence/peer-groups/:groupKey/outliers (policy-admin): highest deviation first. */
export async function fetchPeerGroupOutliers(groupKey: string): Promise<IPeerGroupOutlier[]> {
  const { data } = await axiosInstance.get<IPeerGroupOutlier[]>(
    `${INTELLIGENCE_API}/peer-groups/${enc(groupKey)}/outliers`,
  );
  return Array.isArray(data) ? data : [];
}

export function usePeerGroupOutliers(groupKey: string | undefined) {
  return useQuery({
    queryKey: accessIntelligenceKeys.outliers(groupKey ?? ''),
    queryFn: () => fetchPeerGroupOutliers(groupKey as string),
    enabled: !!groupKey,
  });
}

/**
 * GET /intelligence/recommendations/:identityId (operator). Each says how the peers hold it and
 * whether it can be requested. Empty when the identity is in no peer group, already has what
 * most peers have, or its access could not be evaluated.
 */
export async function fetchRecommendations(identityId: string): Promise<IAccessRecommendation[]> {
  const { data } = await axiosInstance.get<IAccessRecommendation[]>(
    `${INTELLIGENCE_API}/recommendations/${enc(identityId)}`,
  );
  return Array.isArray(data) ? data : [];
}

export function useRecommendations(identityId: string | undefined) {
  return useQuery({
    queryKey: accessIntelligenceKeys.recommendations(identityId ?? ''),
    queryFn: () => fetchRecommendations(identityId as string),
    enabled: !!identityId,
  });
}

/**
 * POST /intelligence/unusual-check (operator). The entitlement is named as the peer baseline names
 * a requested one, `system::nativeId`. The API answers no body (null) for a usual request and for
 * an identity in no peer group.
 */
export async function checkUnusualRequest(
  identityId: string,
  entitlementId: string,
): Promise<IUnusualRequestWarning | null> {
  const { data } = await axiosInstance.post<IUnusualRequestWarning | ''>(
    `${INTELLIGENCE_API}/unusual-check`,
    { identityId, entitlementId },
  );
  return data && typeof data === 'object' ? data : null;
}

/** What the check needs of a requestable catalog entry. */
export interface CheckableEntry {
  _id: string;
  name: string;
  system: string;
  nativeId?: string;
}

/**
 * The unusual-request check for each entry that has a native id (an entry without one has no
 * name in the peer baseline). Not cached across opens: the answer follows the latest batch.
 */
export function useUnusualRequestChecks(identityId: string | undefined, entries: CheckableEntry[]) {
  const checkable = identityId ? entries.filter((e) => e.nativeId) : [];
  const results = useQueries({
    queries: checkable.map((e) => {
      const entitlementId = `${e.system}::${e.nativeId}`;
      return {
        queryKey: accessIntelligenceKeys.unusualCheck(identityId as string, entitlementId),
        queryFn: () => checkUnusualRequest(identityId as string, entitlementId),
        staleTime: 0,
        retry: false,
      };
    }),
  });
  return checkable.map((entry, i) => ({ entry, result: results[i] }));
}

/**
 * The `_id` of the identity with this work email (GET /identity/v2/by-email, viewer), the way
 * the access request routes find the requester; null when no identity has it.
 */
export function useIdentityIdByEmail(email: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: accessIntelligenceKeys.identityIdByEmail(email ?? ''),
    queryFn: async () => {
      try {
        const { data } = await axiosInstance.get<{ identity?: { _id?: string } | null }>(
          `${API_BASE}/identity/v2/by-email`,
          { params: { email } },
        );
        return data?.identity?._id ? String(data.identity._id) : null;
      } catch (err) {
        // 404: the signed-in user is no identity in the hub, so there are no peers to compare.
        if ((err as { response?: { status?: number } }).response?.status === 404) return null;
        throw err;
      }
    },
    enabled: enabled && !!email,
    retry: false,
  });
}
