/**
 * Non-human identities API (backend `modules/nhi`). List and read need viewer; create, delegate,
 * revoke, the kill switch (and their dry run), issuing a credential and the signing status need
 * super-admin. Every route takes the agent's `agentId` slug. Every change reloads the page's data
 * by the prefix key.
 *
 * An issued credential is a bearer secret, so `issueAgentCredential` is a plain call: no query or
 * mutation cache keeps it. The caller holds it in component state and drops it on close.
 */
import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { axiosInstance } from '@api/data';
import { API_BASE } from '@api/constants';
import { PAGE_SIZES } from '@config/pagination';
import type {
  IAgentCredential,
  IAgentFilter,
  IAgentIdentity,
  IAgentIdentityPage,
  ICreateAgentBody,
  IEndAgentPreview,
} from '../interfaces';

const NHI_API = `${API_BASE}/nhi`;

/** Rows per page (the backend's default; it allows up to 100). */
export const NHI_PAGE_SIZE = PAGE_SIZES.LARGE;

const agentPath = (agentId: string) => `${NHI_API}/${encodeURIComponent(agentId)}`;

export const nhiKeys = {
  all: ['nhi'] as const,
  list: (filter: IAgentFilter, page: number) =>
    [
      ...nhiKeys.all,
      'list',
      filter.kind ?? 'all',
      filter.status ?? 'all',
      filter.riskTier ?? 'all',
      filter.ownerIdentityId ?? '',
      filter.ownerless ? 'ownerless' : 'any-owner',
      page,
    ] as const,
  detail: (agentId: string) => [...nhiKeys.all, 'detail', agentId] as const,
  preview: (agentId: string, action: EndAction) =>
    [...nhiKeys.all, 'preview', action, agentId] as const,
  signing: () => [...nhiKeys.all, 'signing-status'] as const,
};

function asPage(data: unknown): IAgentIdentityPage {
  const page = data as Partial<IAgentIdentityPage> | undefined;
  const rows = Array.isArray(page?.data) ? page.data : [];
  return { data: rows, total: typeof page?.total === 'number' ? page.total : rows.length };
}

async function fetchAgents(
  filter: IAgentFilter,
  page: number,
  limit: number,
): Promise<IAgentIdentityPage> {
  const { data } = await axiosInstance.get(NHI_API, {
    params: {
      ...(filter.kind ? { kind: filter.kind } : {}),
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.riskTier ? { riskTier: filter.riskTier } : {}),
      ...(filter.ownerIdentityId ? { ownerIdentityId: filter.ownerIdentityId } : {}),
      ...(filter.ownerless ? { ownerless: true } : {}),
      page,
      limit,
    },
  });
  return asPage(data);
}

/** One page (1-based), newest first. */
export function useAgents(filter: IAgentFilter, page: number) {
  return useQuery({
    queryKey: nhiKeys.list(filter, page),
    queryFn: () => fetchAgents(filter, page, NHI_PAGE_SIZE),
    placeholderData: keepPreviousData,
  });
}

/** GET /nhi/:agentId: the detail modal re-reads the agent it opened from. */
export function useAgent(agentId: string | undefined) {
  return useQuery({
    queryKey: nhiKeys.detail(agentId ?? ''),
    queryFn: async () => {
      const { data } = await axiosInstance.get<IAgentIdentity>(agentPath(agentId as string));
      return data;
    },
    enabled: !!agentId,
  });
}

export type EndAction = 'revoke' | 'kill';

/**
 * The dry run of a revoke or kill switch (POST /nhi/:agentId/revoke|kill?dryRun=true): the
 * delegated agents the API's cascade would reach, walked as the real call walks them; nothing
 * changes. Each opening of the confirmation asks afresh and nothing is kept after it closes.
 */
export function useEndAgentPreview(agentId: string, action: EndAction, enabled = true) {
  return useQuery({
    queryKey: nhiKeys.preview(agentId, action),
    enabled,
    queryFn: async () => {
      const { data } = await axiosInstance.post<IEndAgentPreview>(
        `${agentPath(agentId)}/${action}`,
        {},
        { params: { dryRun: true } },
      );
      return data;
    },
    staleTime: 0,
    gcTime: 0,
  });
}

/** Super-admin: whether the API holds a signing key (NHI_SIGNING_PRIVATE_KEY). */
export function useCredentialSigningStatus(enabled: boolean) {
  return useQuery({
    queryKey: nhiKeys.signing(),
    queryFn: async () => {
      const { data } = await axiosInstance.get<{ enabled: boolean }>(
        `${NHI_API}/_/credential-signing-status`,
      );
      return data;
    },
    enabled,
  });
}

/** Every change reloads the list, the detail and the preview, also after a refusal. */
function useAgentMutation<T>(mutationFn: (vars: T) => Promise<IAgentIdentity>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn,
    onSettled: () => qc.invalidateQueries({ queryKey: nhiKeys.all }),
  });
}

export function useCreateAgent() {
  return useAgentMutation(async (body: ICreateAgentBody) => {
    const { data } = await axiosInstance.post<IAgentIdentity>(NHI_API, body);
    return data;
  });
}

/** A sub-agent of `parentAgentId`: its scope a subset of the parent's, its expiry no later. */
export function useDelegateAgent() {
  return useAgentMutation(
    async ({ parentAgentId, body }: { parentAgentId: string; body: ICreateAgentBody }) => {
      const { data } = await axiosInstance.post<IAgentIdentity>(
        `${agentPath(parentAgentId)}/delegate`,
        body,
      );
      return data;
    },
  );
}

/** Revoke (`revoke`) or the kill switch (`kill`): terminal, cascades to active children. */
export function useEndAgent(action: EndAction) {
  return useAgentMutation(async ({ agentId, reason }: { agentId: string; reason: string }) => {
    const { data } = await axiosInstance.post<IAgentIdentity>(`${agentPath(agentId)}/${action}`, {
      reason,
    });
    return data;
  });
}

/** POST /nhi/:agentId/owner: a new owner (an active person), which ends the ownerless state. */
export function useReownAgent() {
  return useAgentMutation(
    async ({ agentId, ownerIdentityId }: { agentId: string; ownerIdentityId: string }) => {
      const { data } = await axiosInstance.post<IAgentIdentity>(`${agentPath(agentId)}/owner`, {
        ownerIdentityId,
      });
      return data;
    },
  );
}

/** Issues a credential valid for `ttlSeconds` (at most 3600, never past the agent's expiry). */
export async function issueAgentCredential(
  agentId: string,
  ttlSeconds: number,
): Promise<IAgentCredential> {
  const { data } = await axiosInstance.post<IAgentCredential>(`${agentPath(agentId)}/credentials`, {
    ttlSeconds,
  });
  return data;
}
