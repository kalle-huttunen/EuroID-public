/**
 * Archival Workflow
 *
 * Exports audit and user events to cold storage (S3/Azure Blob) before deletion.
 * Runs nightly to ensure compliance with long-term retention (SOX, HIPAA).
 *
 * PROCESS (per tenant, so every archive object holds one tenant's data):
 * 1. For each tenant and collection: find docs older than cutoff
 * 2. Export batch to storage (NDJSON, gzipped)
 * 3. Delete only after confirmed upload
 * 4. Record archival metadata
 * 5. Use continueAsNew when more batches remain (avoids history limits)
 *
 * Runs started with the patch archival:ids-not-documents pass document ids from activity to
 * activity, never the documents (up to batchSize of them went through history three times per
 * batch); see archiveBatchByIds.
 */

import { proxyActivities, log, continueAsNew } from '@temporalio/workflow';
import type { ArchivalActivities } from '../activities/archival.activities';
import type { ArchivalStorageConfig } from '../activities/archival.activities';
import { ARCHIVAL_RETRY } from '../infrastructure/config/retry-policies';
import { isPatched } from './workflow-versioning';

/**
 * A batch goes by document ids (findArchivalBatch, exportArchivalBatch reads the documents
 * itself), its batch id is the export's own (unique; batch-<collection>-<n> restarted at 0 after
 * each continueAsNew and repeated across tenants), the totals are carried through continueAsNew
 * so the last run reports the whole chain, and a batch whose delete removed nothing ends the
 * collection for this run instead of finding the same documents again. Histories from before it
 * replay the old path, which passes the documents.
 */
const IDS_NOT_DOCUMENTS_PATCH = 'archival:ids-not-documents';
/**
 * A batch whose documents were all gone before the export read them (the TTL index, once
 * archival lags) is skipped: nothing is deleted or recorded for it, it is not counted, and the
 * next batch is looked for. Histories from before it deleted by the ids, recorded the empty batch
 * and ended the collection for the run (before the activity answered an empty export, the export
 * threw and the run failed).
 */
const EMPTY_BATCH_SKIPPED_PATCH = 'archival:empty-batch-skipped';
/** Default batch size — override via ArchivalWorkflowInput.batchSize (set from batchSize env var by the scheduler). */
const DEFAULT_BATCH_SIZE = 1000;

export interface ArchivalWorkflowInput {
  collections: string[];
  cutoffDays: Record<string, number>;
  storageConfig: ArchivalStorageConfig;
  /** Batch size for archival processing. Passed by scheduler from env-backed defaults. */
  batchSize?: number;
  /** Internal: tenants resolved on the first run, carried through continueAsNew */
  _tenantIds?: string[];
  /** Internal: for continueAsNew resumption */
  _tenantIndex?: number;
  /** Internal: for continueAsNew resumption */
  _collectionIndex?: number;
  /** Internal: batches and documents archived by the earlier runs of this chain (patched runs) */
  _totalBatchesArchived?: number;
  _totalDocumentsArchived?: number;
}

export interface ArchivalWorkflowResult {
  collectionsProcessed: number;
  totalBatchesArchived: number;
  totalDocumentsArchived: number;
}

const archActivities = proxyActivities<ArchivalActivities>({
  startToCloseTimeout: '10 minutes',
  retry: ARCHIVAL_RETRY,
});

