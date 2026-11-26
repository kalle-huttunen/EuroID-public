/**
 * Shared defaults for pagination, batch sizes, and connector timeouts.
 */
export const CONNECTOR_TIMEOUT_MS = parseInt(process.env.CONNECTOR_TIMEOUT_MS ?? '15000', 10);

/** GET /reconciliation/connector-health: how long one connector's check may take. */
export const CONNECTOR_HEALTH_TIMEOUT_MS = parseInt(
  process.env.CONNECTOR_HEALTH_TIMEOUT_MS ?? '5000',
  10,
);

/** GET /reconciliation/connector-health: how long a connector's check result is reused. */
export const CONNECTOR_HEALTH_CACHE_TTL_MS = parseInt(
  process.env.CONNECTOR_HEALTH_CACHE_TTL_MS ?? '30000',
  10,
);

/** HR connectors may need longer for external APIs */
export const CONNECTOR_TIMEOUT_HR_MS = parseInt(
  process.env.CONNECTOR_TIMEOUT_HR_MS ?? process.env.CONNECTOR_TIMEOUT_MS ?? '30000',
  10,
);

/** CSV HR: max rows to prevent OOM DoS (IV-3) */
export const CSV_HR_MAX_ROWS = parseInt(process.env.CSV_HR_MAX_ROWS ?? '100000', 10);

/** CSV HR: max file size in MB to prevent OOM DoS (IV-3) */
export const CSV_HR_MAX_FILE_SIZE_MB = parseInt(process.env.CSV_HR_MAX_FILE_SIZE_MB ?? '50', 10);

/** JSON API HR: max items to prevent OOM DoS (F2) */
export const JSON_HR_MAX_ITEMS = parseInt(process.env.JSON_HR_MAX_ITEMS ?? '100000', 10);

/** GitHub deprovision: invitation list pages (100 each) searched for a leaver's email. */
export const GITHUB_INVITATION_MAX_PAGES = parseInt(
  process.env.GITHUB_INVITATION_MAX_PAGES ?? '50',
  10,
);

/**
 * Longest wait for one HR-driven workflow start (leaver offboarding, joiner onboarding, mover
 * run): HR_START_TIMEOUT_MS, default 10 s, read on each start. With Temporal down a start waited
 * for the client's gRPC retries, 30 to 45 s each. A start that does not answer in time counts as
 * failed and is tried again by the source's next sync.
 */
export function hrStartTimeoutMs(): number {
  return parseInt(process.env.HR_START_TIMEOUT_MS ?? '10000', 10);
}

/**
 * A claim on an approved HR mover batch item older than this is abandoned (its process died
 * mid-start): HR_START_CLAIM_TIMEOUT_MS, default 10 minutes.
 */
export const HR_START_CLAIM_TIMEOUT_MS = parseInt(
  process.env.HR_START_CLAIM_TIMEOUT_MS ?? '600000',
  10,
);

export const DEFAULT_PAGE_SIZE = 50;
export const DEFAULT_BATCH_SIZE = 5;
export const DRIFT_QUERY_LIMIT = 500;
export const SCIM_MAX_RESULTS = 200;

export const POLICY_PAGE_SIZE = parseInt(process.env.POLICY_PAGE_SIZE ?? '500', 10);
export const IMPACT_ANALYSIS_SAMPLE_SIZE = parseInt(
  process.env.IMPACT_ANALYSIS_SAMPLE_SIZE ?? '500',
  10,
);
export const IMPACT_ANALYSIS_PAGE_SIZE = parseInt(
  process.env.IMPACT_ANALYSIS_PAGE_SIZE ?? '300',
  10,
);
export const POLICY_SUGGESTIONS_PAGE_SIZE = parseInt(
  process.env.POLICY_SUGGESTIONS_PAGE_SIZE ?? '300',
  10,
);
export const HR_FETCH_PAGE_SIZE = parseInt(process.env.HR_FETCH_PAGE_SIZE ?? '500', 10);
export const IDENTITY_PROVISIONING_PAGE_SIZE = parseInt(
  process.env.IDENTITY_PROVISIONING_PAGE_SIZE ?? '500',
  10,
);
export const ARCHIVAL_BATCH_SIZE = parseInt(process.env.ARCHIVAL_BATCH_SIZE ?? '1000', 10);
/**
 * Accounts (identity x Entra ID or AD) the nightly credential rotation run reads per tenant, the
 * ones never read or read longest ago first: CREDENTIAL_INVENTORY_REFRESH_LIMIT, default 500. A
 * larger tenant is covered over several nights, and one run stays well inside its 30 minutes.
 */
export const CREDENTIAL_INVENTORY_REFRESH_LIMIT = parseInt(
  process.env.CREDENTIAL_INVENTORY_REFRESH_LIMIT ?? '500',
  10,
);
export const RECONCILE_BATCH_PAGE_SIZE = parseInt(
  process.env.RECONCILE_BATCH_PAGE_SIZE ?? '5000',
  10,
);
export const SKU_CACHE_TTL_MS = parseInt(process.env.SKU_CACHE_TTL_MS ?? '300000', 10);
export const OUTBOX_POLLER_BATCH_SIZE = parseInt(process.env.OUTBOX_POLLER_BATCH_SIZE ?? '100', 10);
export const OUTBOX_POLL_INTERVAL_MS = parseInt(process.env.OUTBOX_POLL_INTERVAL_MS ?? '2000', 10);
/**
 * Hours a bulk rollback snapshot (pre-change target or Golden Record state, stored encrypted) is
 * kept. Must outlast the longest bulk run (workflowExecutionTimeout, 6 hours); MongoDB's TTL
 * monitor then deletes it.
 */
export const ROLLBACK_SNAPSHOT_TTL_HOURS = parseInt(
  process.env.ROLLBACK_SNAPSHOT_TTL_HOURS ?? '24',
  10,
);
