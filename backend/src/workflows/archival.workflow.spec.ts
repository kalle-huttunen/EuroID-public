/**
 * Archival Workflow Tests — pure Jest mocks (same approach as onboarding.workflow.spec.ts).
 * Asserts the workflow archives each tenant separately and resumes correctly via continueAsNew.
 */

const mockActivities: Record<string, jest.Mock> = {};
const mockContinueAsNew = jest.fn();
/** workflow.patched(): false replays a history from before the patch, true is a run started now. */
const mockPatched = jest.fn((_id: string) => false);

jest.mock('@temporalio/workflow', () => ({
  proxyActivities: jest.fn(
    () =>
      new Proxy(
        {},
        {
          get: (_target: unknown, prop: string) => {
            if (!mockActivities[prop]) mockActivities[prop] = jest.fn();
            return (...args: unknown[]) => mockActivities[prop](...args);
          },
        },
      ),
  ),
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  continueAsNew: (...args: unknown[]) => mockContinueAsNew(...args),
  patched: (id: string) => mockPatched(id),
  deprecatePatch: jest.fn(),
}));

import { archivalWorkflow, ArchivalWorkflowInput } from './archival.workflow';

const BASE_INPUT: ArchivalWorkflowInput = {
  collections: ['audit_events', 'user_events'],
  cutoffDays: { audit_events: 365, user_events: 180 },
  storageConfig: { provider: 's3', bucket: 'archive' },
  batchSize: 2,
};

function docs(count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, i) => ({
    _id: `id-${i}`,
    timestamp: '2025-01-01T00:00:00.000Z',
  }));
}

