/**
 * The nightly cold-storage archival, on the time-skipping Temporal test server with mocked
 * activities. Opt-in via TEMPORAL_E2E=1.
 *
 * Before the patch archival:ids-not-documents each batch passed up to batchSize full documents
 * through workflow history three times (findDocumentsForArchival's result, then the arguments of
 * computeDateRange and exportBatchToStorage), which a large batch could push past Temporal's
 * payload limit; its batch id `batch-<collection>-<n>` restarted at 0 after each continueAsNew;
 * and the last run reported only its own totals (hunt r2-03 N4).
 *
 * Proves, for runs started now:
 *   - Only document ids go from activity to activity; the export reads the documents itself, and
 *     the batch is recorded under the export's own batch id.
 *   - The totals are carried through continueAsNew: the chain's last run reports them all.
 *   - A history recorded before the patch still replays.
 *
 * Fixture test/fixtures/archival-pre-ids-not-documents.history.json was recorded with the
 * pre-patch workflow (commit c3add417), from backend/:
 *   git show c3add417:backend/src/workflows/archival.workflow.ts \
 *     > src/workflows/archival-pre-ids.workflow.ts
 *   TEMPORAL_E2E=1 ARCHIVAL_FIXTURE_WORKFLOW=src/workflows/archival-pre-ids.workflow.ts \
 *     npx jest -c test/jest-e2e.json archival.workflow -t 'records the pre-patch fixture'
 *   rm src/workflows/archival-pre-ids.workflow.ts
 *
 * Before the patch archival:empty-batch-skipped a batch whose documents were all gone before the
 * export read them (the TTL index, once archival lags) failed the run: the export threw. The
 * export now answers `documentCount: 0`, and runs started with the patch skip such a batch and
 * look for the next one. Fixture test/fixtures/archival-pre-empty-batch-skipped.history.json was
 * recorded with the workflow before that patch (commit 091ef717) and an export answering an
 * empty batch, from backend/:
 *   git show 091ef717:backend/src/workflows/archival.workflow.ts \
 *     > src/workflows/archival-pre-empty-skip.workflow.ts
 *   TEMPORAL_E2E=1 ARCHIVAL_EMPTY_FIXTURE_WORKFLOW=src/workflows/archival-pre-empty-skip.workflow.ts \
 *     npx jest -c test/jest-e2e.json archival.workflow -t 'records the pre-empty-batch fixture'
 *   rm src/workflows/archival-pre-empty-skip.workflow.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { Worker } from '@temporalio/worker';
import {
  createWorkflowTestHarness,
  describeTemporalE2E,
  type WorkflowTestHarness,
  type WorkflowTestHarnessOptions,
} from '../helpers/workflow-test-env';
import { historyJSON } from '../helpers/history-json';

const WORKFLOWS_PATH = path.resolve(__dirname, '../../src/workflows/archival.workflow.ts');
const PRE_PATCH_HISTORY = path.resolve(
  __dirname,
  '../fixtures/archival-pre-ids-not-documents.history.json',
);
const PRE_EMPTY_SKIP_HISTORY = path.resolve(
  __dirname,
  '../fixtures/archival-pre-empty-batch-skipped.history.json',
);
/** What exportArchivalBatch answers when every document of the batch was gone. */
const EMPTY_EXPORT = { path: '', sizeBytes: 0, checksum: '', documentCount: 0, batchId: '' };
const INPUT = {
  collections: ['audit_events', 'user_events'],
  cutoffDays: { audit_events: 365, user_events: 180 },
  storageConfig: { provider: 's3', bucket: 'archive' },
  batchSize: 2,
};
const RANGE = { startDate: '2025-01-01T00:00:00.000Z', endDate: '2025-01-02T00:00:00.000Z' };

