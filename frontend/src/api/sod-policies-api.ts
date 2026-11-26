/**
 * Segregation-of-duties policies (backend `modules/policy/sod-policy.controller.ts`).
 * List: viewer. Create, update and delete: super-admin or policy-admin. Update changes only
 * severity, action and isActive; delete only sets isActive false (the policy stays listed).
 * The list answers every policy of the tenant, newest first, without paging.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { axiosInstance } from '@api/data';
import { API_BASE } from '@api/constants';
import type { ICreateSodPolicy, ISodPolicy, IUpdateSodPolicy } from '../interfaces';

const SOD_API = `${API_BASE}/sod-policies`;

export const sodPolicyKeys = {
  all: ['sod-policies'] as const,
  list: () => [...sodPolicyKeys.all, 'list'] as const,
};

export async function fetchSodPolicies(): Promise<ISodPolicy[]> {
  const { data } = await axiosInstance.get<ISodPolicy[]>(SOD_API);
  return Array.isArray(data) ? data : [];
}

export function useSodPolicies() {
  return useQuery({ queryKey: sodPolicyKeys.list(), queryFn: fetchSodPolicies });
}

/** Every mutation reloads the list by its prefix key, also after a failure. */
function useSodMutation<T>(mutationFn: (vars: T) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn,
    onSettled: () => qc.invalidateQueries({ queryKey: sodPolicyKeys.all }),
  });
}

export function useCreateSodPolicy() {
  return useSodMutation(async (body: ICreateSodPolicy) => {
    const { data } = await axiosInstance.post<ISodPolicy>(SOD_API, body);
    return data;
  });
}

export function useUpdateSodPolicy() {
  return useSodMutation(async ({ id, changes }: { id: string; changes: IUpdateSodPolicy }) => {
    const { data } = await axiosInstance.patch<ISodPolicy>(
      `${SOD_API}/${encodeURIComponent(id)}`,
      changes,
    );
    return data;
  });
}

/** Soft delete: the backend sets isActive false and keeps the policy. */
export function useDeleteSodPolicy() {
  return useSodMutation(async (id: string) => {
    await axiosInstance.delete(`${SOD_API}/${encodeURIComponent(id)}`);
  });
}
