/**
 * Audit API – React Query hooks for Audit & Compliance dashboard.
 * Backend: GET /api/v1/audit, GET /api/v1/audit/stats
 */

import { useQuery } from '@tanstack/react-query';
import { axiosInstance } from './data';
import { API_BASE } from './constants';
import type { IAuditEvent, IAuditFilter } from '../interfaces/audit.interface';
import { AUDIT_EXPORT_MAX_EVENTS, AUDIT_EXPORT_PAGE_SIZE } from '../config/pagination';

export const auditKeys = {
  all: ['audit'] as const,
  list: (filters?: Record<string, unknown>) => [...auditKeys.all, 'list', filters] as const,
  stats: () => [...auditKeys.all, 'stats'] as const,
};

export interface AuditListResponse {
  data: IAuditEvent[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface AuditStatsResponse {
  total: number;
  critical: number;
  warnings: number;
  today: number;
}

/** Stats shape consumed by AuditDashboard */
export interface AuditStatsDisplay {
  total: number;
  critical: number;
  warnings: number;
  todayCount: number;
}

function mapToIAuditEvent(raw: Record<string, unknown>): IAuditEvent {
  return {
    id: (raw._id ?? raw.id) as string,
    action: raw.action as IAuditEvent['action'],
    severity: (raw.severity as IAuditEvent['severity']) ?? 'info',
    timestamp:
      typeof raw.timestamp === 'string'
        ? raw.timestamp
        : ((raw.timestamp as Date)?.toISOString?.() ?? ''),
    actor: (raw.actor as string) ?? '',
    resourceType: (raw.resourceType as string) ?? '',
    resourceId: (raw.resourceId as string) ?? '',
    resourceName: (raw.resourceName as string) ?? '',
    targetSystem: raw.targetSystem as string | undefined,
    description: (raw.description as string) ?? '',
    payload: raw.payload as IAuditEvent['payload'],
    source: raw.source as string | undefined,
  };
}

type AuditQuery = IAuditFilter & { page?: number; limit?: number };

/** One page of GET /audit for the filter. */
async function fetchAuditPage(filters?: AuditQuery) {
  const params = new URLSearchParams();
  if (filters?.action?.length) filters.action.forEach((a) => params.append('action', a));
  if (filters?.severity?.length) filters.severity.forEach((s) => params.append('severity', s));
  if (filters?.actor) params.set('actor', filters.actor);
  if (filters?.resourceType) params.set('resourceType', filters.resourceType);
  if (filters?.targetSystem) params.set('targetSystem', filters.targetSystem);
  if (filters?.dateFrom) params.set('dateFrom', filters.dateFrom);
  if (filters?.dateTo) params.set('dateTo', filters.dateTo);
  if (filters?.search) params.set('search', filters.search);
  if (filters?.page) params.set('page', String(filters.page));
  if (filters?.limit) params.set('limit', String(filters.limit ?? 50));

  const { data: res } = await axiosInstance.get<
    AuditListResponse & { data: Record<string, unknown>[] }
  >(`${API_BASE}/audit?${params.toString()}`);
  const events = (res.data ?? []).map(mapToIAuditEvent);
  return {
    data: events,
    total: res.total ?? events.length,
    page: res.page ?? filters?.page ?? 1,
    limit: res.limit ?? filters?.limit ?? 50,
    totalPages: res.totalPages ?? 1,
  };
}

/**
 * Every event of the filter for the CSV export, page by page, up to `max`; `total` is how many
 * the filter matches, so the caller can say when the export holds fewer. Every page asks for the
 * same range ending at the earlier of the filter's end and the export's start (`startedAt`): each
 * GET /audit logs an event of its own, newer than everything listed, so with an open end the
 * newest-first offsets moved by one per page (a row repeated, the oldest cut).
 */
export async function fetchAuditEventsForExport(
  filters: IAuditFilter,
  max: number = AUDIT_EXPORT_MAX_EVENTS,
  startedAt: Date = new Date(),
): Promise<{ events: IAuditEvent[]; total: number }> {
  const events: IAuditEvent[] = [];
  let total = 0;
  const ends = Date.parse(filters.dateTo ?? '');
  const startsAfterNow = Date.parse(filters.dateFrom ?? '') > startedAt.getTime();
  // A range that starts later than now keeps its own end (pinning it would end before it starts)
  const dateTo =
    !startsAfterNow && !(ends <= startedAt.getTime()) ? startedAt.toISOString() : filters.dateTo;
  for (let page = 1; events.length < max; page++) {
    const res = await fetchAuditPage({ ...filters, dateTo, page, limit: AUDIT_EXPORT_PAGE_SIZE });
    total = res.total;
    events.push(...res.data);
    if (res.data.length < AUDIT_EXPORT_PAGE_SIZE || events.length >= total) break;
  }
  return { events: events.slice(0, max), total };
}

export function useAuditEvents(
  filters?: IAuditFilter & { page?: number; limit?: number },
  options?: { refetchInterval?: number | false },
) {
  return useQuery({
    queryKey: auditKeys.list(filters as Record<string, unknown>),
    queryFn: () => fetchAuditPage(filters),
    ...options,
  });
}

export function useAuditStats(options?: { refetchInterval?: number | false }) {
  return useQuery({
    queryKey: auditKeys.stats(),
    queryFn: async (): Promise<AuditStatsDisplay> => {
      const { data } = await axiosInstance.get<AuditStatsResponse>(`${API_BASE}/audit/stats`);
      return {
        total: data.total,
        critical: data.critical,
        warnings: data.warnings,
        todayCount: data.today,
      };
    },
    ...options,
  });
}
