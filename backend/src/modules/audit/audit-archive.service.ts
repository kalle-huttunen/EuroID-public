/**
 * Audit Archive Service
 *
 * Exports Merkle-checkpointed audit events to S3 with Object Lock
 * for WORM compliance. GDPR-aware: exports hashes + metadata only
 * by default (no PII in actor/payload fields).
 */

import { Injectable, Logger, BadRequestException, Inject } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { createHash } from 'crypto';
import { gzipSync } from 'zlib';

import { AuditMerkleRoot, type AuditMerkleRootDocument } from './schemas/audit-merkle-root.schema';
import { AuditEvent, type AuditEventDocument } from './schemas/audit-event.schema';
import type { StorageAdapter } from '../../infrastructure/retention/storage/storage.interface';

export interface AuditArchiveExport {
  storagePath: string;
  sizeBytes: number;
  checksum: string;
  eventCount: number;
}

@Injectable()
export class AuditArchiveService {
  private readonly logger = new Logger(AuditArchiveService.name);

  private readonly retentionDays: number;
  private readonly s3Prefix: string;
  private readonly includePayload: boolean;
  private readonly enabled: boolean;

  constructor(
    @InjectModel(AuditMerkleRoot.name)
    private readonly merkleRootModel: Model<AuditMerkleRootDocument>,
    @InjectModel(AuditEvent.name)
    private readonly auditEventModel: Model<AuditEventDocument>,
    @Inject('AUDIT_ARCHIVE_STORAGE')
    private readonly storageAdapter: StorageAdapter,
  ) {
    this.retentionDays = parseInt(process.env.AUDIT_WORM_RETENTION_DAYS ?? '2555', 10);
    this.s3Prefix = process.env.AUDIT_ARCHIVE_S3_PREFIX ?? 'euroid';
    this.includePayload = process.env.AUDIT_ARCHIVE_INCLUDE_PAYLOAD === 'true';
    this.enabled = process.env.AUDIT_ARCHIVE_ENABLED === 'true';
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Export a Merkle checkpoint to S3 with Object Lock.
   */
  async exportToS3(tenantId: string, merkleRootId: string): Promise<AuditArchiveExport> {
    const checkpoint = await this.merkleRootModel.findById(merkleRootId).lean().exec();

    if (!checkpoint || checkpoint.tenantId !== tenantId) {
      throw new BadRequestException(`Merkle checkpoint ${merkleRootId} not found`);
    }

    if (checkpoint.archived) {
      throw new BadRequestException(`Checkpoint ${checkpoint.checkpointId} already archived`);
    }

    if (checkpoint.eventHashes.length === 0) {
      throw new BadRequestException('Cannot archive checkpoint with zero events');
    }

    // Fetch associated events
    const events = await this.auditEventModel
      .find({
        tenantId,
        integrityHash: { $in: checkpoint.eventHashes },
      })
      .sort({ timestamp: 1 })
      .lean()
      .exec();

    // Build export payload — GDPR: hashes + metadata only by default
    const exportData = {
      checkpointId: checkpoint.checkpointId,
      tenantId,
      rootHash: checkpoint.rootHash,
      previousRootHash: checkpoint.previousRootHash,
      eventCount: checkpoint.eventCount,
      treeDepth: checkpoint.treeDepth,
      firstEventTimestamp: checkpoint.firstEventTimestamp,
      lastEventTimestamp: checkpoint.lastEventTimestamp,
      eventHashes: checkpoint.eventHashes,
      // Events written before hash version 2: their hash does not cover the payload
      ...(checkpoint.legacy ? { legacy: true, legacyPart: checkpoint.legacyPart } : {}),
      events: events.map((e) => {
        const base: Record<string, unknown> = {
          integrityHash: e.integrityHash,
          previousHash: e.previousHash,
          action: e.action,
          severity: e.severity,
          timestamp: e.timestamp,
          resourceType: e.resourceType,
          resourceId: e.resourceId,
        };
        if (this.includePayload) {
          base.actor = e.actor;
          base.resourceName = e.resourceName;
          base.description = e.description;
          base.payload = e.payload;
          base.source = e.source;
          base.targetSystem = e.targetSystem;
        }
        return base;
      }),
      exportedAt: new Date().toISOString(),
    };

    // Serialize, compress, checksum
    const json = JSON.stringify(exportData, null, 2);
    const buffer = Buffer.from(json, 'utf8');
    const compressed = gzipSync(buffer);
    const checksum = createHash('sha256').update(json).digest('hex');

    // Build S3 path
    const firstTs = new Date(checkpoint.firstEventTimestamp);
    const year = firstTs.getUTCFullYear();
    const month = String(firstTs.getUTCMonth() + 1).padStart(2, '0');
    const objectKey = `${this.s3Prefix}/${tenantId}/audit-archive/${year}/${month}/${checkpoint.rootHash}.json.gz`;

    // Upload with Object Lock
    let storagePath: string;
    if (this.storageAdapter.uploadWithLock) {
      storagePath = await this.storageAdapter.uploadWithLock(
        compressed,
        objectKey,
        this.retentionDays,
      );
    } else {
      storagePath = await this.storageAdapter.upload(compressed, objectKey);
      this.logger.warn(
        '[AuditArchive] Storage adapter does not support Object Lock — uploaded without WORM protection',
      );
    }

    // Mark checkpoint as archived
    await this.merkleRootModel.updateOne({ _id: merkleRootId }, { $set: { archived: true } });

    this.logger.log(
      `[AuditArchive] Exported checkpoint ${checkpoint.checkpointId} (${events.length} events) to ${storagePath}`,
    );

    return {
      storagePath,
      sizeBytes: compressed.length,
      checksum,
      eventCount: events.length,
    };
  }

  /**
   * Get unarchived checkpoints older than 24 hours (settled).
   */
  async getUnarchivedCheckpoints(tenantId: string): Promise<AuditMerkleRootDocument[]> {
    const cutoff = new Date();
    cutoff.setHours(cutoff.getHours() - 24);

    return this.merkleRootModel
      .find({
        tenantId,
        archived: false,
        createdAt: { $lt: cutoff },
      })
      .sort({ createdAt: 1 })
      .select('_id checkpointId tenantId')
      .lean()
      .exec() as Promise<AuditMerkleRootDocument[]>;
  }
}