export async function archivalWorkflow(
  input: ArchivalWorkflowInput,
): Promise<ArchivalWorkflowResult> {
  const {
    collections,
    cutoffDays,
    storageConfig,
    batchSize = DEFAULT_BATCH_SIZE,
    _tenantIndex = 0,
    _collectionIndex = 0,
  } = input;
  const tenantIds = input._tenantIds ?? (await archActivities.listArchivalTenantIds());
  const byIds = isPatched(IDS_NOT_DOCUMENTS_PATCH);

  let totalBatchesArchived = byIds ? (input._totalBatchesArchived ?? 0) : 0;
  let totalDocumentsArchived = byIds ? (input._totalDocumentsArchived ?? 0) : 0;

  for (let t = _tenantIndex; t < tenantIds.length; t++) {
    const tenantId = tenantIds[t];
    const firstCollection = t === _tenantIndex ? _collectionIndex : 0;
    for (let c = firstCollection; c < collections.length; c++) {
      const collection = collections[c];
      const days = cutoffDays[collection] ?? 365;

      log.info('[Archival] Processing collection', { tenantId, collection, cutoffDays: days });

      while (byIds) {
        const batch = await archiveBatchByIds(tenantId, collection, days, batchSize, storageConfig);
        if (batch.found === 0) break;
        if (batch.skipped) {
          log.warn('[Archival] Every document of the batch was gone before the export; skipped', {
            tenantId,
            collection,
          });
          continue;
        }
        totalBatchesArchived += 1;
        totalDocumentsArchived += batch.archived;
        if (batch.deleted === 0) {
          log.warn('[Archival] The batch was exported but nothing was deleted; next run', {
            tenantId,
            collection,
          });
          break;
        }
        if (batch.found < batchSize) break;
        return continueAsNew<typeof archivalWorkflow>({
          ...input,
          _tenantIds: tenantIds,
          _tenantIndex: t,
          _collectionIndex: c,
          _totalBatchesArchived: totalBatchesArchived,
          _totalDocumentsArchived: totalDocumentsArchived,
        });
      }
      if (byIds) continue;

      let hasMore = true;
      while (hasMore) {
        const docs = await archActivities.findDocumentsForArchival(
          tenantId,
          collection,
          days,
          batchSize,
        );

        if (docs.length === 0) {
          hasMore = false;
          break;
        }

        const dateField = collection === 'audit_events' ? 'timestamp' : 'timestamp';
        const { startDate: startDateStr, endDate: endDateStr } =
          await archActivities.computeDateRange(docs, dateField);
        const startDate = new Date(startDateStr);
        const endDate = new Date(endDateStr);
        const documentIds = docs.map((d) => String(d._id));

        const {
          path: storagePath,
          sizeBytes,
          checksum,
        } = await archActivities.exportBatchToStorage(tenantId, collection, docs, storageConfig);

        await archActivities.deleteArchivedBatch(tenantId, collection, documentIds);

        const batchId = `batch-${collection}-${totalBatchesArchived}`;

        await archActivities.recordArchivalMetadata(tenantId, {
          batchId,
          collection,
          documentCount: docs.length,
          storagePath,
          storageProvider: storageConfig.provider,
          startDate,
          endDate,
          sizeBytes,
          checksum,
        });

        totalBatchesArchived += 1;
        totalDocumentsArchived += docs.length;

        if (docs.length < batchSize) {
          hasMore = false;
        } else {
          return continueAsNew<typeof archivalWorkflow>({
            ...input,
            _tenantIds: tenantIds,
            _tenantIndex: t,
            _collectionIndex: c,
          });
        }
      }
    }
  }

  log.info('[Archival] Complete', {
    totalBatchesArchived,
    totalDocumentsArchived,
  });

  return {
    collectionsProcessed: collections.length,
    totalBatchesArchived,
    totalDocumentsArchived,
  };
}

/**
 * One batch by id (patch archival:ids-not-documents): find the ids and the date range, export the
 * documents read by id, delete them by id, record the batch. `found` is 0 when nothing is left;
 * `deleted` how many the delete removed; `skipped` when the export found none of the documents
 * (patch archival:empty-batch-skipped).
 */
async function archiveBatchByIds(
  tenantId: string,
  collection: string,
  cutoffDays: number,
  batchSize: number,
  storageConfig: ArchivalStorageConfig,
): Promise<{ found: number; archived: number; deleted: number; skipped?: boolean }> {
  const batch = await archActivities.findArchivalBatch(tenantId, collection, cutoffDays, batchSize);
  if (batch.ids.length === 0) return { found: 0, archived: 0, deleted: 0 };

  const exported = await archActivities.exportArchivalBatch(
    tenantId,
    collection,
    batch.ids,
    storageConfig,
  );
  if (exported.documentCount === 0 && isPatched(EMPTY_BATCH_SKIPPED_PATCH)) {
    return { found: batch.ids.length, archived: 0, deleted: 0, skipped: true };
  }
  const deleted = await archActivities.deleteArchivedBatch(tenantId, collection, batch.ids);
  await archActivities.recordArchivalMetadata(tenantId, {
    batchId: exported.batchId,
    collection,
    documentCount: exported.documentCount,
    storagePath: exported.path,
    storageProvider: storageConfig.provider,
    startDate: new Date(batch.startDate as string),
    endDate: new Date(batch.endDate as string),
    sizeBytes: exported.sizeBytes,
    checksum: exported.checksum,
  });
  return { found: batch.ids.length, archived: exported.documentCount, deleted };
}

// --- Task 108 recap: Nightly archival workflow. Export → delete → record. Uses continueAsNew for large datasets.
