/**
 * Dead-letter queue API: failed events, workflow steps and connector calls.
 * Backend: `modules/dead-letter`. List, read and dismiss need operator; retry and replay
 * super-admin. The list answers a plain array without a total, so a page asks for one row more
 * than it shows to know whether an older page exists.
 */
import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { axiosInstance } from '@api/data';
import { API_BASE } from '@api/constants';
import { PAGE_SIZES } from '@config/pagination';
import type { IDeadLetterEntry, IDeadLetterFilter, IDeadLetterStats } from '../interfaces';

const DEAD_LETTER_API = `${API_BASE}/dead-letter`;

/** Rows per page (the backend caps a page at 100). */
export const DEAD_LETTER_PAGE_SIZE = PAGE_SIZES.MEDIUM;

export const deadLetterKeys = {
  all: ['dead-letter'] as const,
  list: (filter: IDeadLetterFilter, page: number) =>
    [
      ...deadLetterKeys.all,
      'list',
      filter.status ?? 'all',
      filter.type ?? 'all',
      filter.source ?? '',
      page,
    ] as const,
  stats: () => [...deadLetterKeys.all, 'stats'] as const,
  detail: (id: string) => [...deadLetterKeys.all, 'detail', id] as const,
};

export interface DeadLetterPage {
  items: IDeadLetterEntry[];
  /** An older page exists. */
  hasMore: boolean;
}

export async function fetchDeadLetters(
  filter: IDeadLetterFilter,
  page: number,
): Promise<DeadLetterPage> {
  const { data } = await axiosInstance.get<IDeadLetterEntry[]>(DEAD_LETTER_API, {
    params: {
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.type ? { type: filter.type } : {}),
      ...(filter.source ? { source: filter.source } : {}),
      limit: DEAD_LETTER_PAGE_SIZE + 1,
      offset: page * DEAD_LETTER_PAGE_SIZE,
    },
  });
  const rows = Array.isArray(data) ? data : [];
  return {
    items: rows.slice(0, DEAD_LETTER_PAGE_SIZE),
    hasMore: rows.length > DEAD_LETTER_PAGE_SIZE,
  };
}

export async function fetchDeadLetter(id: string): Promise<IDeadLetterEntry> {
  const { data } = await axiosInstance.get<IDeadLetterEntry>(
    `${DEAD_LETTER_API}/${encodeURIComponent(id)}`,
  );
  return data;
}

/** Newest first, one page of `DEAD_LETTER_PAGE_SIZE`. */
export function useDeadLetters(filter: IDeadLetterFilter, page: number) {
  return useQuery({
    queryKey: deadLetterKeys.list(filter, page),
    queryFn: () => fetchDeadLetters(filter, page),
    placeholderData: keepPreviousData,
  });
}

export function useDeadLetterStats() {
  return useQuery({
    queryKey: deadLetterKeys.stats(),
    queryFn: async () => {
      const { data } = await axiosInstance.get<IDeadLetterStats>(`${DEAD_LETTER_API}/stats`);
      return data ?? {};
    },
  });
}

export function useDeadLetter(id: string | undefined) {
  return useQuery({
    queryKey: deadLetterKeys.detail(id ?? ''),
    queryFn: () => fetchDeadLetter(id as string),
    enabled: !!id,
  });
}

/** What a retry or replay left behind, read back from the entry; null when it could not be reloaded. */
export interface DeadLetterRetryResult {
  entry: IDeadLetterEntry | null;
}

/**
 * Runs a retry or replay and reads the entry back. The backend waits for the re-run and answers
 * its outcome (`success`, `status`, `error`); the page shows the entry as stored afterwards
 * (closed as replayed, pending with the error and attempt count, failed permanently). An entry
 * with nothing to re-run is refused with 409.
 */
async function rerunAndReload(
  id: string,
  action: 'retry' | 'replay',
): Promise<DeadLetterRetryResult> {
  await axiosInstance.post(`${DEAD_LETTER_API}/${encodeURIComponent(id)}/${action}`);
  try {
    return { entry: await fetchDeadLetter(id) };
  } catch {
    // The request itself went through; the page says the outcome could not be read back.
    return { entry: null };
  }
}

/** Retry (super-admin): a failure counts as an attempt, up to the entry's limit. */
export function useRetryDeadLetter() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => rerunAndReload(id, 'retry'),
    onSettled: () => qc.invalidateQueries({ queryKey: deadLetterKeys.all }),
  });
}

/** Replay (super-admin, pending entries): a failure leaves the entry pending, not counted. */
export function useReplayDeadLetter() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => rerunAndReload(id, 'replay'),
    onSettled: () => qc.invalidateQueries({ queryKey: deadLetterKeys.all }),
  });
}

/** Dismiss (operator): closes the entry without re-running anything. */
export function useDismissDeadLetter() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await axiosInstance.post(`${DEAD_LETTER_API}/${encodeURIComponent(id)}/dismiss`);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: deadLetterKeys.all }),
  });
}
