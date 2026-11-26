/**
 * Admin users API (backend `modules/auth`, `auth-local.controller.ts` and `invite.controller.ts`):
 * the console sign-ins of the caller's tenant and its pending invites. Every route needs
 * super-admin and takes the admin's (or invite's) `id`.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { axiosInstance } from '@api/data';
import { API_BASE } from '@api/constants';
import type {
  AdminRole,
  IAdminInvite,
  IAdminInviteCreate,
  IAdminUser,
  IPasswordResetCode,
  IPendingInvite,
} from '../interfaces';

const AUTH_API = `${API_BASE}/auth`;

export const adminUserKeys = {
  all: ['admin-users'] as const,
  list: () => [...adminUserKeys.all, 'list'] as const,
  invites: () => [...adminUserKeys.all, 'invites'] as const,
};

/** The tenant's admins, sorted by email. */
export function useAdminUsers(enabled = true) {
  return useQuery({
    queryKey: adminUserKeys.list(),
    queryFn: async () => {
      const { data } = await axiosInstance.get<IAdminUser[]>(`${AUTH_API}/users`);
      return Array.isArray(data) ? data : [];
    },
    enabled,
  });
}

/** The tenant's unused, unexpired invites, newest first. Never their codes. */
export function usePendingInvites(enabled = true) {
  return useQuery({
    queryKey: adminUserKeys.invites(),
    queryFn: async () => {
      const { data } = await axiosInstance.get<IPendingInvite[]>(`${AUTH_API}/invites`);
      return Array.isArray(data) ? data : [];
    },
    enabled,
  });
}

/** Every change reloads the admins and the invites (prefix key). */
function useAdminUserMutation<TVars, TResult>(mutationFn: (vars: TVars) => Promise<TResult>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn,
    onSettled: () => qc.invalidateQueries({ queryKey: adminUserKeys.all }),
  });
}

/**
 * Creates an invite in the caller's tenant, valid 72 hours, single use. The answer carries the
 * invite code once; nothing mails it. The pending invites reload.
 */
export function useInviteAdmin() {
  return useAdminUserMutation(async (body: IAdminInviteCreate) => {
    const { data } = await axiosInstance.post<IAdminInvite>(`${AUTH_API}/invites`, body);
    return data;
  });
}

/** Cancels a pending invite: its code no longer registers anyone. */
export function useCancelInvite() {
  return useAdminUserMutation(async (id: string) => {
    await axiosInstance.delete(`${AUTH_API}/invites/${encodeURIComponent(id)}`);
  });
}

/** Ends every session of the admin (token version bumped, refresh token dropped). */
export function useRevokeAdminSessions() {
  return useAdminUserMutation(async (id: string) => {
    await axiosInstance.post(`${AUTH_API}/revoke/${encodeURIComponent(id)}`);
  });
}

/** Deactivates (also ends every session) or reactivates an admin. */
export function useSetAdminActive() {
  return useAdminUserMutation(async ({ id, isActive }: { id: string; isActive: boolean }) => {
    const { data } = await axiosInstance.patch(`${AUTH_API}/users/${encodeURIComponent(id)}`, {
      isActive,
    });
    return data;
  });
}

/**
 * Issues a one-time password reset code for an admin; the answer carries it once. Nothing in the
 * list changes until the admin uses it, so nothing reloads.
 */
export function useIssuePasswordReset() {
  return useMutation({
    mutationFn: async (id: string) => {
      const { data } = await axiosInstance.post<IPasswordResetCode>(
        `${AUTH_API}/users/${encodeURIComponent(id)}/password-reset`,
      );
      return data;
    },
  });
}

/** Gives an admin another tenant role, from their next request on; their sessions stay. */
export function useChangeAdminRole() {
  return useAdminUserMutation(async ({ id, role }: { id: string; role: AdminRole }) => {
    const { data } = await axiosInstance.patch(`${AUTH_API}/users/${encodeURIComponent(id)}`, {
      role,
    });
    return data;
  });
}
