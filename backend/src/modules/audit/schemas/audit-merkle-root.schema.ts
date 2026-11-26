/**
 * Audit Merkle Root Schema
 *
 * Stores Merkle tree checkpoints for audit event aggregation.
 * Each checkpoint covers a batch of audit events and stores
 * the root hash for efficient tamper detection (Phase 2).
 */

import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type AuditMerkleRootDocument = HydratedDocument<AuditMerkleRoot>;

@Schema({ timestamps: true, collection: 'audit_roots' })
export class AuditMerkleRoot {
  @Prop({ required: true, index: true })
  tenantId!: string;

  @Prop({ required: true })
  checkpointId!: string;

  @Prop({ required: true })
  rootHash!: string;

  @Prop({ required: true, type: Number, min: 0 })
  eventCount!: number;

  @Prop({ required: true, type: Number, min: 0 })
  treeDepth!: number;

  @Prop({ required: true, type: Date })
  firstEventTimestamp!: Date;

  @Prop({ required: true, type: Date })
  lastEventTimestamp!: Date;

  /**
   * First and last chain position (`seq`) the checkpoint covers, every position in between that
   * was in the log when it was made. Absent on checkpoints made before chain positions existed.
   */
  @Prop({ type: Number })
  firstSeq?: number;

  @Prop({ type: Number })
  lastSeq?: number;

  /**
   * A legacy checkpoint: it covers events written before hash version 2 (no `seq`) by the hashes
   * they had when it was made, in (timestamp, _id) order. The daily audit archive run makes them
   * once per tenant, in parts of at most AUDIT_CHECKPOINT_MAX_EVENTS events. Absent on the others.
   */
  @Prop({ type: Boolean })
  legacy?: boolean;

  /** Number of a legacy checkpoint (1, 2, ...) in time order. */
  @Prop({ type: Number })
  legacyPart?: number;

  @Prop({ type: [String], default: [] })
  eventHashes!: string[];

  @Prop()
  previousRootHash?: string;

  @Prop({ default: false })
  archived!: boolean;

  /**
   * Detached Ed25519 signature over the canonical anchor payload
   * (see AuditAnchorService.canonicalPayload). Hex-encoded.
   * Present when the checkpoint has been anchored; absent when the
   * anchor key is not configured (dev/test mode without signing).
   */
  @Prop()
  anchorSignature?: string;

  /**
   * SHA-256 fingerprint of the raw Ed25519 public key (hex, 64 chars).
   * Independent verifiers use this to locate the matching public key.
   */
  @Prop()
  anchorKeyFingerprint?: string;

  @Prop({ type: Date })
  anchoredAt?: Date;

  /**
   * Opaque delivery record from an external witness (e.g. webhook ack
   * payload). Stored verbatim so operators can trace delivery.
   */
  @Prop({ type: Object })
  externalAnchor?: {
    endpoint: string;
    deliveredAt: Date;
    responseStatus?: number;
    witness?: string;
  };
}

export const AuditMerkleRootSchema = SchemaFactory.createForClass(AuditMerkleRoot);

AuditMerkleRootSchema.index({ tenantId: 1, createdAt: -1 });
AuditMerkleRootSchema.index({ tenantId: 1, checkpointId: 1 }, { unique: true });
AuditMerkleRootSchema.index({ tenantId: 1, archived: 1 });
// One checkpoint per run of events: two made at the same moment (the daily run and a super-admin)
// would cover the same positions
AuditMerkleRootSchema.index(
  { tenantId: 1, firstSeq: 1 },
  { unique: true, partialFilterExpression: { firstSeq: { $type: 'number' } } },
);
// One legacy checkpoint per part: two daily runs at the same moment cannot make the same one
AuditMerkleRootSchema.index(
  { tenantId: 1, legacyPart: 1 },
  { unique: true, partialFilterExpression: { legacyPart: { $type: 'number' } } },
);
