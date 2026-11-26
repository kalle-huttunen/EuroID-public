/**
 * Leaver policy: the settings a tenant stores in `leaver_policies`, and the defaults a tenant
 * without a stored policy gets. Defaults come from the environment (backend/.env.example);
 * the owner-approved values are the fallbacks below: min(10, 5 % of active identities) leavers
 * per sync, with a floor of 2 (plan 2.0cr, the HR mover policy's shape).
 */

/** Which leaver signals a tenant acts on. */
export interface LeaverSignalToggles {
  /** The HR status word is one of `terminatedStatuses`. */
  terminated: boolean;
  /** The HR end date (or termination date) has passed. */
  endDate: boolean;
  /** The person is missing from the source for `missingSyncThreshold` full syncs. */
  missingFromSource: boolean;
}

export interface LeaverPolicySettings {
  signals: LeaverSignalToggles;
  /** HR status words that mean "left", compared case-insensitively. */
  terminatedStatuses: string[];
  /** Consecutive full syncs a person must be missing from before they count as a leaver. */
  missingSyncThreshold: number;
  /** One run may start at most this many offboardings... */
  massLeaverMaxCount: number;
  /** ...and at most this percentage of the tenant's active identities; the smaller limit wins... */
  massLeaverMaxPercent: number;
  /** ...but always at least this many, so a small tenant is not paused for every leaver. */
  massLeaverMinCount: number;
  /** IANA time zone in which an end date's day ends. */
  timezone: string;
}

function envInt(name: string, fallback: number): number {
  const parsed = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function envNumber(name: string, fallback: number): number {
  const parsed = parseFloat(process.env[name] ?? '');
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function envList(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (!raw) return fallback;
  const list = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length > 0 ? list : fallback;
}

/** True when `tz` is a time zone this runtime knows (Intl accepts it). */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * The floor for a policy with this count limit and no floor of its own (the defaults, or a policy
 * stored before the floor existed): LEAVER_MASS_MIN_COUNT, never above the count limit.
 */
export function defaultMassLeaverMinCount(massLeaverMaxCount: number): number {
  return Math.min(envInt('LEAVER_MASS_MIN_COUNT', 2), massLeaverMaxCount);
}

/** Defaults for a tenant without a stored leaver policy. Read at call time so tests can set env. */
export function defaultLeaverPolicy(): LeaverPolicySettings {
  const timezone = process.env.LEAVER_DEFAULT_TIMEZONE || 'UTC';
  const massLeaverMaxCount = envInt('LEAVER_MASS_MAX_COUNT', 10);
  return {
    signals: { terminated: true, endDate: true, missingFromSource: true },
    terminatedStatuses: envList('LEAVER_TERMINATED_STATUSES', ['terminated', 'inactive', 'left']),
    missingSyncThreshold: Math.max(1, envInt('LEAVER_MISSING_SYNC_THRESHOLD', 3)),
    massLeaverMaxCount,
    massLeaverMaxPercent: envNumber('LEAVER_MASS_MAX_PERCENT', 5),
    massLeaverMinCount: defaultMassLeaverMinCount(massLeaverMaxCount),
    timezone: isValidTimeZone(timezone) ? timezone : 'UTC',
  };
}