describeTemporalE2E('archival workflow (e2e)', () => {
  let harness: WorkflowTestHarness;
  const findArchivalBatch = jest.fn();
  const exportArchivalBatch = jest.fn();
  const deleteArchivedBatch = jest.fn();
  const recordArchivalMetadata = jest.fn();
  /** The pre-patch activities: the documents themselves go through history. */
  const findDocumentsForArchival = jest.fn();

  const workers = (): Omit<WorkflowTestHarnessOptions, 'workflowsPath'> => ({
    activities: {
      listArchivalTenantIds: async () => ['tenant-a'],
      findArchivalBatch: (...args: unknown[]) => findArchivalBatch(...args),
      exportArchivalBatch: (...args: unknown[]) => exportArchivalBatch(...args),
      deleteArchivedBatch: (...args: unknown[]) => deleteArchivedBatch(...args),
      recordArchivalMetadata: (...args: unknown[]) => recordArchivalMetadata(...args),
      findDocumentsForArchival: (...args: unknown[]) => findDocumentsForArchival(...args),
      computeDateRange: async () => RANGE,
      exportBatchToStorage: async () => ({
        path: 's3://archive/tenant-a/audit_events/2025/01/batch-1-abc.ndjson.gz',
        sizeBytes: 10,
        checksum: 'abc',
      }),
    },
  });

  beforeAll(async () => {
    harness = await createWorkflowTestHarness({ workflowsPath: WORKFLOWS_PATH, ...workers() });
  }, 120_000);

  afterAll(async () => {
    await harness?.shutdown();
  }, 30_000);

  beforeEach(() => {
    findArchivalBatch.mockReset().mockResolvedValue({ ids: [] });
    exportArchivalBatch
      .mockReset()
      .mockImplementation(async (tenantId: string, collection: string, ids: string[]) => ({
        path: `s3://archive/${tenantId}/${collection}/2025/01/batch-${ids.join('-')}.ndjson.gz`,
        sizeBytes: 10,
        checksum: 'abc',
        documentCount: ids.length,
        batchId: `batch-${ids.join('-')}`,
      }));
    deleteArchivedBatch
      .mockReset()
      .mockImplementation(async (_t: string, _c: string, ids: string[]) => ids.length);
    recordArchivalMetadata.mockReset().mockResolvedValue(undefined);
    findDocumentsForArchival.mockReset().mockResolvedValue([]);
  });

  const archive = (h: WorkflowTestHarness, workflowId: string) =>
    h.env.client.workflow.start('archivalWorkflow', {
      taskQueue: h.taskQueue,
      workflowId,
      args: [INPUT],
    });

  it('passes ids, not documents, and records the batch under the export batch id', async () => {
    findArchivalBatch.mockImplementation(async (_tenant: string, collection: string) =>
      collection === 'user_events' ? { ids: ['u1'], ...RANGE } : { ids: [] },
    );

    const handle = await archive(harness, 'archival-e2e-by-ids');
    await expect(handle.result()).resolves.toEqual({
      collectionsProcessed: 2,
      totalBatchesArchived: 1,
      totalDocumentsArchived: 1,
    });

    expect(exportArchivalBatch).toHaveBeenCalledWith(
      'tenant-a',
      'user_events',
      ['u1'],
      INPUT.storageConfig,
    );
    expect(deleteArchivedBatch).toHaveBeenCalledWith('tenant-a', 'user_events', ['u1']);
    expect(recordArchivalMetadata).toHaveBeenCalledWith(
      'tenant-a',
      expect.objectContaining({ batchId: 'batch-u1', documentCount: 1 }),
    );
    expect(findDocumentsForArchival).not.toHaveBeenCalled();
  }, 60_000);

  it('carries the totals through continueAsNew to the last run of the chain', async () => {
    findArchivalBatch
      .mockResolvedValueOnce({ ids: ['a1', 'a2'], ...RANGE })
      .mockResolvedValueOnce({ ids: ['a3'], ...RANGE });

    const handle = await archive(harness, 'archival-e2e-totals');
    // result() follows the continued run
    await expect(handle.result()).resolves.toEqual({
      collectionsProcessed: 2,
      totalBatchesArchived: 2,
      totalDocumentsArchived: 3,
    });
    expect(recordArchivalMetadata.mock.calls.map(([, m]) => m.batchId)).toEqual([
      'batch-a1-a2',
      'batch-a3',
    ]);
  }, 60_000);

  it('skips a batch whose documents were all gone before the export, and archives the next', async () => {
    findArchivalBatch
      .mockResolvedValueOnce({ ids: ['g1', 'g2'], ...RANGE })
      .mockResolvedValueOnce({ ids: ['a3'], ...RANGE });
    exportArchivalBatch.mockResolvedValueOnce(EMPTY_EXPORT);

    const handle = await archive(harness, 'archival-e2e-empty-batch-skipped');
    await expect(handle.result()).resolves.toEqual({
      collectionsProcessed: 2,
      totalBatchesArchived: 1,
      totalDocumentsArchived: 1,
    });
    expect(deleteArchivedBatch.mock.calls).toEqual([['tenant-a', 'audit_events', ['a3']]]);
    expect(recordArchivalMetadata.mock.calls.map(([, m]) => m.batchId)).toEqual(['batch-a3']);
  }, 60_000);

  it('replays a history recorded before the patch archival:empty-batch-skipped', async () => {
    const history = JSON.parse(fs.readFileSync(PRE_EMPTY_SKIP_HISTORY, 'utf8'));
    await expect(
      Worker.runReplayHistory({ workflowsPath: WORKFLOWS_PATH }, history),
    ).resolves.toBeUndefined();
  }, 60_000);

  const emptyFixtureWorkflow = process.env.ARCHIVAL_EMPTY_FIXTURE_WORKFLOW;
  (emptyFixtureWorkflow ? it : it.skip)(
    'records the pre-empty-batch fixture (ARCHIVAL_EMPTY_FIXTURE_WORKFLOW = the pre-patch workflow file)',
    async () => {
      findArchivalBatch.mockResolvedValueOnce({ ids: ['g1'], ...RANGE });
      exportArchivalBatch.mockResolvedValueOnce(EMPTY_EXPORT);
      deleteArchivedBatch.mockResolvedValueOnce(0);
      const pre = await createWorkflowTestHarness({
        workflowsPath: path.resolve(process.cwd(), emptyFixtureWorkflow ?? ''),
        ...workers(),
      });
      try {
        const handle = await archive(pre, 'archival-e2e-pre-empty-batch-skipped');
        // The pre-patch code deletes by the ids, records the empty batch and counts it
        await expect(handle.result()).resolves.toEqual({
          collectionsProcessed: 2,
          totalBatchesArchived: 1,
          totalDocumentsArchived: 0,
        });
        expect(deleteArchivedBatch).toHaveBeenCalledWith('tenant-a', 'audit_events', ['g1']);
        fs.writeFileSync(PRE_EMPTY_SKIP_HISTORY, historyJSON(await handle.fetchHistory()));
      } finally {
        await pre.shutdown();
      }
    },
    120_000,
  );

  it('replays a history recorded before the patch archival:ids-not-documents', async () => {
    const history = JSON.parse(fs.readFileSync(PRE_PATCH_HISTORY, 'utf8'));
    await expect(
      Worker.runReplayHistory({ workflowsPath: WORKFLOWS_PATH }, history),
    ).resolves.toBeUndefined();
  }, 60_000);

  const fixtureWorkflow = process.env.ARCHIVAL_FIXTURE_WORKFLOW;
  (fixtureWorkflow ? it : it.skip)(
    'records the pre-patch fixture (ARCHIVAL_FIXTURE_WORKFLOW = the pre-patch workflow file)',
    async () => {
      findDocumentsForArchival.mockImplementation(async (_t: string, collection: string) =>
        collection === 'audit_events'
          ? [{ _id: '64b7f0c2a1b2c3d4e5f60c01', timestamp: RANGE.startDate }]
          : [],
      );
      const pre = await createWorkflowTestHarness({
        workflowsPath: path.resolve(process.cwd(), fixtureWorkflow ?? ''),
        ...workers(),
      });
      try {
        const handle = await archive(pre, 'archival-e2e-pre-ids-not-documents');
        // The pre-patch code: the documents go through history, the batch id is counted
        await expect(handle.result()).resolves.toEqual({
          collectionsProcessed: 2,
          totalBatchesArchived: 1,
          totalDocumentsArchived: 1,
        });
        expect(recordArchivalMetadata).toHaveBeenCalledWith(
          'tenant-a',
          expect.objectContaining({ batchId: 'batch-audit_events-0' }),
        );
        fs.writeFileSync(PRE_PATCH_HISTORY, historyJSON(await handle.fetchHistory()));
      } finally {
        await pre.shutdown();
      }
    },
    120_000,
  );
});
