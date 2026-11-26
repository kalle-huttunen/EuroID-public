/** Centralized polling interval constants */
export const POLL_INTERVALS = {
  PROVISIONING_MS: 2000,
  /** Privileged access lists while a session is enabling its admin accounts (ACTIVATING). */
  PAM_SESSION_MS: 3000,
  PIPELINE_MS: 30000,
  AUDIT_EVENTS_MS: 10_000,
  VALIDATION_DEBOUNCE_MS: 500,
  /** Typing pause before a search request (the GDPR page's person picker). */
  SEARCH_DEBOUNCE_MS: 300,
  NOTIFICATION_WINDOW_MS: 5000,
  NOTIFICATION_DEDUP_MS: 60000,
  /**
   * Window in which real-time events invalidate one query key prefix at most once more: the
   * first event refetches at once, the rest of a burst (a bulk run, an HR sync) once at its end.
   */
  REALTIME_INVALIDATION_WINDOW_MS: 2000,
} as const;
