/**
 * Rate limiter constants — extracted from rate-limiter.activities.ts.
 *
 * All per-system limits are overridable via environment variables to allow
 * tuning per deployment without code changes.
 */

/** One hour in milliseconds */
export const MS_PER_HOUR = 3_600_000;

/** 24 hours in milliseconds */
export const MS_PER_DAY = 86_400_000;

/**
 * Per-system API rate limits. Based on vendor documentation:
 * - Entra ID: Microsoft Graph throttling (~10K requests/hour)
 * - Active Directory: Conservative LDAP connection limit
 * - Salesforce: REST API daily limits divided hourly
 * - SCIM: Standard endpoint throttling
 */
export const SYSTEM_RATE_LIMITS: Record<
  string,
  { total: number; windowMs: number; recommendedBatchSize: number }
> = {
  'entra-id': {
    total: parseInt(process.env.RATE_LIMIT_ENTRA_TOTAL ?? '10000', 10),
    windowMs: parseInt(process.env.RATE_LIMIT_ENTRA_WINDOW_MS ?? String(MS_PER_HOUR), 10),
    recommendedBatchSize: 10,
  },
  'active-directory': {
    total: parseInt(process.env.RATE_LIMIT_AD_TOTAL ?? '1000', 10),
    windowMs: parseInt(process.env.RATE_LIMIT_AD_WINDOW_MS ?? String(MS_PER_HOUR), 10),
    recommendedBatchSize: 5,
  },
  salesforce: {
    total: parseInt(process.env.RATE_LIMIT_SALESFORCE_TOTAL ?? '5000', 10),
    windowMs: parseInt(process.env.RATE_LIMIT_SALESFORCE_WINDOW_MS ?? String(MS_PER_HOUR), 10),
    recommendedBatchSize: 10,
  },
  scim: {
    total: parseInt(process.env.RATE_LIMIT_SCIM_TOTAL ?? '1000', 10),
    windowMs: parseInt(process.env.RATE_LIMIT_SCIM_WINDOW_MS ?? String(MS_PER_HOUR), 10),
    recommendedBatchSize: 5,
  },
};

/** Default rate limit for unknown/new systems */
export const DEFAULT_SYSTEM_LIMIT = {
  total: 1000,
  windowMs: MS_PER_HOUR,
  recommendedBatchSize: 5,
};

/** Throttle delay tiers based on utilization percentage */
export const THROTTLE_TIERS = [
  { maxUtilization: 80, delayMs: 0 },
  { maxUtilization: 85, delayMs: 1000 },
  { maxUtilization: 90, delayMs: 2000 },
  { maxUtilization: 95, delayMs: 5000 },
  { maxUtilization: 100, delayMs: 10000 },
] as const;

/**
 * Longest wait (ms) checkAndWait sleeps inside the calling activity. A longer wait, such as an
 * exhausted window, is thrown as RateLimitedException so Temporal retries the activity after
 * it instead of a worker sleeping past the activity's startToCloseTimeout (bulk provisioning:
 * 2 minutes). Keep it well below that timeout.
 */
export const MAX_IN_ACTIVITY_WAIT_MS = parseInt(
  process.env.RATE_LIMIT_MAX_IN_ACTIVITY_WAIT_MS ?? '30000',
  10,
);

/** Utilization % above which moderate throttling kicks in */
export const MODERATE_THROTTLE_THRESHOLD = 60;
/** Delay (ms) applied at moderate utilization */
export const MODERATE_THROTTLE_DELAY_MS = 500;
/** Utilization % above which high throttling kicks in */
export const HIGH_THROTTLE_THRESHOLD = 80;

/** Estimation defaults for batch duration calculation */
export const ESTIMATION_DEFAULTS = {
  /** Average milliseconds per API call to external systems */
  avgApiCallMs: 200,
  /** Default number of API calls per provisioning operation */
  apiCallsPerOperation: 5,
  /** Fallback ms per operation when no rate limit state is available */
  fallbackMsPerOperation: 1000,
} as const;

/** Batch size reduction thresholds based on remaining capacity */
export const BATCH_CAPACITY_THRESHOLDS = {
  /** Capacity % below which batch size is heavily reduced */
  severe: 20,
  /** Capacity % below which batch size is moderately reduced */
  moderate: 50,
  /** Factor to reduce batch by at moderate capacity */
  moderateReductionFactor: 0.6,
  /** Factor to reduce batch by at severe capacity */
  severeReductionFactor: 0.3,
  /** Absolute minimum batch size */
  absoluteMinimum: 1,
  /** Minimum batch size for moderate reduction */
  moderateMinimum: 3,
} as const;
