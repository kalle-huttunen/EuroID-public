import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { axiosInstance } from './data';
import { API_BASE } from './constants';
import type { DefaultMasteryView, IReconciliationConfig } from '../interfaces';

export const RECON_CONFIG_KEY = ['reconciliation-config'] as const;

/** `enabled` false asks nothing: for a role the endpoint refuses (it needs policy-admin). */
export function useReconciliationConfig(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: RECON_CONFIG_KEY,
    queryFn: async () => {
      const { data } = await axiosInstance.get(`${API_BASE}/admin/reconciliation-config`);
      return data as { configured: boolean; config: IReconciliationConfig | null };
    },
    enabled: options?.enabled ?? true,
  });
}

/**
 * The tenant's default mastery, the owners reconcile uses for a field the Brain sets no owner
 * for. `canRead`: the user holds policy-admin, which GET /admin/reconciliation-config requires.
 */
export function useDefaultMastery(canRead: boolean): DefaultMasteryView {
  const { data, isError } = useReconciliationConfig({ enabled: canRead });
  if (!canRead || isError) return { state: 'unreadable' };
  if (!data) return { state: 'loading' };
  return data.config
    ? { state: 'loaded', mastery: data.config.defaultMastery ?? {} }
    : { state: 'unconfigured' };
}

export function useUpsertReconciliationConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (
      payload: Omit<IReconciliationConfig, '_id' | 'tenantId' | 'createdAt' | 'updatedAt'>,
    ) => {
      const { data } = await axiosInstance.put(`${API_BASE}/admin/reconciliation-config`, payload);
      return data as { success: boolean; config: IReconciliationConfig };
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: RECON_CONFIG_KEY }),
  });
}
