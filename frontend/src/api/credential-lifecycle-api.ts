/**
 * Credential lifecycle API (backend `modules/credential-lifecycle`). The inventory routes (a
 * person's credentials, the due list, one status) need operator; the compliance summary and the
 * policies policy-admin. The nightly credential rotation run writes the inventory; nothing here
 * changes a password. Lists answer plain arrays without paging, cut at `limit`.
 */
import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { axiosInstance } from '@api/data';
import { API_BASE } from '@api/constants';
import type {
  CredentialStatus,
  ICredentialCompliance,
  ICredentialPolicy,
  ICredentialPolicyBody,
  ICredentialRecord,
} from '../interfaces';

const CREDENTIALS_API = `${API_BASE}/credential-lifecycle`;

/** Rows a list asks for (the backend allows up to 1000). The list says when it was cut. */
export const CREDENTIAL_LIST_LIMIT = 500;

export const credentialKeys = {
  all: ['credential-lifecycle'] as const,
  due: (daysAhead: number) => [...credentialKeys.all, 'due', daysAhead] as const,
  status: (status: CredentialStatus) => [...credentialKeys.all, 'status', status] as const,
  identity: (identityId: string) => [...credentialKeys.all, 'identity', identityId] as const,
  compliance: () => [...credentialKeys.all, 'compliance'] as const,
  policies: () => [...credentialKeys.all, 'policies'] as const,
};

const rows = <T>(data: unknown): T[] => (Array.isArray(data) ? (data as T[]) : []);

/** Due within `daysAhead` days, overdue included, earliest first (GET /expiring). */
export function useDueCredentials(daysAhead: number) {
  return useQuery({
    queryKey: credentialKeys.due(daysAhead),
    queryFn: async () => {
      const { data } = await axiosInstance.get(`${CREDENTIALS_API}/expiring`, {
        params: { daysAhead, limit: CREDENTIAL_LIST_LIMIT },
      });
      return rows<ICredentialRecord>(data);
    },
    placeholderData: keepPreviousData,
  });
}

/** The credentials in one status (GET /inventory?status=), e.g. UNKNOWN with the reason. */
export function useCredentialsByStatus(status: CredentialStatus) {
  return useQuery({
    queryKey: credentialKeys.status(status),
    queryFn: async () => {
      const { data } = await axiosInstance.get(`${CREDENTIALS_API}/inventory`, {
        params: { status, limit: CREDENTIAL_LIST_LIMIT },
      });
      return rows<ICredentialRecord>(data);
    },
  });
}

/** One identity's credentials, one row per system (GET /inventory/:identityId). */
export function useIdentityCredentials(identityId: string | undefined) {
  return useQuery({
    queryKey: credentialKeys.identity(identityId ?? ''),
    queryFn: async () => {
      const { data } = await axiosInstance.get(
        `${CREDENTIALS_API}/inventory/${encodeURIComponent(identityId as string)}`,
      );
      return rows<ICredentialRecord>(data);
    },
    enabled: !!identityId,
  });
}

/** Policy-admin: rows per status. */
export function useCredentialCompliance(enabled: boolean) {
  return useQuery({
    queryKey: credentialKeys.compliance(),
    queryFn: async () => {
      const { data } = await axiosInstance.get<ICredentialCompliance>(
        `${CREDENTIALS_API}/compliance`,
      );
      return data;
    },
    enabled,
  });
}

/** Policy-admin: every credential policy of the tenant. */
export function useCredentialPolicies(enabled: boolean) {
  return useQuery({
    queryKey: credentialKeys.policies(),
    queryFn: async () => {
      const { data } = await axiosInstance.get(`${CREDENTIALS_API}/policies`);
      return rows<ICredentialPolicy>(data);
    },
    enabled,
  });
}

/** Every policy change reloads the page's data by the prefix key, also after a failure. */
function usePolicyMutation<T>(mutationFn: (vars: T) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn,
    onSettled: () => qc.invalidateQueries({ queryKey: credentialKeys.all }),
  });
}

export function useCreateCredentialPolicy() {
  return usePolicyMutation(async (body: ICredentialPolicyBody) => {
    const { data } = await axiosInstance.post<ICredentialPolicy>(
      `${CREDENTIALS_API}/policies`,
      body,
    );
    return data;
  });
}

export function useUpdateCredentialPolicy() {
  return usePolicyMutation(
    async ({ id, changes }: { id: string; changes: ICredentialPolicyBody }) => {
      const { data } = await axiosInstance.patch<ICredentialPolicy>(
        `${CREDENTIALS_API}/policies/${encodeURIComponent(id)}`,
        changes,
      );
      return data;
    },
  );
}

/** Deletes the policy for good. */
export function useDeleteCredentialPolicy() {
  return usePolicyMutation(async (id: string) => {
    await axiosInstance.delete(`${CREDENTIALS_API}/policies/${encodeURIComponent(id)}`);
  });
}
