/**
 * HR movers API: batches an HR sync paused above the mass-mover limit (approve / reject) and the
 * tenant mass-mover policy. Backend: `modules/mover` HrMoversController (policy-admin and
 * super-admin).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { axiosInstance } from '@api/data';
import { API_BASE } from '@api/constants';
import type {
  IMoverBatch,
  IMoverPolicy,
  IMoverPolicySettings,
  MoverBatchStatus,
} from '../interfaces';

const MOVERS_API = `${API_BASE}/movers`;

export const moverKeys = {
  all: ['hr-movers'] as const,
  batches: (status?: MoverBatchStatus) => [...moverKeys.all, 'batches', status ?? 'all'] as const,
  policy: () => [...moverKeys.all, 'policy'] as const,
};

export function useMoverBatches(status?: MoverBatchStatus) {
  return useQuery({
    queryKey: moverKeys.batches(status),
    queryFn: async () => {
      const { data } = await axiosInstance.get<IMoverBatch[]>(`${MOVERS_API}/batches`, {
        params: status ? { status } : undefined,
      });
      return Array.isArray(data) ? data : [];
    },
  });
}

export function useDecideMoverBatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: {
      batchId: string;
      decision: 'approve' | 'reject';
      comment?: string;
    }) => {
      const body = vars.comment ? { comment: vars.comment } : {};
      const { data } = await axiosInstance.post<IMoverBatch>(
        `${MOVERS_API}/batches/${encodeURIComponent(vars.batchId)}/${vars.decision}`,
        body,
      );
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: moverKeys.all }),
  });
}

export function useMoverPolicy() {
  return useQuery({
    queryKey: moverKeys.policy(),
    queryFn: async () => {
      const { data } = await axiosInstance.get<IMoverPolicy>(`${MOVERS_API}/policy`);
      return data;
    },
  });
}

export function useUpdateMoverPolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (policy: IMoverPolicySettings) => {
      const { data } = await axiosInstance.put<IMoverPolicy>(`${MOVERS_API}/policy`, policy);
      return data;
    },
    onSuccess: (data) => qc.setQueryData(moverKeys.policy(), data),
  });
}
