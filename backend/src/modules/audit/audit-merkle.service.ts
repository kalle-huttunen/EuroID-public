/**
 * Audit Merkle Service
 *
 * Phase 2 of the immutable audit system: Merkle checkpoints. A checkpoint holds the hashes of a
 * run of chained audit events (consecutive chain positions after the previous checkpoint) and
 * their Merkle root, signed when an anchor key is configured. A legacy checkpoint holds the stored
 * hashes of events written before hash version 2 (no chain position), in time order. Event proofs,
 * the checkpoint check and the WORM archive read them.
 */

import { Injectable, Logger, BadRequestException, ConflictException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { randomUUID } from 'crypto';

import { AuditMerkleRoot, type AuditMerkleRootDocument } from './schemas/audit-merkle-root.schema';
import { AuditEvent, type AuditEventDocument } from './schemas/audit-event.schema';
import { AuditAnchorService } from './audit-anchor.service';
import { auditEventHash } from './audit-hash';
import { chainPosition, isDuplicateKey } from './audit-chain-writer';
import { LEGACY_CHECKPOINT_NOTE, type VerifyRangeResult } from './audit-integrity.types';
import { buildMerkleTree, generateMerkleProof, verifyMerkleProof } from './audit-merkle-tree';

export { buildMerkleTree, generateMerkleProof, verifyMerkleProof } from './audit-merkle-tree';
export type { MerkleProof, MerkleTree } from './audit-merkle-tree';

/** Events per checkpoint: keeps the stored leaf list far below MongoDB's 16 MB document limit. */
const CHECKPOINT_MAX_EVENTS = parseInt(process.env.AUDIT_CHECKPOINT_MAX_EVENTS ?? '10000', 10);
/** Checkpoints one run of createPendingCheckpoints makes per tenant (daily audit archive run). */
const CHECKPOINTS_PER_RUN = parseInt(process.env.AUDIT_CHECKPOINT_MAX_PER_RUN ?? '50', 10);

type StoredCheckpoint = AuditMerkleRoot & { _id: unknown };

/** Events written before hash version 2: no chain position. */
const NO_CHAIN_POSITION = { $not: { $type: 'number' } };

type Leaf = { _id: unknown; integrityHash: string; timestamp: Date };

/**
 * At most `max` events, whole milliseconds only (the next legacy part starts after the last one's
 * time); empty when the first `max + 1` share one millisecond.
 */
function wholeMilliseconds(found: Leaf[], max: number): Leaf[] {
  if (found.length <= max) return found;
  const cut = new Date(found[max].timestamp).getTime();
  return found.slice(0, max).filter((e) => new Date(e.timestamp).getTime() < cut);
}

@Injectable()
export class AuditMerkleService {
  private readonly logger = new Logger(AuditMerkleService.name);

  constructor(
    @InjectModel(AuditMerkleRoot.name)
    private readonly merkleRootModel: Model<AuditMerkleRootDocument>,
    @InjectModel(AuditEvent.name)
    private readonly auditEventModel: Model<AuditEventDocument>,
    private readonly anchorService: AuditAnchorService,
  ) {}

  /**
   * Create a checkpoint over the chained events after the last checkpoint (at most
   * AUDIT_CHECKPOINT_MAX_EVENTS of them, in chain order). Events written before hash version 2
   * have no chain position and are in no checkpoint.
   *
   * @throws BadRequestException when no chained event follows the last checkpoint
   * @throws ConflictException when another checkpoint over the same events was made at the same time
   */
  async createCheckpoint(tenantId: string): Promise<AuditMerkleRootDocument> {
    const checkpoint = await this.buildNextCheckpoint(tenantId);
    if (!checkpoint) {
      throw new BadRequestException(
        'No audit events since the last checkpoint: nothing to checkpoint yet.',
      );
    }
    return checkpoint;
  }

  /**
   * Checkpoints until every event is in one (at most AUDIT_CHECKPOINT_MAX_PER_RUN): first the
   * legacy ones, then the chained ones. Returns how many were made. Used by the daily audit
   * archive run.
   */
  async createPendingCheckpoints(tenantId: string): Promise<number> {
    let made = 0;
    while (made < CHECKPOINTS_PER_RUN && (await this.buildNextLegacyCheckpoint(tenantId))) made++;
    while (made < CHECKPOINTS_PER_RUN && (await this.buildNextCheckpoint(tenantId))) made++;
    return made;
  }

  /** The next checkpoint, or null when no chained event follows the last one. */
  private async buildNextCheckpoint(tenantId: string): Promise<AuditMerkleRootDocument | null> {
    const lastChained = await this.merkleRootModel
      .findOne({ tenantId, lastSeq: chainPosition() } as Record<string, unknown>)
      .sort({ lastSeq: -1 })
      .select('lastSeq')
      .lean()
      .exec();
    const events = await this.auditEventModel
      .find({ tenantId, seq: chainPosition({ $gt: lastChained?.lastSeq ?? 0 }) })
      .sort({ seq: 1 })
      .limit(CHECKPOINT_MAX_EVENTS)
      .select('seq integrityHash timestamp')
      .lean()
      .exec();
    if (events.length === 0) return null;
    return this.saveCheckpoint(tenantId, events, {
      firstSeq: events[0].seq,
      lastSeq: events[events.length - 1].seq,
    });
  }

  /**
   * The next legacy checkpoint: the events without a chain position after the last legacy part,
   * by their stored hashes in (timestamp, _id) order, at most AUDIT_CHECKPOINT_MAX_EVENTS whole
   * milliseconds of them. Null when every such event is in one, so the daily run makes them once.
   * Only events up to the tenant's first chained event count: legacy events come before it (one
   * an old process wrote later, during a rollout, stays in none), and later runs read no further.
   *
   * @throws ConflictException when another run made the same part at the same time
   */
  private async buildNextLegacyCheckpoint(
    tenantId: string,
  ): Promise<AuditMerkleRootDocument | null> {
    const [lastPart, firstChained] = await Promise.all([
      this.merkleRootModel
        .findOne({ tenantId, legacy: true })
        .sort({ legacyPart: -1 })
        .select('legacyPart lastEventTimestamp')
        .lean()
        .exec(),
      this.auditEventModel
        .findOne({ tenantId, seq: chainPosition() })
        .sort({ seq: 1 })
        .select('timestamp')
        .lean()
        .exec(),
    ]);
    const timestamp: Record<string, Date> = {};
    if (lastPart) timestamp.$gt = lastPart.lastEventTimestamp;
    if (firstChained) timestamp.$lte = firstChained.timestamp;
    const filter: Record<string, unknown> = { tenantId, seq: NO_CHAIN_POSITION };
    if (lastPart || firstChained) filter.timestamp = timestamp;
    const found = await this.auditEventModel
      .find(filter)
      .sort({ timestamp: 1 })
      .limit(CHECKPOINT_MAX_EVENTS + 1)
      .select('integrityHash timestamp')
      .lean<Leaf[]>()
      .exec();
    if (found.length === 0) return null;

    let events = wholeMilliseconds(found, CHECKPOINT_MAX_EVENTS);
    if (events.length === 0) {
      // More events in one millisecond than a part holds: they stay together
      const sameMillisecond: Record<string, unknown> = {
        tenantId,
        seq: NO_CHAIN_POSITION,
        timestamp: found[0].timestamp,
      };
      events = await this.auditEventModel
        .find(sameMillisecond)
        .select('integrityHash timestamp')
        .lean<Leaf[]>()
        .exec();
    }
    const at = (e: Leaf) => new Date(e.timestamp).getTime();
    events.sort((a, b) => at(a) - at(b) || (String(a._id) < String(b._id) ? -1 : 1));
    return this.saveCheckpoint(tenantId, events, {
      legacy: true,
      legacyPart: (lastPart?.legacyPart ?? 0) + 1,
    });
  }

  /** Stores a checkpoint over these events, in this order, and anchors it. */
  private async saveCheckpoint(
    tenantId: string,
    events: Array<Pick<Leaf, 'integrityHash' | 'timestamp'>>,
    fields: Pick<AuditMerkleRoot, 'firstSeq' | 'lastSeq' | 'legacy' | 'legacyPart'>,
  ): Promise<AuditMerkleRootDocument> {
    const latest = await this.merkleRootModel
      .findOne({ tenantId })
      .sort({ createdAt: -1 })
      .select('rootHash')
      .lean()
      .exec();
    const leafHashes = events.map((e) => e.integrityHash);
    const tree = buildMerkleTree(leafHashes);
    const times = events.map((e) => new Date(e.timestamp).getTime());
    let checkpoint: AuditMerkleRootDocument;
    try {
      checkpoint = await this.merkleRootModel.create({
        tenantId,
        checkpointId: randomUUID(),
        rootHash: tree.rootHash,
        eventCount: leafHashes.length,
        treeDepth: tree.depth,
        ...fields,
        firstEventTimestamp: new Date(Math.min(...times)),
        lastEventTimestamp: new Date(Math.max(...times)),
        eventHashes: leafHashes,
        previousRootHash: latest?.rootHash,
        archived: false,
      });
    } catch (err: unknown) {
      if (!isDuplicateKey(err)) throw err;
      throw new ConflictException(
        'Another checkpoint over the same audit events was created at the same moment. Reload the checkpoint list.',
      );
    }

    this.logger.log(
      `[Merkle] ${fields.legacy ? 'Legacy checkpoint' : 'Checkpoint'} created for tenant ${tenantId}: ${leafHashes.length} events, root=${tree.rootHash.slice(0, 12)}...`,
    );
    await this.anchor(checkpoint);
    return checkpoint;
  }

  /** Signs the checkpoint and hands it to the external witness, when an anchor key is set. */
  private async anchor(checkpoint: AuditMerkleRootDocument): Promise<void> {
    if (!this.anchorService.isEnabled()) return;
    const envelope = this.anchorService.signCheckpoint(checkpoint);
    if (!envelope) return;
    const externalAnchor = await this.anchorService.deliverToWitness(envelope);
    const update: Record<string, unknown> = {
      anchorSignature: envelope.signature,
      anchorKeyFingerprint: envelope.keyFingerprint,
      anchoredAt: new Date(envelope.signedAt),
    };
    if (externalAnchor) update.externalAnchor = externalAnchor;
    await this.merkleRootModel.updateOne({ _id: checkpoint._id }, { $set: update }).exec();
    checkpoint.set(update);
    this.logger.log(
      `[Merkle] Checkpoint ${checkpoint.checkpointId} anchored (fingerprint ${envelope.keyFingerprint.slice(0, 12)}...)`,
    );
  }

  /** Fetch a checkpoint by its checkpointId within a tenant. */
  async getCheckpoint(
    tenantId: string,
    checkpointId: string,
  ): Promise<AuditMerkleRootDocument | null> {
    return this.merkleRootModel.findOne({ tenantId, checkpointId }).exec();
  }

  /**
   * Verify a single audit event using its Merkle proof. `legacy` says the checkpoint is a legacy
   * one, with `legacyNote` saying what that proves.
   */
  async verifyEvent(
    tenantId: string,
    eventId: string,
  ): Promise<{
    valid: boolean;
    proof: Array<{ hash: string; position: 'left' | 'right' }>;
    rootHash: string;
    checkpointId: string;
    legacy: boolean;
    legacyNote?: string;
  }> {
    // Find the event
    const event = await this.auditEventModel
      .findById(eventId)
      .select('integrityHash tenantId')
      .lean()
      .exec();

    if (!event || event.tenantId !== tenantId) {
      throw new BadRequestException(`Audit event ${eventId} not found`);
    }

    if (!event.integrityHash) {
      throw new BadRequestException(`Event ${eventId} has no integrity hash`);
    }

    // Find the checkpoint containing this event
    const checkpoint = await this.merkleRootModel
      .findOne({ tenantId, eventHashes: event.integrityHash })
      .lean()
      .exec();

    if (!checkpoint) {
      throw new BadRequestException(`No Merkle checkpoint contains event ${eventId}`);
    }

    // Rebuild tree and generate proof
    const tree = buildMerkleTree(checkpoint.eventHashes);
    const leafIndex = checkpoint.eventHashes.indexOf(event.integrityHash);
    const proof = generateMerkleProof(tree, leafIndex);
    const valid = verifyMerkleProof(event.integrityHash, proof, checkpoint.rootHash);

    const legacy = checkpoint.legacy === true;
    return {
      valid,
      proof,
      rootHash: checkpoint.rootHash,
      checkpointId: checkpoint.checkpointId,
      legacy,
      ...(legacy ? { legacyNote: LEGACY_CHECKPOINT_NOTE } : {}),
    };
  }

  /**
   * Check the checkpoints created in a date range (all without one), oldest first, against the
   * events they cover: each stored root must be the root of its stored leaves, and each covered
   * event still in the log must re-hash to the leaf it was checkpointed as (for a checkpoint over
   * chain positions, every event now at those positions). Leaves whose event left the log
   * (retention, a GDPR erasure, a deletion) are counted, not judged: the chain check tells a
   * recorded erasure from a deletion. Stops at the first invalid checkpoint. Legacy checkpoints
   * are counted, with a note saying what their check proves.
   */
  async verifyRange(tenantId: string, from?: Date, to?: Date): Promise<VerifyRangeResult> {
    const filter: Record<string, unknown> = { tenantId };
    if (from || to) {
      const created: Record<string, Date> = {};
      if (from) created.$gte = from;
      if (to) created.$lte = to;
      filter.createdAt = created;
    }
    const result: VerifyRangeResult = {
      valid: true,
      checkpointsVerified: 0,
      eventsVerified: 0,
      eventsMissing: 0,
      legacyCheckpointsChecked: 0,
    };
    const answer = (outcome: VerifyRangeResult): VerifyRangeResult =>
      outcome.legacyCheckpointsChecked > 0
        ? { ...outcome, legacyNote: LEGACY_CHECKPOINT_NOTE }
        : outcome;
    const cursor = this.merkleRootModel
      .find(filter)
      .sort({ createdAt: 1 })
      .lean<StoredCheckpoint[]>()
      .cursor();
    for await (const checkpoint of cursor as AsyncIterable<StoredCheckpoint>) {
      result.checkpointsVerified++;
      if (checkpoint.legacy) result.legacyCheckpointsChecked++;
      const leaves = checkpoint.eventHashes ?? [];
      const rootHolds =
        leaves.length > 0 &&
        leaves.length === checkpoint.eventCount &&
        buildMerkleTree(leaves).rootHash === checkpoint.rootHash;
      if (!rootHolds) {
        this.logger.warn(`[Merkle] Root hash mismatch for checkpoint ${checkpoint.checkpointId}`);
        return answer({
          ...result,
          valid: false,
          firstInvalidCheckpoint: checkpoint.checkpointId,
          reason: 'root_mismatch',
        });
      }
      const changed = await this.checkCoveredEvents(tenantId, checkpoint, result);
      if (changed) {
        return answer({
          ...result,
          valid: false,
          firstInvalidCheckpoint: checkpoint.checkpointId,
          reason: 'event_changed',
          invalidEventId: changed,
        });
      }
    }
    return answer(result);
  }

  /**
   * Re-hashes the events a checkpoint covers and adds them to the counts; returns the `_id` of
   * the first one that is no longer what was checkpointed. A legacy checkpoint (no positions)
   * covers the events with its stored hashes; each re-hashes by its own hash version.
   */
  private async checkCoveredEvents(
    tenantId: string,
    checkpoint: StoredCheckpoint,
    counts: VerifyRangeResult,
  ): Promise<string | undefined> {
    const leaves = new Set(checkpoint.eventHashes);
    const covered =
      typeof checkpoint.firstSeq === 'number' && typeof checkpoint.lastSeq === 'number'
        ? { tenantId, seq: chainPosition({ $gte: checkpoint.firstSeq, $lte: checkpoint.lastSeq }) }
        : { tenantId, integrityHash: { $in: checkpoint.eventHashes } };
    const cursor = this.auditEventModel.find(covered).lean().cursor();
    let found = 0;
    for await (const evt of cursor as AsyncIterable<Record<string, unknown>>) {
      const hash = evt.integrityHash as string;
      if (!leaves.has(hash) || auditEventHash(evt) !== hash) return String(evt._id);
      found++;
    }
    counts.eventsVerified += found;
    counts.eventsMissing += Math.max(0, checkpoint.eventHashes.length - found);
    return undefined;
  }

  /**
   * Get paginated list of Merkle checkpoints.
   */
  async getMerkleRoots(
    tenantId: string,
    page = 1,
    limit = 50,
  ): Promise<{ data: AuditMerkleRootDocument[]; total: number }> {
    const [data, total] = await Promise.all([
      this.merkleRootModel
        .find({ tenantId })
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .select('-eventHashes') // Don't send large arrays in list view
        .lean()
        .exec(),
      this.merkleRootModel.countDocuments({ tenantId }).exec(),
    ]);
    return { data: data as AuditMerkleRootDocument[], total };
  }
}
