/**
 * What HR joiner detection returns for one HR sync (the HR_SYNC_JOINERS_REQUESTED handler result).
 * Shared so HR ingestion can read it without importing the joiners module. Counts only.
 */
export interface JoinerSyncSummary {
  kind: 'joiner-sync-summary';
  sourceName: string;
  /**
   * True when the run fetched rows and none was skipped or failed. A partial run records the
   * identities it minted as waiting joiners and starts no onboarding.
   */
  fullSync: boolean;
  /** Identities this run minted: new joiners, recorded whether or not they start now. */
  detected: number;
  /** Onboarding runs started (this run's joiners and earlier waiting ones now due). */
  started: number;
  /** Joiners put in a paused batch by this run (above the mass-joiner limit), see pausedBatchId. */
  pending: number;
  /**
   * Joiners of this source still waiting after the run: the pipeline is not deployed (or paused),
   * the start date is ahead, the run was partial or did not deliver them, or their start failed.
   */
  waiting: number;
  /** Starts that failed (Temporal unreachable); they stay waiting for the next full sync. */
  startFailed: number;
  /**
   * Joiners closed without an onboarding from this path: left in HR, offboarded by an HR leaver,
   * deleted, already onboarded by an operator, or an onboarding run already in progress.
   */
  closed: number;
  /** The tenant's pipeline status, read on a full sync: joiners start only while DEPLOYED. */
  pipelineStatus?: string;
  /** Set when the due joiners exceeded the mass-joiner limit: nothing started, a batch waits. */
  pausedBatchId?: string;
}

/** Tells the HR joiner handler's result apart from other listeners' results. */
export function isJoinerSyncSummary(value: unknown): value is JoinerSyncSummary {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'joiner-sync-summary'
  );
}
