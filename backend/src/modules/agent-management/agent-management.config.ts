/**
 * Agent management configuration — sourced from environment variables.
 */
export const AGENT_CONFIG = {
  /** Seconds between expected heartbeats. Agents must ping within this interval. */
  HEARTBEAT_INTERVAL_SECONDS: parseInt(process.env.AGENT_HEARTBEAT_INTERVAL_SECONDS ?? '30', 10),

  /** Factor of heartbeat interval before marking agent stale (e.g., 3 × 30s = 90s). */
  STALE_THRESHOLD_MULTIPLIER: parseFloat(process.env.AGENT_STALE_THRESHOLD_MULTIPLIER ?? '3'),

  /** How often (ms) the stale-check poller runs internally. */
  STALE_CHECK_INTERVAL_MS: parseInt(process.env.AGENT_STALE_CHECK_INTERVAL_MS ?? '15000', 10),

  /** Maximum agents per tenant (prevent runaway registrations). */
  MAX_PER_TENANT: parseInt(process.env.AGENT_MAX_PER_TENANT ?? '50', 10),
} as const;
