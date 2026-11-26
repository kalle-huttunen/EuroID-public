/**
 * Audit integrity (backend `modules/audit`, every route super-admin): the hash chain over a time
 * window, Merkle checkpoints (list, create, check), one event's Merkle proof and a checkpoint's
 * signed anchor. The generated types carry no response bodies for these routes, so the shapes
 * follow the backend (`audit-integrity.types.ts`, `audit-merkle.service.ts`,
 * `audit-anchor.service.ts`).
 */

/**
 * Why the chain breaks at an event: `hash_mismatch` when its stored hash is not the hash of its
 * content (changed after it was written); `broken_link` when it does not link to the event before
 * it (that event was replaced; for older events also moved or removed); `missing_events` when chain
 * positions before it, or at the end of the chain, are missing and no GDPR erasure recorded them.
 */
export type ChainBreakReason = 'hash_mismatch' | 'broken_link' | 'missing_events';

/** Events a GDPR erasure removed from the checked range, as its own audit entry recorded. */
export interface IErasureGap {
  /** `_id` of the GDPR_ERASURE_EXECUTED entry. */
  erasureEntryId: string;
  /** Its timestamp (ISO). */
  erasedAt: string;
  eventsRemoved: number;
}

/** GET /audit/verify-integrity?from&to */
export interface IChainCheckResult {
  valid: boolean;
  /** Events read up to and including the first broken one (all of them when valid). */
  eventsChecked: number;
  /** `_id` of the first event that breaks the chain (absent when events at the end are missing). */
  firstInvalid?: string;
  /** Its timestamp (ISO). */
  firstInvalidAt?: string;
  /** Its chain position; with events missing at the end, the first missing position. */
  firstInvalidSeq?: number;
  reason?: ChainBreakReason;
  /** With `missing_events`: how many positions are missing. */
  missingEvents?: number;
  /** Events checked that were written before hash version 2 (no chain position). */
  legacyEventsChecked: number;
  /** What their check does not cover (present when legacyEventsChecked > 0). */
  legacyNote?: string;
  /** Gaps GDPR erasures recorded: not tampering. */
  erasureGaps: IErasureGap[];
}

/** One row of GET /audit/merkle-roots (newest first; the list leaves out the event hashes). */
export interface IMerkleCheckpoint {
  _id: string;
  /** UUID; the anchor route takes it. */
  checkpointId: string;
  tenantId: string;
  rootHash: string;
  eventCount: number;
  treeDepth: number;
  firstEventTimestamp: string;
  lastEventTimestamp: string;
  /** First and last chain position covered; absent on checkpoints made before positions existed. */
  firstSeq?: number;
  lastSeq?: number;
  /**
   * A legacy checkpoint: events written before hash version 2 (no chain position), by their
   * stored hashes in time order, made once by the daily audit archive run. Absent on the others.
   */
  legacy?: boolean;
  /** Its number (1, 2, ...) when the older events needed more than one checkpoint. */
  legacyPart?: number;
  previousRootHash?: string;
  archived: boolean;
  /** Ed25519 signature (hex); absent when no anchor key was configured at the time. */
  anchorSignature?: string;
  anchorKeyFingerprint?: string;
  anchoredAt?: string;
  /** Delivery of the signed anchor to an external witness, when one is configured. */
  externalAnchor?: {
    endpoint: string;
    deliveredAt: string;
    responseStatus?: number;
    witness?: string;
  };
  createdAt: string;
  updatedAt?: string;
}

export interface IMerkleCheckpointPage {
  data: IMerkleCheckpoint[];
  total: number;
}

export interface IMerkleProofStep {
  hash: string;
  /** Which side the sibling hash goes on when hashing up to the root. */
  position: 'left' | 'right';
}

/** POST /audit/verify-event/:eventId (the event's `_id`). */
export interface IEventProofResult {
  valid: boolean;
  proof: IMerkleProofStep[];
  rootHash: string;
  checkpointId: string;
  /** The checkpoint is a legacy one; `legacyNote` says what that proves. */
  legacy: boolean;
  legacyNote?: string;
}

/**
 * POST /audit/verify: each checkpoint's stored root against its stored event hashes, and each
 * covered event still in the log re-hashed against its leaf. Stops at the first invalid checkpoint.
 */
export interface IRootsCheckResult {
  valid: boolean;
  /** Checkpoints read up to and including the first invalid one. */
  checkpointsVerified: number;
  /** Covered events found in the log that re-hash to their leaf. */
  eventsVerified: number;
  /** Leaves whose event left the log (retention, GDPR erasure, deletion): counted, not judged. */
  eventsMissing: number;
  firstInvalidCheckpoint?: string;
  /** `root_mismatch`: the checkpoint record changed; `event_changed`: a covered event changed. */
  reason?: 'root_mismatch' | 'event_changed';
  /** With `event_changed`: the event's `_id`. */
  invalidEventId?: string;
  /** Legacy checkpoints among those checked. */
  legacyCheckpointsChecked: number;
  /** What their check proves and what it cannot (present when legacyCheckpointsChecked > 0). */
  legacyNote?: string;
}

/** The fields the anchor signs, in the order they are signed (compact JSON). */
export interface IAnchorPayload {
  checkpointId: string;
  tenantId: string;
  rootHash: string;
  previousRootHash: string | null;
  eventCount: number;
  firstEventTimestamp: string;
  lastEventTimestamp: string;
}

/** GET /audit/merkle-roots/:checkpointId/anchor */
export interface IAnchorProof {
  envelope: {
    payload: IAnchorPayload;
    signature: string;
    keyFingerprint: string;
    algorithm: 'ed25519';
    signedAt: string;
  };
  /** The server checked the signature with its configured public key. */
  verified: boolean;
}
