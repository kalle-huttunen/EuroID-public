/**
 * Thin TanStack Query + axios adapter that replaces the handful of Refine hooks
 * we actually used (useList / useOne / useCreate / useUpdate / useDelete,
 * plus useInvalidate + useNotification). Keeps the `{ data: { data, total } }`
 * return shape so call sites barely change.
 *
 * Backend convention: `GET /api/v1/{resource}` returns an array (role-bundles)
 * or uses `_start` / `_end` for paginated lists (identity) and exposes
 * total count via the `X-Total-Count` header.
 */

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
} from '@tanstack/react-query';
import { App } from 'antd';
import { useMemo } from 'react';
import { axiosInstance } from './data';
import { API_BASE } from './constants';

// ── helpers ───────────────────────────────────────────────────────────────

function resourceUrl(resource: string, id?: string | number) {
  return id == null ? `${API_BASE}/${resource}` : `${API_BASE}/${resource}/${id}`;
}

function extractList<T>(raw: unknown): { data: T[]; total: number } {
  if (Array.isArray(raw)) return { data: raw as T[], total: raw.length };
  if (raw && typeof raw === 'object') {
    const obj = raw as { data?: unknown; user?: unknown; total?: number };
    const candidate = obj.data ?? obj.user;
    if (Array.isArray(candidate)) {
      return { data: candidate as T[], total: obj.total ?? candidate.length };
    }
  }
  return { data: [], total: 0 };
}

function buildListParams(pagination?: ListPagination) {
  if (!pagination) return undefined;
  const pageSize = pagination.pageSize ?? 10;
  const current = pagination.current ?? 1;
  const start = (current - 1) * pageSize;
  const end = start + pageSize;
  return { _start: start, _end: end };
}

// ── useList ────────────────────────────────────────────────────────────────

export interface ListPagination {
  current?: number;
  pageSize?: number;
}

export interface UseListArgs {
  resource: string;
  pagination?: ListPagination;
  queryOptions?: { enabled?: boolean };
}

export interface UseListResult<T> {
  data: { data: T[]; total: number } | undefined;
  isLoading: boolean;
  isPending: boolean;
  refetch: () => Promise<unknown>;
}

export function useList<T = unknown>({
  resource,
  pagination,
  queryOptions,
}: UseListArgs): UseListResult<T> {
  const params = buildListParams(pagination);
  const query = useQuery({
    queryKey: ['resource', resource, 'list', params ?? null],
    queryFn: async () => {
      const res = await axiosInstance.get(resourceUrl(resource), {
        params,
      });
      const total = Number(res.headers?.['x-total-count'] ?? NaN);
      const extracted = extractList<T>(res.data);
      return Number.isFinite(total)
        ? { data: extracted.data, total }
        : extracted;
    },
    enabled: queryOptions?.enabled ?? true,
  });

  return {
    data: query.data,
    isLoading: query.isLoading,
    isPending: query.isPending,
    refetch: query.refetch,
  };
}

// ── useOne ─────────────────────────────────────────────────────────────────

export interface UseOneArgs {
  resource: string;
  id: string | number | undefined;
  queryOptions?: { enabled?: boolean };
}

export interface UseOneResult<T> {
  data: { data: T } | undefined;
  isLoading: boolean;
  refetch: () => Promise<unknown>;
}

export function useOne<T = unknown>({
  resource,
  id,
  queryOptions,
}: UseOneArgs): UseOneResult<T> {
  const query = useQuery({
    queryKey: ['resource', resource, 'one', id ?? null],
    queryFn: async () => {
      const res = await axiosInstance.get(resourceUrl(resource, id));
      const payload = (res.data && typeof res.data === 'object' && 'data' in res.data
        ? (res.data as { data: T }).data
        : (res.data as T));
      return { data: payload };
    },
    enabled: (queryOptions?.enabled ?? true) && id != null,
  });
  return { data: query.data, isLoading: query.isLoading, refetch: query.refetch };
}

