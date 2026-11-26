/**
 * Audit integrity texts and helpers: the time windows a chain check offers, what each kind of
 * chain break means, and how times, hashes and the audit log link are shown.
 */
import dayjs from 'dayjs';
import type { ChainWindow } from '@api/audit-integrity-api';
import type { ChainBreakReason } from '../../interfaces';

export type WindowChoice = 'day' | 'week' | 'month' | 'all' | 'custom';

export const WINDOW_LABEL: Record<WindowChoice, string> = {
  day: 'Last 24 hours',
  week: 'Last 7 days',
  month: 'Last 30 days',
  all: 'Whole log',
  custom: 'Custom range',
};

export const WINDOW_CHOICES = Object.keys(WINDOW_LABEL) as WindowChoice[];

const WINDOW_HOURS: Record<'day' | 'week' | 'month', number> = {
  day: 24,
  week: 24 * 7,
  month: 24 * 30,
};

/** The window of a preset, up to now; the whole log has no bounds. */
export function presetWindow(choice: Exclude<WindowChoice, 'custom'>): ChainWindow {
  if (choice === 'all') return {};
  return { from: dayjs().subtract(WINDOW_HOURS[choice], 'hour').toISOString() };
}

export const formatTime = (iso: string | undefined, withSeconds = true) =>
  iso ? dayjs(iso).format(withSeconds ? 'YYYY-MM-DD HH:mm:ss' : 'YYYY-MM-DD HH:mm') : '';

/** "from 2026-11-23 10:00:00 to now", "in the whole log", ... */
export function describeWindow(span: ChainWindow | null): string {
  if (!span?.from && !span?.to) return 'in the whole log';
  if (!span.to) return `from ${formatTime(span.from)} to now`;
  if (!span.from) return `up to ${formatTime(span.to)}`;
  return `from ${formatTime(span.from)} to ${formatTime(span.to)}`;
}

/** What a break at an event means and what can cause it. */
export const BREAK_REASON: Record<ChainBreakReason, { title: string; detail: string }> = {
  hash_mismatch: {
    title: 'Its stored hash does not match its content',
    detail: 'The event, or its stored hash, was changed after it was written.',
  },
  broken_link: {
    title: 'It does not link to the event before it',
    detail:
      'Its previousHash is not the hash of the event at the position before it: that event was replaced by another one. For an event written before hash version 2 it means the event it links to is nowhere in the log: deleted, with no GDPR erasure recording it.',
  },
  missing_events: {
    title: 'Events before it are missing',
    detail:
      'Chain positions before it are not in the log, and no GDPR erasure recorded removing them: those events were deleted. (A GDPR erasure records the positions it removes, and the check reports them below instead.)',
  },
};

/** "1 event", "42 events". */
export const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** First characters of a hash, enough to tell hashes apart on screen. */
export const shortHash = (hash: string) => (hash.length > 12 ? `${hash.slice(0, 12)}…` : hash);

/** The audit log narrowed to one moment: the events written at that millisecond. */
export const auditLogLink = (iso: string) =>
  `/audit?dateFrom=${encodeURIComponent(iso)}&dateTo=${encodeURIComponent(iso)}`;
