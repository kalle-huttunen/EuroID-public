/**
 * Access explorer API (backend `modules/access-explorer`): an identity's access graph, an
 * entitlement's holders, the shortest access path and the SoD violations through nested groups
 * (viewer); loading the graph from MongoDB (super-admin). Every route answers 503 with a message
 * when the graph store is not available: `isGraphUnavailable` tells that answer apart, and it is
 * not retried. Identities are keyed by `_id`, entitlements by their native id.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { axiosInstance } from '@api/data';
import { API_BASE } from '@api/constants';
import type {
  IAccessPathResult,
  IEntitlementHolders,
  IGraphResyncResult,
  IGraphSodViolations,
  IIdentityAccessGraph,
} from '../interfaces';

const EXPLORER_API = `${API_BASE}/access-explorer`;
const enc = encodeURIComponent;

export const accessExplorerKeys = {
  all: ['access-explorer'] as const,
  graph: (identityId: string) => [...accessExplorerKeys.all, 'graph', identityId] as const,
  holders: (entitlementId: string) =>
    [...accessExplorerKeys.all, 'holders', entitlementId] as const,
  path: (identityId: string, entitlementId: string) =>
    [...accessExplorerKeys.all, 'path', identityId, entitlementId] as const,
  sod: (identityId: string) => [...accessExplorerKeys.all, 'sod', identityId] as const,
};

/** The 503 every explorer route answers when Neo4j is not configured, not connected or fails. */
export function isGraphUnavailable(error: unknown): boolean {
  return (error as { response?: { status?: number } } | null)?.response?.status === 503;
}

/** A 503 says what an administrator must do; asking again does not help. */
const retry = (failureCount: number, error: unknown) =>
  !isGraphUnavailable(error) && failureCount < 2;

async function get<T>(url: string, params?: Record<string, string>): Promise<T> {
  const { data } = await axiosInstance.get<T>(url, params ? { params } : undefined);
  return data;
}

export function useIdentityAccessGraph(identityId: string | undefined) {
  return useQuery({
    queryKey: accessExplorerKeys.graph(identityId ?? ''),
    queryFn: () => get<IIdentityAccessGraph>(`${EXPLORER_API}/identity/${enc(identityId!)}/graph`),
    enabled: !!identityId,
    retry,
  });
}

export function useEntitlementHolders(entitlementId: string | undefined) {
  return useQuery({
    queryKey: accessExplorerKeys.holders(entitlementId ?? ''),
    queryFn: () =>
      get<IEntitlementHolders>(`${EXPLORER_API}/entitlement/${enc(entitlementId!)}/holders`),
    enabled: !!entitlementId,
    retry,
  });
}

export function useAccessPath(identityId: string | undefined, entitlementId: string | undefined) {
  return useQuery({
    queryKey: accessExplorerKeys.path(identityId ?? '', entitlementId ?? ''),
    queryFn: () =>
      get<IAccessPathResult>(`${EXPLORER_API}/path`, {
        fromIdentity: identityId!,
        toEntitlement: entitlementId!,
      }),
    enabled: !!identityId && !!entitlementId,
    retry,
  });
}

export function useGraphSodViolations(identityId: string | undefined) {
  return useQuery({
    queryKey: accessExplorerKeys.sod(identityId ?? ''),
    queryFn: () =>
      get<IGraphSodViolations>(`${EXPLORER_API}/identity/${enc(identityId!)}/sod-violations`),
    enabled: !!identityId,
    retry,
  });
}

/** POST /access-explorer/resync (super-admin); every explorer answer is read again after it. */
export function useGraphResync() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data } = await axiosInstance.post<IGraphResyncResult>(`${EXPLORER_API}/resync`);
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: accessExplorerKeys.all }),
  });
}
