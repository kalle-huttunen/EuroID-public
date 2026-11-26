/**
 * Archival Activities
 *
 * Exports audit and user events to cold storage (S3/Azure Blob) before deletion.
 * Ensures compliance with long-term retention (SOX, HIPAA: up to 7 years).
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { createHash } from 'crypto';
import { gzipSync } from 'zlib';
import { AuditEvent, AuditEventDocument } from '../modules/audit/schemas/audit-event.schema';
import { UserEvent, UserEventDocument } from '../modules/identity/schemas/user-event.schema';
import {
  ArchivalRecord,
  ArchivalRecordDocument,
} from '@infrastructure/retention/schemas/archival-record.schema';
import type { StorageAdapter } from '@infrastructure/retention/storage/storage.interface';
import { TenantService } from '@infrastructure/multi-tenancy/tenant.service';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';

export interface ArchivalStorageConfig {
  provider: string;
  bucket?: string;
  container?: string;
  region?: string;
}

export interface ArchivalMetadata {
  batchId: string;
  collection: string;
  documentCount: number;
  storagePath: string;
  storageProvider: string;
  archivedAt: Date;
  startDate: Date;
  endDate: Date;
  sizeBytes: number;
  checksum: string;
}

const COLLECTION_MODELS: Record<string, { model: string; dateField: string }> = {
  audit_events: { model: AuditEvent.name, dateField: 'timestamp' },
  user_events: { model: UserEvent.name, dateField: 'timestamp' },
};

@Injectable()
export class ArchivalActivities {
  private readonly logger = new Logger(ArchivalActivities.name);

  constructor(
    @InjectModel(AuditEvent.name) private readonly auditModel: Model<AuditEventDocument>,
    @InjectModel(UserEvent.name) private readonly userEventModel: Model<UserEventDocument>,
    @InjectModel(ArchivalRecord.name) private readonly archivalModel: Model<ArchivalRecordDocument>,
    @Inject('STORAGE_ADAPTER') private readonly storageAdapter: StorageAdapter,
    private readonly tenantService: TenantService,
  ) {}

  /**
   * Tenants to archive. Every DB activity below runs inside one tenant's context: the tenant
   * plugin rejects unscoped queries, and each archive object holds a single tenant's data.
   */
  async listArchivalTenantIds(): Promise<string[]> {
    const tenants = await this.tenantService.findAll();
    return tenants.map((t) => t.tenantId);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Union of Model<A> | Model<B> is not callable; both share the same query API
  private getModel(collection: string): Model<any> {
    const meta = COLLECTION_MODELS[collection];
    if (!meta) {
      throw new Error(`Unknown collection for archival: ${collection}`);
    }
    if (collection === 'audit_events') return this.auditModel;
    return this.userEventModel;
  }

  /**
   * Find documents older than cutoff (now - cutoffDays), oldest first. Used by runs started before
   * the patch archival:ids-not-documents, which pass the documents on through workflow history.
   */
  async findDocumentsForArchival(
    tenantId: string,
    collection: string,
    cutoffDays: number,
    batchSize: number,
  ): Promise<Record<string, unknown>[]> {
    return withTenantContext(tenantId, () =>
      this.findTenantDocumentsForArchival(collection, cutoffDays, batchSize),
    );
  }

  /**
   * The next batch: the documents older than the cutoff, oldest first (`_id` orders a tie), at
   * most `batchSize`. An exported batch is deleted by id, so whatever is still older than the
   * cutoff is not archived yet: rows that share the last timestamp of a full batch, and an event
   * written late with an old timestamp, come in a later batch. Before, documents inside the date
   * range of an archived batch were skipped for good, and the TTL index deleted them unarchived.
   */
  private async findTenantDocumentsForArchival(
    collection: string,
    cutoffDays: number,
    batchSize: number,
    select?: string,
  ): Promise<Record<string, unknown>[]> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - cutoffDays);

    const model = this.getModel(collection);
    const dateField = COLLECTION_MODELS[collection].dateField;
    const query = model
      .find({ [dateField]: { $lt: cutoffDate } })
      .sort({ [dateField]: 1, _id: 1 })
      .limit(batchSize);
    if (select) query.select(select);
    return (await query.lean().exec()) as unknown as Record<string, unknown>[];
  }

  /**
   * The next batch to archive by id, with its date range (patch archival:ids-not-documents): the
   * documents stay in MongoDB until exportArchivalBatch reads them, so none passes through
   * workflow history. `ids` is empty when nothing is older than the cutoff.
   */
  async findArchivalBatch(
    tenantId: string,
    collection: string,
    cutoffDays: number,
    batchSize: number,
  ): Promise<{ ids: string[]; startDate?: string; endDate?: string }> {
    const dateField = COLLECTION_MODELS[collection]?.dateField ?? 'timestamp';
    const docs = await withTenantContext(tenantId, () =>
      this.findTenantDocumentsForArchival(collection, cutoffDays, batchSize, `_id ${dateField}`),
    );
    if (docs.length === 0) return { ids: [] };
    return {
      ids: docs.map((d) => String(d._id)),
      ...(await this.computeDateRange(docs, dateField)),
    };
  }

  /**
   * Reads the batch's documents by id in the tenant and exports them (exportBatchToStorage). The
   * batch id is the object's own name (time and checksum), unique across runs and tenants. When
   * every document is gone before the read (the collection's TTL index, once archival lags), it
   * uploads nothing and answers `documentCount: 0`, which the workflow skips (patch
   * archival:empty-batch-skipped).
   */
  async exportArchivalBatch(
    tenantId: string,
    collection: string,
    documentIds: string[],
    storageConfig: ArchivalStorageConfig,
  ): Promise<{
    path: string;
    sizeBytes: number;
    checksum: string;
    documentCount: number;
    batchId: string;
  }> {
    const model = this.getModel(collection);
    const dateField = COLLECTION_MODELS[collection].dateField;
    const ids = documentIds.map((id) => new Types.ObjectId(id));
    const documents = (await withTenantContext(tenantId, () =>
      model
        .find({ _id: { $in: ids } })
        .sort({ [dateField]: 1, _id: 1 })
        .lean()
        .exec(),
    )) as unknown as Record<string, unknown>[];
    if (documents.length === 0) {
      this.logger.warn(
        `[Archival] Every document of a ${collection} batch was gone; none exported`,
      );
      return { path: '', sizeBytes: 0, checksum: '', documentCount: 0, batchId: '' };
    }
    const exported = await this.exportBatchToStorage(
      tenantId,
      collection,
      documents,
      storageConfig,
    );
    const batchId = exported.path.replace(/^.*\//, '').replace(/\.ndjson\.gz$/, '');
    return { ...exported, documentCount: documents.length, batchId };
  }

  /**
   * Serialize to NDJSON, gzip, upload. Returns storage path, size, and checksum.
   */
  async exportBatchToStorage(
    tenantId: string,
    collection: string,
    documents: Record<string, unknown>[],
    _storageConfig: ArchivalStorageConfig,
  ): Promise<{ path: string; sizeBytes: number; checksum: string }> {
    if (documents.length === 0) {
      throw new Error('Cannot export empty batch');
    }

    const ndjson = documents.map((d) => JSON.stringify(d)).join('\n');
    const buffer = Buffer.from(ndjson, 'utf8');
    const compressed = gzipSync(buffer);
    const sizeBytes = buffer.length;
    const checksum = createHash('sha256').update(ndjson).digest('hex');

    const now = new Date();
    const year = now.getUTCFullYear();
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    const batchId = `batch-${Date.now()}-${checksum.slice(0, 8)}`;
    const objectKey = `${tenantId}/${collection}/${year}/${month}/${batchId}.ndjson.gz`;

    const path = await this.storageAdapter.upload(compressed, objectKey);
    this.logger.log(`[Archival] Exported ${documents.length} docs from ${collection} to ${path}`);
    return { path, sizeBytes, checksum };
  }

  /**
   * Compute min/max date range from documents. Moved from workflow to avoid Math.min/Math.max in workflow code.
   */
  async computeDateRange(
    docs: Array<Record<string, unknown>>,
    dateField: string,
  ): Promise<{ startDate: string; endDate: string }> {
    const timestamps = docs.map((d) => new Date(d[dateField] as string).getTime());
    return {
      startDate: new Date(Math.min(...timestamps)).toISOString(),
      endDate: new Date(Math.max(...timestamps)).toISOString(),
    };
  }

  /**
   * Delete documents by _id after confirmed archival.
   */
  async deleteArchivedBatch(
    tenantId: string,
    collection: string,
    documentIds: string[],
  ): Promise<number> {
    if (documentIds.length === 0) return 0;
    const model = this.getModel(collection);
    const { Types } = await import('mongoose');
    const ids = documentIds.map((id) => new Types.ObjectId(id));
    const result = await withTenantContext(tenantId, () =>
      model.deleteMany({ _id: { $in: ids } }).exec(),
    );
    this.logger.log(`[Archival] Deleted ${result.deletedCount} docs from ${collection}`);
    return result.deletedCount;
  }

  /**
   * Record archival metadata for discovery and idempotency.
   * Sets archivedAt to current time (activities may use Date).
   */
  async recordArchivalMetadata(
    tenantId: string,
    metadata: Omit<ArchivalMetadata, 'archivedAt'>,
  ): Promise<void> {
    await withTenantContext(tenantId, () =>
      this.archivalModel.create({
        ...metadata,
        archivedAt: new Date(),
      }),
    );
  }
}

// --- Task 108 recap: Four Temporal activities — find, export (NDJSON+gzip), delete, record metadata.