// ── mutation hooks ─────────────────────────────────────────────────────────

interface CreateVars {
  resource: string;
  values: unknown;
}

interface UpdateVars {
  resource: string;
  id: string | number;
  values: unknown;
}

interface DeleteVars {
  resource: string;
  id: string | number;
}

type MutationOpts<TVars> = {
  onSuccess?: (data: unknown, variables: TVars) => void;
  onError?: (error: Error, variables: TVars) => void;
};

type ResourceMutation<TVars> = UseMutationResult<unknown, Error, TVars> & {
  /** Refine v4 compatibility alias for `isPending`. */
  isLoading: boolean;
  /** Refine-flavoured signature: mutate(vars, { onSuccess, onError }). */
  mutate: (vars: TVars, options?: MutationOpts<TVars>) => void;
};

function invalidateResource(
  queryClient: ReturnType<typeof useQueryClient>,
  resource: string,
) {
  void queryClient.invalidateQueries({ queryKey: ['resource', resource] });
}

export function useCreate(): ResourceMutation<CreateVars> {
  const queryClient = useQueryClient();
  const m = useMutation({
    mutationFn: async ({ resource, values }: CreateVars) => {
      const res = await axiosInstance.post(resourceUrl(resource), values);
      return res.data;
    },
    onSuccess: (_data, variables) => invalidateResource(queryClient, variables.resource),
  });
  return {
    ...m,
    isLoading: m.isPending,
    mutate: (vars, opts) => m.mutate(vars, opts),
  } as ResourceMutation<CreateVars>;
}

export function useUpdate(): ResourceMutation<UpdateVars> {
  const queryClient = useQueryClient();
  const m = useMutation({
    mutationFn: async ({ resource, id, values }: UpdateVars) => {
      const res = await axiosInstance.patch(resourceUrl(resource, id), values);
      return res.data;
    },
    onSuccess: (_data, variables) => invalidateResource(queryClient, variables.resource),
  });
  return {
    ...m,
    isLoading: m.isPending,
    mutate: (vars, opts) => m.mutate(vars, opts),
  } as ResourceMutation<UpdateVars>;
}

export function useDelete(): ResourceMutation<DeleteVars> {
  const queryClient = useQueryClient();
  const m = useMutation({
    mutationFn: async ({ resource, id }: DeleteVars) => {
      const res = await axiosInstance.delete(resourceUrl(resource, id));
      return res.data;
    },
    onSuccess: (_data, variables) => invalidateResource(queryClient, variables.resource),
  });
  return {
    ...m,
    isLoading: m.isPending,
    mutate: (vars, opts) => m.mutate(vars, opts),
  } as ResourceMutation<DeleteVars>;
}

// ── useInvalidate ──────────────────────────────────────────────────────────

export interface InvalidateArgs {
  resource: string;
  invalidates?: ReadonlyArray<'list' | 'many' | 'detail' | 'all' | 'resourceAll'>;
}

export function useInvalidate() {
  const queryClient = useQueryClient();
  return ({ resource }: InvalidateArgs) => {
    void queryClient.invalidateQueries({ queryKey: ['resource', resource] });
  };
}

// ── useNotification ────────────────────────────────────────────────────────

export type NotificationType = 'success' | 'error' | 'progress';

export interface NotificationOpen {
  message: string;
  description?: string;
  type?: NotificationType;
  key?: string;
}

/**
 * Refine-compatible shape: `{ open({ message, description, type }) }`.
 * Delegates to Ant Design's App.useApp().notification.
 */
export function useNotification(): { open?: (args: NotificationOpen) => void } {
  const { notification } = App.useApp();
  return useMemo(
    () => ({
      open: ({ message, description, type = 'success' }: NotificationOpen) => {
        const kind = type === 'error' ? 'error' : type === 'progress' ? 'info' : 'success';
        notification[kind]({ message, description });
      },
    }),
    [notification],
  );
}
