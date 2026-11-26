/**
 * What leaver detection returns for one HR sync (the HR_SYNC_COMPLETED handler result).
 * Shared so HR ingestion can read it without importing the leavers module.
 */
export interface LeaverSyncSummary {
  kind: 'leaver-sync-summary';
  sourceName: string;
  /** True when the run counts toward missing-from-source (fetched, nothing skipped or failed). */
  fullSync: boolean;
  /** New leavers this run found (one per identity). */
  detected: number;
  /** Offboarding workflows started by this run, including retries of earlier failed starts. */
  started: number;
  /** Set when the run exceeded the mass-leaver limit: nothing started, the batch awaits approval. */
  pausedBatchId?: string;
}

/** Tells the leaver handler's result apart from other HR_SYNC_COMPLETED listeners' results. */
export function isLeaverSyncSummary(value: unknown): value is LeaverSyncSummary {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'leaver-sync-summary'
  );
}
