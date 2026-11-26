/**
 * Identity API – query key factories for identity and uncorrelated endpoints, one identity
 * for the identity page and who masters its fields, plus the audited PII reveal.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { axiosInstance } from './data';
import { API_BASE } from './constants';
import { IdentityListResponseSchema, type IdentityOptionRaw } from './schemas/identity-responses';
import type { PiiFieldName } from '../utils/pii-fields';
import type { IAttributeControlUpdate, IIdentityMastery, IStandardUser } from '../interfaces';

export interface IdentityOption {
  id: string;
  email?: string;
  displayName?: string;
  /** The profile status (ACTIVE, SUSPENDED, ...) when the answer carries one. */
  status?: string;
  /** Offboarded (soft-deleted): listed only with includeDeleted. */
  offboarded?: boolean;
}

export const identityKeys = {
  conflicts: () => ['identity', 'conflicts'] as const,
  entitlements: (id: string) => ['identity', 'entitlements', id] as const,
  all: () => ['identity'] as const,
  listForSelect: () => ['identity', 'list-for-select'] as const,
  search: (search: string, includeDeleted: boolean) =>
    ['identity', 'search', search, includeDeleted] as const,
  listPaginated: (range: { start: number; end: number }) => ['identity', 'list', range] as const,
  detail: (id: string) => ['identity', 'detail', id] as const,
  mastery: (id: string) => ['identity', 'mastery', id] as const,
};

/** GET /identity/:id/mastery (viewer). */
export async function fetchIdentityMastery(id: string): Promise<IIdentityMastery> {
  const res = await axiosInstance.get<IIdentityMastery>(
    `${API_BASE}/identity/${encodeURIComponent(id)}/mastery`,
  );
  return res.data;
}

/**
 * Who masters the identity's profile fields, for the Profile form: a field an HR source masters
 * is read-only there. Invalidated with every identity query (prefix ['identity']).
 */
export function useIdentityMastery(id: string | undefined) {
  return useQuery({
    queryKey: identityKeys.mastery(id ?? ''),
    queryFn: () => fetchIdentityMastery(id as string),
    enabled: !!id,
  });
}

/** GET /identity/:id (viewer): the Golden Record as the list shows it, PII fields masked. */
export async function fetchIdentity(id: string): Promise<IStandardUser> {
  const res = await axiosInstance.get<IStandardUser>(
    `${API_BASE}/identity/${encodeURIComponent(id)}`,
  );
  return res.data;
}

/**
 * One identity for `/identities/:id`; the API answers 400 for an id that is not an ObjectId. A
 * 404 (no such identity) is final and shown at once; other failures keep the default 3 retries.
 */
export function useIdentity(id: string | undefined) {
  return useQuery({
    queryKey: identityKeys.detail(id ?? ''),
    queryFn: () => fetchIdentity(id as string),
    enabled: !!id,
    retry: (failureCount, error) =>
      (error as { response?: { status?: number } }).response?.status !== 404 && failureCount < 3,
  });
}

/**
 * Set or remove the override of an HR-mastered department or job title (PATCH
 * /identity/v2/:id/controls, operator; audited). The profile, its owners and overrides and every
 * identity list are read again (prefix keys).
 */
export function useUpdateIdentityControls(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: IAttributeControlUpdate) => {
      const res = await axiosInstance.patch(
        `${API_BASE}/identity/v2/${encodeURIComponent(id)}/controls`,
        body,
      );
      return res.data as { success: boolean };
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: identityKeys.all() });
      void qc.invalidateQueries({ queryKey: ['resource', 'identity'] });
    },
  });
}

function toIdentityOption(u: IdentityOptionRaw): IdentityOption {
  const profile = u.profile;
  const email = u.email ?? profile?.email ?? '';
  // GET /identity answers the profile flattened next to `_id`; other answers nest it.
  const firstName = u.firstName ?? profile?.firstName;
  const lastName = u.lastName ?? profile?.lastName;
  const displayName =
    u.displayName ??
    (firstName || lastName ? [firstName, lastName].filter(Boolean).join(' ') : email);
  return {
    id: String(u._id ?? u.id ?? ''),
    email,
    displayName,
    ...(u.status ? { status: u.status } : {}),
    ...(u.deletedAt ? { offboarded: true } : {}),
  };
}

function toIdentityOptions(data: unknown): IdentityOption[] | null {
  const parsed = IdentityListResponseSchema.safeParse(data);
  if (!parsed.success) return null;
  const list: IdentityOptionRaw[] = Array.isArray(parsed.data)
    ? parsed.data
    : (parsed.data.user ?? parsed.data.data ?? []);
  return list.map(toIdentityOption).filter((u) => u.id);
}

/** Fetch identities for dropdown/selector (e.g. Adopt orphan modal). */
export async function fetchIdentitiesForSelect(params?: {
  limit?: number;
}): Promise<IdentityOption[]> {
  const limit = params?.limit ?? 500;
  const res = await axiosInstance.get<unknown>(`${API_BASE}/identity?_start=0&_end=${limit}`);
  return toIdentityOptions(res.data) ?? [];
}

export interface IdentitySearchResult {
  options: IdentityOption[];
  /** How many identities match in all (X-Total-Count); more than `options` when cut off. */
  total: number;
}

/**
 * GET /identity?q=&includeDeleted= (viewer; includeDeleted: operator and above): the first
 * `limit` identities whose work email or name holds every word of `search` (all without one),
 * offboarded ones too with `includeDeleted`. An answer of another shape is an error.
 */
export async function searchIdentities(params: {
  search: string;
  includeDeleted: boolean;
  limit: number;
}): Promise<IdentitySearchResult> {
  const res = await axiosInstance.get<unknown>(`${API_BASE}/identity`, {
    params: {
      _start: 0,
      _end: params.limit,
      ...(params.search ? { q: params.search } : {}),
      ...(params.includeDeleted ? { includeDeleted: 'true' } : {}),
    },
  });
  const options = toIdentityOptions(res.data);
  if (!options) throw new Error('The identity list answered in an unexpected shape.');
  const total = Number(res.headers?.['x-total-count']);
  return { options, total: Number.isFinite(total) ? total : options.length };
}

export const uncorrelatedKeys = {
  count: () => ['uncorrelated', 'count'] as const,
  list: () => ['uncorrelated', 'list'] as const,
};

export interface PiiRevealResponse {
  identityId: string;
  field: PiiFieldName;
  /** Clear value; null when the field is empty. */
  value: string | null;
}

/**
 * Audited reveal of one masked PII field. The backend writes the PII_REVEALED audit
 * entry before it returns the value; any failure rejects and nothing is revealed.
 */
export async function revealPiiField(
  identityId: string,
  field: PiiFieldName,
): Promise<string | null> {
  const { data } = await axiosInstance.post<PiiRevealResponse>(
    `${API_BASE}/identity/${encodeURIComponent(identityId)}/pii/reveal`,
    { field },
  );
  return data.value;
}
