/**
 * Access review exclusions: an identity's revoked access the policies no longer grant (Access
 * tab), lifting one (policy-admin; the next evaluation grants the access again), and the counts
 * per granting policy (policy list).
 * Backend: `modules/policy` (ReviewExclusionController).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { axiosInstance } from '@api/data';
import { API_BASE } from '@api/constants';
import { accessChangeKeys } from '@api/access-change-api';
import type {
  IPolicyReviewExclusionCount,
  IReviewExclusion,
  IReviewExclusionLift,
} from '../interfaces';

const exclusionsUrl = (identityId: string) =>
  `${API_BASE}/identity/${encodeURIComponent(identityId)}/access/review-exclusions`;

export const reviewExclusionKeys = {
  all: ['identity', 'review-exclusions'] as const,
  identity: (identityId: string) => ['identity', 'review-exclusions', identityId] as const,
  /** Under the policies' prefix: refreshed with the policy list. */
  counts: () => ['policies', 'review-exclusion-counts'] as const,
};

/** The identity's active exclusions, newest first. */
export async function fetchReviewExclusions(identityId: string): Promise<IReviewExclusion[]> {
  const { data } = await axiosInstance.get<{ exclusions?: IReviewExclusion[] }>(
    exclusionsUrl(identityId),
  );
  return Array.isArray(data?.exclusions) ? data.exclusions : [];
}

/** Exclusions per granting policy, keyed by policy id. */
export async function fetchReviewExclusionCounts(): Promise<
  Record<string, IPolicyReviewExclusionCount>
> {
  const { data } = await axiosInstance.get<{ counts?: IPolicyReviewExclusionCount[] }>(
    `${API_BASE}/policy/review-exclusions/counts`,
  );
  const counts = Array.isArray(data?.counts) ? data.counts : [];
  return Object.fromEntries(counts.map((c) => [c.policyId, c]));
}

export function useReviewExclusions(identityId: string) {
  return useQuery({
    queryKey: reviewExclusionKeys.identity(identityId),
    queryFn: () => fetchReviewExclusions(identityId),
    enabled: !!identityId,
  });
}

export function useReviewExclusionCounts() {
  return useQuery({
    queryKey: reviewExclusionKeys.counts(),
    queryFn: fetchReviewExclusionCounts,
    staleTime: 60_000,
  });
}

/**
 * Lift an exclusion; the backend then starts the run that gives the access back (`run` in the
 * answer: the re-evaluation, or onboarding for an account). Afterwards the identity's access as
 * the policies grant it changes: its exclusions, entitlements, access preview and identity map,
 * and the counts per policy.
 */
export function useLiftReviewExclusion(identityId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (exclusionId: string) => {
      const { data } = await axiosInstance.post<IReviewExclusionLift>(
        `${exclusionsUrl(identityId)}/${encodeURIComponent(exclusionId)}/lift`,
        {},
      );
      return data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: reviewExclusionKeys.identity(identityId) });
      void qc.invalidateQueries({ queryKey: ['identity', 'entitlements', identityId] });
      void qc.invalidateQueries({ queryKey: accessChangeKeys.preview(identityId) });
      // identityMapKeys.all(): the map's policy trace (not imported, it pulls in the map's APIs)
      void qc.invalidateQueries({ queryKey: ['identity-map'] });
      void qc.invalidateQueries({ queryKey: reviewExclusionKeys.counts() });
    },
  });
}
