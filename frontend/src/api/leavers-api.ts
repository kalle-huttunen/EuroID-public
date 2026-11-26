/**
 * HR leavers API: paused mass-leaver batches (approve / reject), offboardings that left a target
 * failed (close one as removed manually) and the tenant leaver policy.
 * Backend: `modules/leavers` (policy-admin and super-admin).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { axiosInstance } from '@api/data';
import { API_BASE } from '@api/constants';
import type {
  IFailedOffboarding,
  ILeaverBatch,
  ILeaverPolicy,
  ILeaverPolicySettings,
  LeaverBatchStatus,
} from '../interfaces';

const LEAVERS_API = `${API_BASE}/leavers`;

export const leaverKeys = {
  all: ['leavers'] as const,
  batches: (status?: LeaverBatchStatus) => [...leaverKeys.all, 'batches', status ?? 'all'] as const,
  policy: () => [...leaverKeys.all, 'policy'] as const,
  openOffboardings: () => [...leaverKeys.all, 'open-offboardings'] as const,
};

export async function fetchLeaverBatches(status?: LeaverBatchStatus): Promise<ILeaverBatch[]> {
  const { data } = await axiosInstance.get<ILeaverBatch[]>(`${LEAVERS_API}/batches`, {
    params: status ? { status } : undefined,
  });
  return Array.isArray(data) ? data : [];
}

export function useLeaverBatches(status?: LeaverBatchStatus) {
  return useQuery({
    queryKey: leaverKeys.batches(status),
    queryFn: () => fetchLeaverBatches(status),
  });
}

export function useDecideLeaverBatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: {
      batchId: string;
      decision: 'approve' | 'reject';
      comment?: string;
    }) => {
      const body = vars.comment ? { comment: vars.comment } : {};
      const { data } = await axiosInstance.post<ILeaverBatch>(
        `${LEAVERS_API}/batches/${encodeURIComponent(vars.batchId)}/${vars.decision}`,
        body,
      );
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: leaverKeys.all }),
  });
}

/**
 * Offboardings that left a target failed, newest first: HR leavers (batch members or not) and
 * users deleted by an operator.
 */
export function useOpenOffboardings() {
  return useQuery({
    queryKey: leaverKeys.openOffboardings(),
    queryFn: async () => {
      const { data } = await axiosInstance.get<IFailedOffboarding[]>(
        `${LEAVERS_API}/open-offboardings`,
      );
      return Array.isArray(data) ? data : [];
    },
  });
}

/**
 * Close a failed target of the offboarding `workflowId`: the admin removed the account by hand
 * (reason required, audited).
 */
export function useMarkRemovedManually() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { workflowId: string; system: string; reason: string }) => {
      const { data } = await axiosInstance.post<IFailedOffboarding>(
        `${LEAVERS_API}/offboardings/${encodeURIComponent(vars.workflowId)}/removed-manually`,
        { system: vars.system, reason: vars.reason },
      );
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: leaverKeys.all }),
  });
}

export function useLeaverPolicy() {
  return useQuery({
    queryKey: leaverKeys.policy(),
    queryFn: async () => {
      const { data } = await axiosInstance.get<ILeaverPolicy>(`${LEAVERS_API}/policy`);
      return data;
    },
  });
}

export function useUpdateLeaverPolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (policy: ILeaverPolicySettings) => {
      const { data } = await axiosInstance.put<ILeaverPolicy>(`${LEAVERS_API}/policy`, policy);
      return data;
    },
    onSuccess: (data) => qc.setQueryData(leaverKeys.policy(), data),
  });
}
