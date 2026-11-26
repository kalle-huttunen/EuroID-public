/**
 * The license forecast of PredictiveAnalyticsService, as pure arithmetic: the license's units in
 * use and enabled as discovery last read them (catalog `licenseUnits`), and the trend of the net
 * adds minus removes EuroID recorded per calendar month.
 */

export interface LicenseForecastResult {
  system: string;
  license: string;
  /** Units in use as the target reported them at the last discovery; null until it has run. */
  currentCount: number | null;
  /** Units the tenant has (enabled), else the LICENSE_CAPS cap; null when neither is known. */
  capacity: number | null;
  /** When discovery read currentCount and capacity; absent while they are unknown. */
  countsObservedAt?: Date;
  /** currentCount plus the monthly rate over the horizon; null while currentCount is unknown. */
  projectedCount: number | null;
  daysToCapacity?: number;
  trend: 'growing' | 'stable' | 'declining';
  monthlyRate: number;
  insufficientData?: boolean;
}

/** The units a catalog entry holds for a license (EntitlementCatalog.licenseUnits). */
export interface LicenseUnits {
  consumed?: number;
  enabled?: number;
  observedAt?: Date;
}

/** One calendar month of the window: its cumulative net change, and whether it had any. */
export interface LicenseHistoryMonth {
  count: number;
  changed: boolean;
}

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

/**
 * The forecast of one license. The rate is the window's net change per calendar month (fewer
 * than 3 months with changes is insufficientData, rate 0); the count starts from the units in
 * use, and daysToCapacity counts the units left at that rate (0 when none are left).
 */
export function forecastLicense(input: {
  system: string;
  license: string;
  history: LicenseHistoryMonth[];
  monthsOfHistory: number;
  daysAhead: number;
  units?: LicenseUnits;
  /** The LICENSE_CAPS entry, used when discovery reported no enabled units. */
  configuredCap: number | null;
}): LicenseForecastResult {
  const { system, license, history, monthsOfHistory, daysAhead, units } = input;
  const currentCount = isCount(units?.consumed) ? units.consumed : null;
  const capacity = isCount(units?.enabled) ? units.enabled : input.configuredCap;
  const known = {
    system,
    license,
    currentCount,
    capacity,
    ...(currentCount !== null && units?.observedAt ? { countsObservedAt: units.observedAt } : {}),
  };

  if (history.filter((month) => month.changed).length < 3) {
    return {
      ...known,
      projectedCount: currentCount,
      trend: 'stable',
      monthlyRate: 0,
      insufficientData: true,
    };
  }

  // The net change per calendar month of the window (a month without changes counts too)
  const netChange = history[history.length - 1]?.count ?? 0;
  const monthlyRate = netChange / monthsOfHistory;
  const projectedCount =
    currentCount === null ? null : Math.round(currentCount + monthlyRate * (daysAhead / 30));

  let trend: LicenseForecastResult['trend'] = 'stable';
  if (monthlyRate > 0.5) trend = 'growing';
  else if (monthlyRate < -0.5) trend = 'declining';

  let daysToCapacity: number | undefined;
  if (capacity !== null && currentCount !== null && trend === 'growing' && monthlyRate > 0) {
    const remaining = capacity - currentCount;
    daysToCapacity = remaining > 0 ? Math.round((remaining / monthlyRate) * 30) : 0;
  }

  return {
    ...known,
    projectedCount,
    daysToCapacity,
    trend,
    monthlyRate: Math.round(monthlyRate * 100) / 100,
  };
}
