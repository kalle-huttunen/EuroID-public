/**
 * Answers of the audit integrity checks: the hash chain check (AuditChainVerifier) and the
 * checkpoint check (AuditMerkleService.verifyRange).
 */

/**
 * Why the chain breaks at an event: `hash_mismatch` when its stored integrityHash is not the hash
 * of its stored content (changed after it was written); `broken_link` when its previousHash is not
 * the integrityHash of the event before it (replaced, or for older events moved or removed);
 * `missing_events` when chain positions before it (or at the end of the chain) are missing and no
 * GDPR erasure recorded removing them.
 */
export type IntegrityBreakReason = 'hash_mismatch' | 'broken_link' | 'missing_events';

/** Events a GDPR erasure removed from the checked range, as its own audit entry recorded. */
export interface ErasureGap {
  /** `_id` of the GDPR_ERASURE_EXECUTED entry. */
  erasureEntryId: string;
  /** Its timestamp (ISO). */
  erasedAt: string;
  /** Events of the checked range it removed. */
  eventsRemoved: number;
}

export interface VerifyIntegrityResult {
  valid: boolean;
  /** Events read up to and including the first invalid one (all of them when valid). */
  eventsChecked: number;
  /** `_id` of the first event that breaks the chain (absent when events at the end are missing). */
  firstInvalid?: string;
  /** Its timestamp (ISO), to find it in the audit log. */
  firstInvalidAt?: string;
  /** Its chain position; with events missing at the end, the first missing position. */
  firstInvalidSeq?: number;
  reason?: IntegrityBreakReason;
  /** With `missing_events`: how many positions are missing. */
  missingEvents?: number;
  /** Events among those checked written before hash version 2 (no chain position). */
  legacyEventsChecked: number;
  /** What their check does not cover; present when legacyEventsChecked > 0. */
  legacyNote?: string;
  /** Gaps in the checked range that GDPR erasures recorded: not tampering. */
  erasureGaps: ErasureGap[];
}

export const LEGACY_NOTE =
  'Events written before hash version 2 have no chain position: their hash does not cover the ' +
  'payload, and their link may point to any earlier event of the log, because each writing ' +
  'process kept its own last hash.';

/** Why a checkpoint fails its check. */
export type CheckpointBreakReason = 'root_mismatch' | 'event_changed';

/** POST /audit/verify: the checkpoints made in the range, each against the events it covers. */
export interface VerifyRangeResult {
  valid: boolean;
  /** Checkpoints read up to and including the first invalid one. */
  checkpointsVerified: number;
  /** Events found in the log that re-hash to the checkpoint leaf they were stored as. */
  eventsVerified: number;
  /** Leaves with no event left in the log: removed by retention, a GDPR erasure or a deletion. */
  eventsMissing: number;
  /** `checkpointId` of the first invalid checkpoint. */
  firstInvalidCheckpoint?: string;
  reason?: CheckpointBreakReason;
  /** With `event_changed`: `_id` of the event. */
  invalidEventId?: string;
  /** Legacy checkpoints among those checked (events written before hash version 2). */
  legacyCheckpointsChecked: number;
  /** What their check proves and what it cannot; present when legacyCheckpointsChecked > 0. */
  legacyNote?: string;
}

export const LEGACY_CHECKPOINT_NOTE =
  'A legacy checkpoint covers audit events written before hash version 2 (no chain position) by ' +
  'the hashes they had when it was made, in time order. It proves that those stored hashes, and ' +
  'the event fields they cover, have not changed since it was made. It cannot show a change made ' +
  'before then, and their hash does not cover the payload: a changed payload goes unnoticed.';
