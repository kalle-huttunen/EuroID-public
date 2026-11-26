/**
 * Privileged Access API — linked admin accounts
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { axiosInstance } from '@api/data';
import { API_BASE } from '@api/constants';
import { POLL_INTERVALS } from '@config/polling';

export const privilegedAccessKeys = {
  all: ['privileged-access'] as const,
  adminAccounts: () => [...privilegedAccessKeys.all, 'admin-accounts'] as const,
  linkedAccounts: (parentId: string) => [...privilegedAccessKeys.all, 'linked', parentId] as const,
};

/**
 * The privileged session of a linked admin account: PENDING (never activated), ACTIVATING (its
 * accounts are being enabled in the target systems), ACTIVE (enabled until `expiresAt`), INACTIVE.
 */
export type AdminSessionStatus = 'PENDING' | 'ACTIVATING' | 'ACTIVE' | 'INACTIVE';

/** The session fields both lists carry. */
export interface AdminSessionFields {
  status: AdminSessionStatus | string;
  activatedAt?: string;
  expiresAt?: string;
  /** Why the last activation failed (nothing stayed enabled). */
  activationError?: string;
  /** Why disabling the accounts failed (they may still be enabled; retried hourly). */
  disableError?: string;
}

export interface LinkedAdminAccount extends AdminSessionFields {
  identityId: string;
  adminTier: string;
  deactivatedAt?: string;
}

export interface AdminAccountRow extends AdminSessionFields {
  adminIdentityId: string;
  adminEmail: string;
  parentIdentityId: string;
  parentEmail: string;
  adminTier: string;
  /** The parent identity is deleted or gone: the API refuses activation (409), deactivation works. */
  parentDeleted?: boolean;
}

/** PUT .../activate: 200 ACTIVE once every account is enabled, 202 ACTIVATING when it takes longer. */
export type AdminActivationResult =
  | { state: 'ACTIVE'; expiresAt: string }
  | { state: 'ACTIVATING' };

/** PUT .../deactivate: 200 INACTIVE (PENDING if never active), 202 DEACTIVATING. */
export interface AdminDeactivationResult {
  state: 'INACTIVE' | 'PENDING' | 'DEACTIVATING';
}

/** While a session is being enabled, the lists are read again until it knows its outcome. */
const pollWhileActivating = (rows: AdminSessionFields[] | undefined) =>
  rows?.some((r) => r.status === 'ACTIVATING') ? POLL_INTERVALS.PAM_SESSION_MS : false;

export async function fetchAllAdminAccounts(): Promise<AdminAccountRow[]> {
  const res = await axiosInstance.get(`${API_BASE}/privileged-access/admin-accounts`);
  return res.data ?? [];
}

export async function fetchLinkedAdminAccounts(parentId: string): Promise<LinkedAdminAccount[]> {
  const res = await axiosInstance.get(`${API_BASE}/privileged-access/${parentId}/admin-accounts`);
  return res.data ?? [];
}

export async function createLinkedAdminAccount(
  parentId: string,
  adminTier: string,
): Promise<unknown> {
  const res = await axiosInstance.post(`${API_BASE}/privileged-access/${parentId}/admin-accounts`, {
    adminTier,
  });
  return res.data;
}

export async function activateAdminAccount(adminId: string): Promise<AdminActivationResult> {
  const res = await axiosInstance.put(
    `${API_BASE}/privileged-access/admin-accounts/${adminId}/activate`,
  );
  return res.data;
}

export async function deactivateAdminAccount(adminId: string): Promise<AdminDeactivationResult> {
  const res = await axiosInstance.put(
    `${API_BASE}/privileged-access/admin-accounts/${adminId}/deactivate`,
  );
  return res.data;
}

export function useAllAdminAccounts() {
  return useQuery({
    queryKey: privilegedAccessKeys.adminAccounts(),
    queryFn: fetchAllAdminAccounts,
    refetchInterval: (query) => pollWhileActivating(query.state.data),
  });
}

export function useLinkedAdminAccounts(parentId: string | undefined) {
  return useQuery({
    queryKey: privilegedAccessKeys.linkedAccounts(parentId ?? ''),
    queryFn: () => fetchLinkedAdminAccounts(parentId!),
    enabled: !!parentId,
    refetchInterval: (query) => pollWhileActivating(query.state.data),
  });
}

export function useCreateLinkedAdminAccount(parentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (adminTier: string) => createLinkedAdminAccount(parentId, adminTier),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: privilegedAccessKeys.all });
    },
  });
}

export function useActivateAdminAccount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: activateAdminAccount,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: privilegedAccessKeys.all });
    },
  });
}

export function useDeactivateAdminAccount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: deactivateAdminAccount,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: privilegedAccessKeys.all });
    },
  });
}
