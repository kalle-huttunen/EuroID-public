/**
 * Reconciliation API – drift fetching.
 * GET /api/v1/reconciliation/drifts supports optional filters, one identity's drifts by `userId`.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { axiosInstance } from './data';
import { API_BASE } from './constants';
import type { IDrift } from '../interfaces';
import type { IConnectorHealthStatus } from '../interfaces/reconciliation.interface';

/** A drift as GET /reconciliation/drifts sends it: a MongoDB document with `_id` and no `id`. */
type DriftRecord = Omit<IDrift, 'id'> & { _id: string };

export interface DriftsPaginatedResponse {
  success: boolean;
  drifts: IDrift[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

type DriftsPageRecord = Omit<DriftsPaginatedResponse, 'drifts'> & { drifts?: DriftRecord[] };

/**
 * Every drift the app handles comes through this file and carries the API's `_id` as `id`:
 * correct, ignore, the bulk actions and table row keys all read `id`.
 */
function toDrift({ _id, ...drift }: DriftRecord): IDrift {
  return { ...drift, id: String(_id) };
}

/** Drifts per request when reading one identity's drifts: the most GET /drifts sends. */
const IDENTITY_DRIFTS_PAGE_SIZE = 100;

/**
 * Drifts as GET /reconciliation/drifts lists them (the API's first page without `identityId`).
 * With `identityId` (the identity's `_id`): every open drift of that identity, all pages, which
 * the API filters by the drift's `userId`. The identity page's Drift tab and badge, the Profile
 * drift indicators and the identity map read this.
 */
export async function fetchDrifts(params?: {
  identityId?: string;
  severity?: string;
  type?: string;
  targetSystem?: string;
  status?: string;
}): Promise<IDrift[]> {
  const search = new URLSearchParams();
  if (params?.severity) search.set('severity', params.severity);
  if (params?.type) search.set('type', params.type);
  if (params?.targetSystem) search.set('targetSystem', params.targetSystem);
  if (params?.status) search.set('status', params.status);
  if (!params?.identityId) return (await fetchDriftPage(search)).drifts;

  search.set('userId', params.identityId);
  if (!params.status) search.set('status', 'open');
  search.set('limit', String(IDENTITY_DRIFTS_PAGE_SIZE));
  const drifts: IDrift[] = [];
  for (let page = 1, totalPages = 1; page <= totalPages; page++) {
    search.set('page', String(page));
    const result = await fetchDriftPage(search);
    drifts.push(...result.drifts);
    totalPages = result.totalPages;
  }
  return drifts;
}

async function fetchDriftPage(
  search: URLSearchParams,
): Promise<{ drifts: IDrift[]; totalPages: number }> {
  const res = await axiosInstance.get<DriftsPageRecord>(
    `${API_BASE}/reconciliation/drifts?${search.toString()}`,
  );
  const drifts =
    res.data?.success && Array.isArray(res.data.drifts) ? res.data.drifts.map(toDrift) : [];
  return { drifts, totalPages: res.data?.totalPages ?? 1 };
}

/** Identities per GET /reconciliation/drifts/open-counts: the most it takes. */
const OPEN_COUNTS_BATCH = 100;

/**
 * Open drifts per identity (`_id`) for the identities given; one without an open drift is not in
 * the answer. One request per 100 identities. The identity hub's drift column reads this.
 */
export async function fetchOpenDriftCounts(identityIds: string[]): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (let start = 0; start < identityIds.length; start += OPEN_COUNTS_BATCH) {
    const search = new URLSearchParams({
      userIds: identityIds.slice(start, start + OPEN_COUNTS_BATCH).join(','),
    });
    const res = await axiosInstance.get<{ success: boolean; counts?: Record<string, number> }>(
      `${API_BASE}/reconciliation/drifts/open-counts?${search.toString()}`,
    );
    Object.assign(counts, res.data?.counts ?? {});
  }
  return counts;
}

export async function fetchDriftsPaginated(params: {
  page?: number;
  limit?: number;
  severity?: string;
  type?: string;
  targetSystem?: string;
  search?: string;
}): Promise<DriftsPaginatedResponse> {
  const search = new URLSearchParams();
  if (params.page != null) search.set('page', String(params.page));
  if (params.limit != null) search.set('limit', String(params.limit));
  if (params.severity) search.set('severity', params.severity);
  if (params.type) search.set('type', params.type);
  if (params.targetSystem) search.set('targetSystem', params.targetSystem);
  if (params.search?.trim()) search.set('search', params.search.trim());

  const res = await axiosInstance.get<DriftsPageRecord>(
    `${API_BASE}/reconciliation/drifts?${search.toString()}`,
  );
  if (!res.data?.success) {
    return {
      success: false,
      drifts: [],
      total: 0,
      page: 1,
      limit: 50,
      totalPages: 0,
    };
  }
  return {
    success: true,
    drifts: (res.data.drifts ?? []).map(toDrift),
    total: res.data.total ?? 0,
    page: res.data.page ?? 1,
    limit: res.data.limit ?? 50,
    totalPages: res.data.totalPages ?? 0,
  };
}

export async function correctDrift(driftId: string): Promise<void> {
  await axiosInstance.post(`${API_BASE}/reconciliation/drifts/${driftId}/correct`);
}

export async function ignoreDrift(driftId: string): Promise<void> {
  await axiosInstance.post(`${API_BASE}/reconciliation/drifts/${driftId}/ignore`);
}

/** Counts of open drifts (GET /drifts/stats); corrected and ignored drifts are not counted. */
export interface DriftStats {
  total: number;
  critical: number;
  autoFixEligible: number;
  pending: number;
}

export async function fetchDriftStats(): Promise<DriftStats> {
  const { data } = await axiosInstance.get<DriftStats>(`${API_BASE}/reconciliation/drifts/stats`);
  return data;
}

export async function fetchConnectorHealth(): Promise<IConnectorHealthStatus[]> {
  const { data } = await axiosInstance.get<{
    success?: boolean;
    connectors?: IConnectorHealthStatus[];
  }>(`${API_BASE}/reconciliation/connector-health`);
  return Array.isArray(data?.connectors) ? data.connectors : [];
}

export async function fetchOrphans(params?: {
  page?: number;
  limit?: number;
  targetSystem?: string;
  status?: string;
}): Promise<{ drifts: IDrift[]; total: number; page: number; limit: number; totalPages: number }> {
  const search = new URLSearchParams();
  search.set('type', 'ORPHAN_ACCOUNT');
  if (params?.page) search.set('page', String(params.page));
  if (params?.limit) search.set('limit', String(params.limit));
  if (params?.targetSystem) search.set('targetSystem', params.targetSystem);
  if (params?.status) search.set('status', params.status);
  const res = await axiosInstance.get<DriftsPageRecord>(
    `${API_BASE}/reconciliation/drifts?${search.toString()}`,
  );
  return {
    drifts: (res.data?.drifts ?? []).map(toDrift),
    total: res.data?.total ?? 0,
    page: res.data?.page ?? 1,
    limit: res.data?.limit ?? 50,
    totalPages: res.data?.totalPages ?? 0,
  };
}

export async function fetchOrphanStats(): Promise<{
  total: number;
  quarantined: number;
  disabled: number;
  resolved: number;
  bySystem: Record<string, number>;
}> {
  const { data } = await axiosInstance.get<{
    success: boolean;
    total: number;
    quarantined: number;
    disabled: number;
    resolved: number;
    bySystem: Record<string, number>;
  }>(`${API_BASE}/reconciliation/orphans/stats`);
  return data ?? { total: 0, quarantined: 0, disabled: 0, resolved: 0, bySystem: {} };
}

export async function signalOrphan(
  driftId: string,
  action: 'ADOPT' | 'DELETE',
  identityId?: string,
): Promise<void> {
  await axiosInstance.post(`${API_BASE}/reconciliation/orphans/${driftId}/signal`, {
    action,
    identityId,
  });
}

export interface OrphanDeleteSimulation {
  success: boolean;
  accountIdentifier: string;
  accountName: string;
  targetSystem: string;
  /** False for an Active Directory orphan: EuroID never deletes it (`impact` says why). */
  deletable?: boolean;
  impact: string;
}

export async function simulateOrphanDelete(driftId: string): Promise<OrphanDeleteSimulation> {
  const { data } = await axiosInstance.get<OrphanDeleteSimulation>(
    `${API_BASE}/reconciliation/orphans/${driftId}/simulate-delete`,
  );
  return data;
}

export const reconciliationKeys = {
  all: () => ['reconciliation'] as const,
  connectorHealth: () => ['reconciliation', 'connector-health'] as const,
  drifts: (params?: { identityId?: string }) => ['reconciliation', 'drifts', params] as const,
  driftsPrefix: () => ['reconciliation', 'drifts'] as const,
  openDriftCounts: (identityIds: string[]) =>
    ['reconciliation', 'drifts', 'open-counts', identityIds] as const,
  driftsPaginated: (params?: {
    page?: number;
    limit?: number;
    severity?: string;
    type?: string;
    targetSystem?: string;
    search?: string;
  }) => ['reconciliation', 'drifts', 'paginated', params] as const,
  driftStats: () => ['reconciliation', 'drifts-stats'] as const,
  orphans: (params?: { page?: number; targetSystem?: string; status?: string }) =>
    ['reconciliation', 'orphans', params] as const,
  orphanStats: () => ['reconciliation', 'orphans-stats'] as const,
};