describe('archivalWorkflow', () => {
  beforeEach(() => {
    for (const key of Object.keys(mockActivities)) delete mockActivities[key];
    mockContinueAsNew.mockReset();
    mockPatched.mockReset().mockReturnValue(false);
    mockActivities.listArchivalTenantIds = jest.fn().mockResolvedValue(['tenant-a', 'tenant-b']);
    mockActivities.findDocumentsForArchival = jest.fn().mockResolvedValue([]);
    mockActivities.computeDateRange = jest.fn().mockResolvedValue({
      startDate: '2025-01-01T00:00:00.000Z',
      endDate: '2025-01-01T00:00:00.000Z',
    });
    mockActivities.exportBatchToStorage = jest
      .fn()
      .mockResolvedValue({ path: 's3://archive/x', sizeBytes: 10, checksum: 'abc' });
    mockActivities.deleteArchivedBatch = jest.fn().mockResolvedValue(1);
    mockActivities.recordArchivalMetadata = jest.fn().mockResolvedValue(undefined);
  });

  it('archives every collection of every tenant inside that tenant', async () => {
    mockActivities.findDocumentsForArchival.mockImplementation(
      async (tenantId: string, collection: string) =>
        tenantId === 'tenant-b' && collection === 'user_events' ? docs(1) : [],
    );

    const result = await archivalWorkflow(BASE_INPUT);

    expect(mockActivities.findDocumentsForArchival.mock.calls).toEqual([
      ['tenant-a', 'audit_events', 365, 2],
      ['tenant-a', 'user_events', 180, 2],
      ['tenant-b', 'audit_events', 365, 2],
      ['tenant-b', 'user_events', 180, 2],
    ]);
    expect(mockActivities.exportBatchToStorage).toHaveBeenCalledWith(
      'tenant-b',
      'user_events',
      docs(1),
      BASE_INPUT.storageConfig,
    );
    expect(mockActivities.deleteArchivedBatch).toHaveBeenCalledWith('tenant-b', 'user_events', [
      'id-0',
    ]);
    expect(mockActivities.recordArchivalMetadata).toHaveBeenCalledWith(
      'tenant-b',
      expect.objectContaining({ collection: 'user_events', documentCount: 1 }),
    );
    expect(result).toEqual({
      collectionsProcessed: 2,
      totalBatchesArchived: 1,
      totalDocumentsArchived: 1,
    });
  });

  it('continues as new with the resolved tenants and current position after a full batch', async () => {
    mockActivities.findDocumentsForArchival.mockImplementation(
      async (tenantId: string, collection: string) =>
        tenantId === 'tenant-b' && collection === 'audit_events' ? docs(2) : [],
    );

    await archivalWorkflow(BASE_INPUT);

    expect(mockContinueAsNew).toHaveBeenCalledWith({
      ...BASE_INPUT,
      _tenantIds: ['tenant-a', 'tenant-b'],
      _tenantIndex: 1,
      _collectionIndex: 0,
    });
  });

  it('resumes at the saved tenant and collection without listing tenants again', async () => {
    await archivalWorkflow({
      ...BASE_INPUT,
      _tenantIds: ['tenant-a', 'tenant-b'],
      _tenantIndex: 1,
      _collectionIndex: 1,
    });

    expect(mockActivities.listArchivalTenantIds).not.toHaveBeenCalled();
    expect(mockActivities.findDocumentsForArchival.mock.calls).toEqual([
      ['tenant-b', 'user_events', 180, 2],
    ]);
  });

  it('does nothing when there are no tenants', async () => {
    mockActivities.listArchivalTenantIds.mockResolvedValue([]);

    const result = await archivalWorkflow(BASE_INPUT);

    expect(mockActivities.findDocumentsForArchival).not.toHaveBeenCalled();
    expect(result.totalBatchesArchived).toBe(0);
  });

  // Hunt 06 F12, r2-03 N3 and N4
  describe('runs started with the patch archival:ids-not-documents', () => {
    const RANGE = { startDate: '2025-01-01T00:00:00.000Z', endDate: '2025-01-02T00:00:00.000Z' };

    beforeEach(() => {
      mockPatched.mockImplementation((id: string) => id === 'archival:ids-not-documents');
      mockActivities.findArchivalBatch = jest.fn().mockResolvedValue({ ids: [] });
      mockActivities.exportArchivalBatch = jest
        .fn()
        .mockImplementation(async (tenantId: string, collection: string, ids: string[]) => ({
          path: `s3://archive/${tenantId}/${collection}/batch-${ids.join('-')}.ndjson.gz`,
          sizeBytes: 10,
          checksum: 'abc',
          documentCount: ids.length,
          batchId: `batch-${ids.join('-')}`,
        }));
      mockActivities.deleteArchivedBatch = jest
        .fn()
        .mockImplementation(async (_t: string, _c: string, ids: string[]) => ids.length);
    });

    it('passes ids from activity to activity, never the documents, under the export batch id', async () => {
      mockActivities.findArchivalBatch.mockImplementation(
        async (tenantId: string, collection: string) =>
          tenantId === 'tenant-b' && collection === 'user_events'
            ? { ids: ['id-0'], ...RANGE }
            : { ids: [] },
      );

      const result = await archivalWorkflow(BASE_INPUT);

      expect(mockActivities.findArchivalBatch.mock.calls).toEqual([
        ['tenant-a', 'audit_events', 365, 2],
        ['tenant-a', 'user_events', 180, 2],
        ['tenant-b', 'audit_events', 365, 2],
        ['tenant-b', 'user_events', 180, 2],
      ]);
      expect(mockActivities.exportArchivalBatch).toHaveBeenCalledWith(
        'tenant-b',
        'user_events',
        ['id-0'],
        BASE_INPUT.storageConfig,
      );
      expect(mockActivities.deleteArchivedBatch).toHaveBeenCalledWith('tenant-b', 'user_events', [
        'id-0',
      ]);
      expect(mockActivities.recordArchivalMetadata).toHaveBeenCalledWith('tenant-b', {
        batchId: 'batch-id-0',
        collection: 'user_events',
        documentCount: 1,
        storagePath: 's3://archive/tenant-b/user_events/batch-id-0.ndjson.gz',
        storageProvider: 's3',
        startDate: new Date(RANGE.startDate),
        endDate: new Date(RANGE.endDate),
        sizeBytes: 10,
        checksum: 'abc',
      });
      // The pre-patch activities, which take or return the documents, are not called
      expect(mockActivities.findDocumentsForArchival).not.toHaveBeenCalled();
      expect(mockActivities.computeDateRange).not.toHaveBeenCalled();
      expect(mockActivities.exportBatchToStorage).not.toHaveBeenCalled();
      expect(result).toEqual({
        collectionsProcessed: 2,
        totalBatchesArchived: 1,
        totalDocumentsArchived: 1,
      });
    });

    it('carries the totals through continueAsNew, so the last run reports the whole chain', async () => {
      mockActivities.findArchivalBatch.mockResolvedValueOnce({ ids: ['id-0', 'id-1'], ...RANGE });

      await archivalWorkflow(BASE_INPUT);

      expect(mockContinueAsNew).toHaveBeenCalledWith({
        ...BASE_INPUT,
        _tenantIds: ['tenant-a', 'tenant-b'],
        _tenantIndex: 0,
        _collectionIndex: 0,
        _totalBatchesArchived: 1,
        _totalDocumentsArchived: 2,
      });

      mockActivities.findArchivalBatch
        .mockReset()
        .mockResolvedValueOnce({ ids: ['id-2'], ...RANGE });
      mockActivities.findArchivalBatch.mockResolvedValue({ ids: [] });
      const last = await archivalWorkflow(mockContinueAsNew.mock.calls[0][0]);
      expect(last).toEqual({
        collectionsProcessed: 2,
        totalBatchesArchived: 2,
        totalDocumentsArchived: 3,
      });
    });

    it('moves on to the next collection when a batch was exported but nothing deleted', async () => {
      mockActivities.findArchivalBatch.mockImplementation(async (_t: string, collection: string) =>
        collection === 'audit_events' ? { ids: ['id-0', 'id-1'], ...RANGE } : { ids: [] },
      );
      mockActivities.deleteArchivedBatch.mockResolvedValue(0);

      await archivalWorkflow(BASE_INPUT);

      // Once per tenant, not again and again over the same documents
      expect(
        mockActivities.findArchivalBatch.mock.calls.filter(([, c]) => c === 'audit_events'),
      ).toHaveLength(2);
      expect(mockContinueAsNew).not.toHaveBeenCalled();
    });

    // HX-G follow-up: a batch whose documents were all gone before the export read them (the TTL
    // index) failed the run. With the patch archival:empty-batch-skipped it is skipped: nothing is
    // deleted or recorded for it, it is not counted, and the next batch is looked for.
    it('skips a batch whose documents were all gone before the export, and goes on', async () => {
      mockPatched.mockImplementation(
        (id: string) =>
          id === 'archival:ids-not-documents' || id === 'archival:empty-batch-skipped',
      );
      mockActivities.findArchivalBatch.mockImplementationOnce(async () => ({
        ids: ['gone-0', 'gone-1'],
        ...RANGE,
      }));
      mockActivities.findArchivalBatch.mockImplementationOnce(async () => ({
        ids: ['id-2'],
        ...RANGE,
      }));
      mockActivities.exportArchivalBatch.mockImplementationOnce(async () => ({
        path: '',
        sizeBytes: 0,
        checksum: '',
        documentCount: 0,
        batchId: '',
      }));

      const result = await archivalWorkflow(BASE_INPUT);

      expect(mockActivities.deleteArchivedBatch.mock.calls).toEqual([
        ['tenant-a', 'audit_events', ['id-2']],
      ]);
      expect(mockActivities.recordArchivalMetadata).toHaveBeenCalledTimes(1);
      expect(mockActivities.recordArchivalMetadata).toHaveBeenCalledWith(
        'tenant-a',
        expect.objectContaining({ batchId: 'batch-id-2', documentCount: 1 }),
      );
      expect(result).toEqual({
        collectionsProcessed: 2,
        totalBatchesArchived: 1,
        totalDocumentsArchived: 1,
      });
    });

    it('treats an empty export as before in a history from before archival:empty-batch-skipped', async () => {
      mockActivities.findArchivalBatch.mockImplementationOnce(async () => ({
        ids: ['gone-0'],
        ...RANGE,
      }));
      mockActivities.exportArchivalBatch.mockImplementationOnce(async () => ({
        path: '',
        sizeBytes: 0,
        checksum: '',
        documentCount: 0,
        batchId: '',
      }));
      mockActivities.deleteArchivedBatch.mockResolvedValueOnce(0);

      await archivalWorkflow(BASE_INPUT);

      expect(mockActivities.deleteArchivedBatch).toHaveBeenCalledWith('tenant-a', 'audit_events', [
        'gone-0',
      ]);
      expect(mockActivities.recordArchivalMetadata).toHaveBeenCalledTimes(1);
    });
  });
});
