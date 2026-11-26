/**
 * HR joiners API: batches an HR sync paused above the mass-joiner limit (approve / reject) and the
 * tenant mass-joiner policy. Backend: `modules/joiners` JoinersController (policy-admin and
 * super-admin).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { axiosInstance } from '@api/data';
import { API_BASE } from '@api/constants';
import type {
  IJoinerBatch,
  IJoinerPolicy,
  IJoinerPolicySettings,
  JoinerBatchStatus,
} from '../interfaces';

const JOINERS_API = `${API_BASE}/joiners`;

export const joinerKeys = {
  all: ['hr-joiners'] as const,
  batches: (status?: JoinerBatchStatus) => [...joinerKeys.all, 'batches', status ?? 'all'] as const,
  policy: () => [...joinerKeys.all, 'policy'] as const,
};

export function useJoinerBatches(status?: JoinerBatchStatus) {
  return useQuery({
    queryKey: joinerKeys.batches(status),
    queryFn: async () => {
      const { data } = await axiosInstance.get<IJoinerBatch[]>(`${JOINERS_API}/batches`, {
        params: status ? { status } : undefined,
      });
      return Array.isArray(data) ? data : [];
    },
  });
}

export function useDecideJoinerBatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: {
      batchId: string;
      decision: 'approve' | 'reject';
      comment?: string;
    }) => {
      const body = vars.comment ? { comment: vars.comment } : {};
      const { data } = await axiosInstance.post<IJoinerBatch>(
        `${JOINERS_API}/batches/${encodeURIComponent(vars.batchId)}/${vars.decision}`,
        body,
      );
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: joinerKeys.all }),
  });
}

export function useJoinerPolicy() {
  return useQuery({
    queryKey: joinerKeys.policy(),
    queryFn: async () => {
      const { data } = await axiosInstance.get<IJoinerPolicy>(`${JOINERS_API}/policy`);
      return data;
    },
  });
}

export function useUpdateJoinerPolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (policy: IJoinerPolicySettings) => {
      const { data } = await axiosInstance.put<IJoinerPolicy>(`${JOINERS_API}/policy`, policy);
      return data;
    },
    onSuccess: (data) => qc.setQueryData(joinerKeys.policy(), data),
  });
}
