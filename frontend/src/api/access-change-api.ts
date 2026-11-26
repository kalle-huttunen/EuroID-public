/**
 * Access changes of one identity: the read-only preview of what re-evaluating its access would
 * add and remove, and the re-evaluation itself (starts the mover workflow; operator).
 * Backend: `modules/mover` (AccessReevaluationController).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { axiosInstance } from '@api/data';
import { API_BASE } from '@api/constants';
import type { IAccessPreview, IAccessReevaluation } from '../interfaces';

const accessUrl = (identityId: string) =>
  `${API_BASE}/identity/${encodeURIComponent(identityId)}/access`;

export const accessChangeKeys = {
  preview: (identityId: string) => ['identity', 'access-preview', identityId] as const,
};

export async function fetchAccessPreview(identityId: string): Promise<IAccessPreview> {
  const { data } = await axiosInstance.get<IAccessPreview>(`${accessUrl(identityId)}/preview`);
  return data;
}

/** The preview; loaded only while `enabled` (e.g. the confirmation modal is open). */
export function useAccessPreview(identityId: string, enabled: boolean) {
  return useQuery({
    queryKey: accessChangeKeys.preview(identityId),
    queryFn: () => fetchAccessPreview(identityId),
    enabled: enabled && !!identityId,
    retry: false,
  });
}

export function useReevaluateAccess(identityId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data } = await axiosInstance.post<IAccessReevaluation>(
        `${accessUrl(identityId)}/re-evaluate`,
        {},
      );
      return data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: accessChangeKeys.preview(identityId) });
      void qc.invalidateQueries({ queryKey: ['identity', 'entitlements', identityId] });
    },
  });
}
