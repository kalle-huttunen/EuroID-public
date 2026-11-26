/**
 * Policy API — query keys, fetch functions, and TanStack Query hooks
 */
import { useQuery, useMutation, useQueryClient, useQueries } from '@tanstack/react-query';
import { axiosInstance } from '@api/data';
import { API_BASE } from '@api/constants';
import type { Policy, PolicyStatus } from '../components/policy-engine/types';

const API = `${API_BASE}/policy`;

/** MongoDB documents may have _id; normalize to id. */
function normalizePolicy(raw: Policy & { _id?: string }): Policy {
  return { ...raw, id: raw._id ?? raw.id };
}

export const policyKeys = {
  all: ['policies'] as const,
  list: () => [...policyKeys.all, 'list'] as const,
  impact: (id: string) => [...policyKeys.all, 'impact', id] as const,
};

// ── Fetch functions ──────────────────────────────────────────────

export async function fetchPolicies(): Promise<Policy[]> {
  const { data } = await axiosInstance.get(API);
  return (data ?? []).map(normalizePolicy);
}

export async function fetchPolicyImpact(policyId: string): Promise<number> {
  const { data } = await axiosInstance.get(`${API}/${policyId}/impact`);
  return data?.matchedCount ?? 0;
}

export async function togglePolicy(policyId: string): Promise<void> {
  await axiosInstance.patch(`${API}/${policyId}/toggle`);
}

/**
 * Puts a draft live (segregation of duties): 403 for the last editor of its conditions, actions or
 * role bundle, or for a policy never so edited its creator; 400 for an active or testing policy.
 */
export async function activatePolicy(policyId: string): Promise<void> {
  await axiosInstance.post(`${API}/${policyId}/activate`);
}

export async function deletePolicy(policyId: string): Promise<void> {
  await axiosInstance.delete(`${API}/${policyId}`);
}

export async function duplicatePolicy(policy: Policy): Promise<void> {
  const {
    id: _id,
    createdAt: _ca,
    updatedAt: _ua,
    totalExecutions: _te,
    lastTriggered: _lt,
    ...rest
  } = policy;
  await axiosInstance.post(API, {
    ...rest,
    name: `${policy.name} (Copy)`,
    status: 'draft' as PolicyStatus,
    totalExecutions: 0,
    affectedUsers: 0,
  });
}

export async function updatePolicyPriority(policyId: string, priority: number): Promise<void> {
  await axiosInstance.patch(`${API}/${policyId}`, { priority });
}

// ── Hooks ────────────────────────────────────────────────────────

export function usePolicies() {
  return useQuery({
    queryKey: policyKeys.list(),
    queryFn: fetchPolicies,
  });
}

export function usePolicyImpactCounts(policyIds: string[]) {
  return useQueries({
    queries: policyIds.map((id) => ({
      queryKey: policyKeys.impact(id),
      queryFn: () => fetchPolicyImpact(id),
      staleTime: 60_000,
    })),
  });
}

export function useTogglePolicy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: togglePolicy,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: policyKeys.all });
    },
  });
}

export function useActivatePolicy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: activatePolicy,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: policyKeys.all });
    },
  });
}

export function useDeletePolicy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: deletePolicy,
    onSuccess: (_data, policyId) => {
      // Out of the list and its impact count gone first: refreshing every policy query would
      // refetch the deleted policy's impact, which the API answers with 404.
      queryClient.setQueryData<Policy[]>(policyKeys.list(), (policies) =>
        policies?.filter((policy) => policy.id !== policyId),
      );
      queryClient.removeQueries({ queryKey: policyKeys.impact(policyId) });
      queryClient.invalidateQueries({ queryKey: policyKeys.all });
    },
  });
}

export function useDuplicatePolicy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: duplicatePolicy,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: policyKeys.all });
    },
  });
}

export function useUpdatePolicyPriority() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ policyId, priority }: { policyId: string; priority: number }) =>
      updatePolicyPriority(policyId, priority),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: policyKeys.all });
    },
  });
}

// ── Studio mutations ────────────────────────────────────────────

export async function simulatePolicy(payload: { policyId?: string; policy?: Partial<Policy> }) {
  const { data } = await axiosInstance.post(`${API}/simulate`, payload);
  return data;
}

export async function createPolicy(policy: Partial<Policy>): Promise<Policy> {
  const { data } = await axiosInstance.post(API, policy);
  return normalizePolicy(data);
}

export async function updatePolicy(id: string, policy: Partial<Policy>): Promise<Policy> {
  const { data } = await axiosInstance.patch(`${API}/${id}`, policy);
  return normalizePolicy(data);
}

export function useSimulatePolicy() {
  return useMutation({
    mutationFn: simulatePolicy,
  });
}

export function useCreatePolicy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createPolicy,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: policyKeys.all });
    },
  });
}

export function useUpdatePolicy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, policy }: { id: string; policy: Partial<Policy> }) =>
      updatePolicy(id, policy),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: policyKeys.all });
    },
  });
}
