/**
 * Expired access of one identity that the hourly expiry run could not remove, and the actions
 * on it: retry (operator; the next run tries again) and removed manually (policy-admin; closes
 * the entry).
 * Backend: `modules/identity` (IdentityAccessExpiryController); the entries come from
 * GET /identity/v2/:id.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { axiosInstance } from '@api/data';
import { API_BASE } from '@api/constants';
import type { IProvisioningEntry } from '../interfaces';

const identityUrl = (identityId: string) =>
  `${API_BASE}/identity/${encodeURIComponent(identityId)}`;

export const expiredAccessKeys = {
  provisioning: (identityId: string) => ['identity', 'provisioning', identityId] as const,
};

/** The identity's provisioning entries. */
export async function fetchProvisioning(identityId: string): Promise<IProvisioningEntry[]> {
  const { data } = await axiosInstance.get<{
    found: boolean;
    identity: { provisioning?: IProvisioningEntry[] } | null;
  }>(`${API_BASE}/identity/v2/${encodeURIComponent(identityId)}`);
  const entries = data?.identity?.provisioning;
  return Array.isArray(entries) ? entries : [];
}

const time = (iso?: string) => (iso ? new Date(iso).getTime() : NaN);

/**
 * Entries whose expired access the run could not remove: not DEPROVISIONED, with a failure for
 * the entry's current expiry date (one for an earlier date no longer applies), as the backend
 * judges it.
 */
export function failedExpiries(entries: IProvisioningEntry[]): IProvisioningEntry[] {
  return entries.filter(
    (e) =>
      e.status !== 'DEPROVISIONED' &&
      !!e.expiryFailure &&
      time(e.expiryFailure.expiresAt) === time(e.expiresAt),
  );
}

export function useFailedExpiries(identityId: string) {
  return useQuery({
    queryKey: expiredAccessKeys.provisioning(identityId),
    queryFn: () => fetchProvisioning(identityId),
    select: failedExpiries,
    enabled: !!identityId,
  });
}

/** After an action: this identity's entries and the identity documents (prefix keys). */
function useInvalidate(identityId: string) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: expiredAccessKeys.provisioning(identityId) });
    void qc.invalidateQueries({ queryKey: ['identity', 'v2'] });
  };
}

/** Clear the entry's expiry failure: the next hourly run tries to remove the access again. */
export function useRetryExpiry(identityId: string) {
  const invalidate = useInvalidate(identityId);
  return useMutation({
    mutationFn: async (targetSystem: string) => {
      const { data } = await axiosInstance.post<IProvisioningEntry>(
        `${identityUrl(identityId)}/access/expiry/retry`,
        { targetSystem },
      );
      return data;
    },
    onSuccess: invalidate,
  });
}

/** Close the entry: the admin removed the access in the target by hand (note required, audited). */
export function useMarkExpiryRemovedManually(identityId: string) {
  const invalidate = useInvalidate(identityId);
  return useMutation({
    mutationFn: async (vars: { targetSystem: string; reason: string }) => {
      const { data } = await axiosInstance.post<IProvisioningEntry>(
        `${identityUrl(identityId)}/access/expiry/removed-manually`,
        vars,
      );
      return data;
    },
    onSuccess: invalidate,
  });
}
