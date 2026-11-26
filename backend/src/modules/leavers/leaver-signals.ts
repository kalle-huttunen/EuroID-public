/**
 * Leaver signal rules: pure functions, no I/O, so each rule is unit-tested on its own.
 * LeaverDetectionService feeds them one identity at a time.
 */
import type { LeaverReason } from '@infrastructure/events/event-payloads';
import type { LeaverPolicySettings } from './leaver-policy.defaults';

/** What the authoritative HR source last said about one person. */
export interface LeaverCandidate {
  /** HR employment status word (customAttributes.hrStatus), or the record's status. */
  hrStatus?: string;
  /** HR end date or termination date. */
  endDate?: Date;
  /** When the source last delivered this person (identity.sources[].lastSync). */
  lastSeen?: Date;
}

export interface LeaverSignalContext {
  now: Date;
  /**
   * Start of the oldest of the last `missingSyncThreshold` full syncs of the source, counting
   * this run. Undefined when this run is not a full sync or the source has had fewer full
   * syncs: then nobody can be missing.
   */
  missingCutoff?: Date;
}

export interface LeaverSignal {
  reason: LeaverReason;
  /** End date (terminated, end-date) or last time seen (missing-from-source). */
  effectiveDate?: Date;
  /** What the signal rests on; equal evidence means the same leaver event. */
  evidence: string;
}

const DAY_FORMAT: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
};

function isUtcMidnight(date: Date): boolean {
  return (
    date.getUTCHours() === 0 &&
    date.getUTCMinutes() === 0 &&
    date.getUTCSeconds() === 0 &&
    date.getUTCMilliseconds() === 0
  );
}

/**
 * The calendar day (YYYY-MM-DD) of an HR date in `timeZone`. A date-only HR value ("2026-11-20")
 * is stored as UTC midnight and keeps its own day; a date with a time is read in `timeZone`.
 */
export function calendarDay(date: Date, timeZone: string): string {
  if (isUtcMidnight(date)) return date.toISOString().slice(0, 10);
  return new Intl.DateTimeFormat('en-CA', { ...DAY_FORMAT, timeZone }).format(date);
}

/** Today's calendar day (YYYY-MM-DD) in `timeZone`. */
export function todayIn(timeZone: string, now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { ...DAY_FORMAT, timeZone }).format(now);
}

/** True once the whole day of `date` is over in `timeZone` (an end date is the last working day). */
export function dayIsOver(date: Date, timeZone: string, now: Date): boolean {
  return calendarDay(date, timeZone) < todayIn(timeZone, now);
}

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

/**
 * The leaver signal for one person, or null. One reason per person, first match wins:
 * terminated status (effective at the end of its end date, immediately without one), then the
 * end date, then missing from the source.
 */
export function evaluateLeaverSignal(
  candidate: LeaverCandidate,
  policy: LeaverPolicySettings,
  ctx: LeaverSignalContext,
): LeaverSignal | null {
  const tz = policy.timezone;
  const endDate = isValidDate(candidate.endDate) ? candidate.endDate : undefined;
  const endDay = endDate ? calendarDay(endDate, tz) : undefined;
  const endDayOver = endDate ? dayIsOver(endDate, tz, ctx.now) : false;

  const status = candidate.hrStatus?.trim().toLowerCase();
  const terminatedWords = policy.terminatedStatuses.map((s) => s.trim().toLowerCase());
  if (policy.signals.terminated && status && terminatedWords.includes(status)) {
    if (!endDate || endDayOver) {
      return {
        reason: 'terminated',
        effectiveDate: endDate,
        evidence: `${status}|${endDay ?? ''}`,
      };
    }
  }

  if (policy.signals.endDate && endDate && endDayOver) {
    return { reason: 'end-date', effectiveDate: endDate, evidence: endDay ?? '' };
  }

  if (policy.signals.missingFromSource && ctx.missingCutoff) {
    const lastSeen = isValidDate(candidate.lastSeen) ? candidate.lastSeen : undefined;
    if (!lastSeen || lastSeen < ctx.missingCutoff) {
      return {
        reason: 'missing-from-source',
        effectiveDate: lastSeen,
        evidence: lastSeen ? lastSeen.toISOString() : 'never',
      };
    }
  }
  return null;
}

/**
 * How many leavers one run may offboard without approval: the smaller of the count limit and
 * the percentage of active identities (rounded down), raised to the floor `massLeaverMinCount`.
 * A run exceeds it with one more.
 *
 * With the defaults (10, 5 %, 2): 2 up to 59 active identities, 5 % from 60, 10 from 200 on.
 */
export function massLeaverAllowance(
  policy: LeaverPolicySettings,
  activeIdentities: number,
): number {
  const byPercent = Math.floor((activeIdentities * policy.massLeaverMaxPercent) / 100);
  return Math.max(policy.massLeaverMinCount, Math.min(policy.massLeaverMaxCount, byPercent));
}

/** True when `leavers` new leavers in one run need an admin's approval. */
export function exceedsMassLeaverLimit(
  leavers: number,
  activeIdentities: number,
  policy: LeaverPolicySettings,
): boolean {
  return leavers > massLeaverAllowance(policy, activeIdentities);
}

/**
 * Identifies one leaver event of an identity: the same source, reason and evidence never repeat.
 * A departure after a rehire is a new event: `rehiredAt` (metadata.rehiredAt, set when the Hub
 * revives a rehired identity) is part of its key, so a second leave with the same HR status word
 * and no end date is not taken for the first. An identity never rehired keeps the key it had.
 */
export function leaverEventKey(sourceName: string, signal: LeaverSignal, rehiredAt?: Date): string {
  const key = `${sourceName}:${signal.reason}:${signal.evidence}`;
  return rehiredAt ? `${key}:rehired:${rehiredAt.toISOString()}` : key;
}
