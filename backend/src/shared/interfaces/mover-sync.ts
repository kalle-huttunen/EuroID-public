/**
 * What HR mover detection returns for one HR sync (the HR_SYNC_MOVERS_REQUESTED handler result).
 * Shared so HR ingestion can read it without importing the mover module. Counts only.
 */
export interface MoverSyncSummary {
  kind: 'mover-sync-summary';
  sourceName: string;
  /**
   * True when the run fetched rows and none was skipped or failed. A partial run evaluates no
   * one and starts no mover run (every count below is 0).
   */
  fullSync: boolean;
  /** Identities this run left with a trigger attribute different from their access baseline. */
  detected: number;
  /** Mover runs started (0 when the run was paused for approval). */
  started: number;
  /** Detected identities with a mover run already in progress: none started for them. */
  alreadyRunning: number;
  /** Detected identities whose start failed (Temporal unreachable); the next sync retries them. */
  startFailed: number;
  /** Provisioned identities the run delivered that have no access baseline: not evaluated. */
  withoutBaseline: number;
  /** Set when `detected` exceeded the mass-mover limit: nothing started, the batch awaits approval. */
  pausedBatchId?: string;
}

/** Tells the HR mover handler's result apart from other listeners' results. */
export function isMoverSyncSummary(value: unknown): value is MoverSyncSummary {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'mover-sync-summary'
  );
}
