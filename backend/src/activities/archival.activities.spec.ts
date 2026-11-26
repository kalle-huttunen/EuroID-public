import mongoose, { Model } from 'mongoose';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import type { TenantService } from '@infrastructure/multi-tenancy/tenant.service';
import type { StorageAdapter } from '@infrastructure/retention/storage/storage.interface';
import {
  ArchivalRecord,
  ArchivalRecordDocument,
  ArchivalRecordSchema,
} from '@infrastructure/retention/schemas/archival-record.schema';
import {
  AuditEvent,
  AuditEventDocument,
  AuditEventSchema,
} from '../modules/audit/schemas/audit-event.schema';
import {
  UserEvent,
  UserEventDocument,
  UserEventSchema,
} from '../modules/identity/schemas/user-event.schema';
import { connectTestDb, clearTestDb, closeTestDb } from '@testing';
import { ArchivalActivities } from './archival.activities';

// Register tenant scoping plugin (normally done by TenantModule at import time)
mongoose.plugin(tenantPlugin);

const OLD = new Date('2020-01-01T00:00:00.000Z');

/**
 * Runs the archival activities against in-memory MongoDB with the tenant plugin active,
 * as the Temporal worker does (activities have no request context of their own).
 */
describe('ArchivalActivities (tenant scoping)', () => {
  let userEventModel: Model<UserEventDocument>;
  let archivalModel: Model<ArchivalRecordDocument>;
  let storage: { upload: jest.Mock };
  let activities: ArchivalActivities;

  beforeAll(async () => {
    await connectTestDb();
    mongoose.set('autoIndex', false);
    userEventModel = mongoose.model(
      UserEvent.name,
      UserEventSchema,
    ) as unknown as Model<UserEventDocument>;
    archivalModel = mongoose.model(
      ArchivalRecord.name,
      ArchivalRecordSchema,
    ) as unknown as Model<ArchivalRecordDocument>;
    const auditModel = mongoose.model(
      AuditEvent.name,
      AuditEventSchema,
    ) as unknown as Model<AuditEventDocument>;
    storage = {
      upload: jest.fn().mockImplementation(async (_buf, key: string) => `s3://bucket/${key}`),
    };
    const tenantService = {
      findAll: jest.fn().mockResolvedValue([{ tenantId: 'tenant-a' }, { tenantId: 'tenant-b' }]),
    };
    activities = new ArchivalActivities(
      auditModel,
      userEventModel,
      archivalModel,
      storage as unknown as StorageAdapter,
      tenantService as unknown as TenantService,
    );
  });

  afterAll(async () => {
    await closeTestDb();
  });

  afterEach(async () => {
    await clearTestDb();
  });

  async function seedUserEvent(tenantId: string, title: string): Promise<string> {
    const doc = await withTenantContext(tenantId, () =>
      userEventModel.create({
        tenantId,
        userId: 'u-1',
        type: 'USER_CREATED',
        severity: 'info',
        timestamp: OLD,
        title,
        actor: 'system',
      }),
    );
    return String(doc._id);
  }

  it('lists the tenants to archive', async () => {
    await expect(activities.listArchivalTenantIds()).resolves.toEqual(['tenant-a', 'tenant-b']);
  });

  it('finds only the given tenant documents', async () => {
    await seedUserEvent('tenant-a', 'a-event');
    await seedUserEvent('tenant-b', 'b-event');

    const found = await activities.findDocumentsForArchival('tenant-a', 'user_events', 30, 100);

    expect(found.map((d) => d.title)).toEqual(['a-event']);
  });

  it('does not delete another tenant documents even when given their ids', async () => {
    const bId = await seedUserEvent('tenant-b', 'b-event');

    const deleted = await activities.deleteArchivedBatch('tenant-a', 'user_events', [bId]);

    expect(deleted).toBe(0);
    const remaining = await withTenantContext('tenant-b', () =>
      userEventModel.countDocuments().exec(),
    );
    expect(remaining).toBe(1);
  });

  it('deletes the tenant own archived documents', async () => {
    const aId = await seedUserEvent('tenant-a', 'a-event');

    await expect(activities.deleteArchivedBatch('tenant-a', 'user_events', [aId])).resolves.toBe(1);
  });

  it('records archival metadata under the tenant', async () => {
    await activities.recordArchivalMetadata('tenant-a', {
      batchId: 'batch-user_events-0',
      collection: 'user_events',
      documentCount: 1,
      storagePath: 's3://bucket/x',
      storageProvider: 's3',
      startDate: OLD,
      endDate: OLD,
      sizeBytes: 10,
      checksum: 'abc',
    });

    const records = await archivalModel.find().setOptions({ skipTenantScope: true }).lean().exec();
    expect(records.map((r) => (r as unknown as { tenantId: string }).tenantId)).toEqual([
      'tenant-a',
    ]);
  });

  it('writes each tenant export under its own storage prefix', async () => {
    const result = await activities.exportBatchToStorage(
      'tenant-a',
      'user_events',
      [{ _id: 'x', title: 'a-event' }],
      { provider: 's3' },
    );

    expect(storage.upload).toHaveBeenCalledWith(
      expect.any(Buffer),
      expect.stringMatching(/^tenant-a\/user_events\//),
    );
    expect(result.path).toMatch(/^s3:\/\/bucket\/tenant-a\/user_events\//);
  });

  /** Three events of one tenant written in the same millisecond, as a bulk operation writes them. */
  async function seedTie(): Promise<string[]> {
    const ids: string[] = [];
    for (const title of ['t1', 't2', 't3']) ids.push(await seedUserEvent('tenant-a', title));
    return ids;
  }

  // Hunt 06 F12 / r2-03 N3: a batch was recorded as [min, max] and later runs skipped every
  // document in an archived range, so rows tied at the cut, or written late with an old
  // timestamp, were never archived and the TTL index deleted them.
  it('finds the rows a full batch left at its last timestamp in the next batch', async () => {
    const ids = await seedTie();

    const first = await activities.findArchivalBatch('tenant-a', 'user_events', 30, 2);
    expect(first).toEqual({
      ids: ids.slice(0, 2),
      startDate: OLD.toISOString(),
      endDate: OLD.toISOString(),
    });
    await activities.deleteArchivedBatch('tenant-a', 'user_events', first.ids);
    await activities.recordArchivalMetadata('tenant-a', {
      batchId: 'b1',
      collection: 'user_events',
      documentCount: 2,
      storagePath: 's3://bucket/b1',
      storageProvider: 's3',
      startDate: OLD,
      endDate: OLD,
      sizeBytes: 1,
      checksum: 'x',
    });

    // The third row is inside the recorded range; it is still found, by both activities
    const next = await activities.findArchivalBatch('tenant-a', 'user_events', 30, 2);
    expect(next.ids).toEqual([ids[2]]);
    const legacy = await activities.findDocumentsForArchival('tenant-a', 'user_events', 30, 2);
    expect(legacy.map((d) => String(d._id))).toEqual([ids[2]]);
  });

  it('answers an empty batch when nothing is older than the cutoff', async () => {
    await expect(activities.findArchivalBatch('tenant-a', 'user_events', 30, 2)).resolves.toEqual({
      ids: [],
    });
  });

  // r2-03 N4: the documents themselves went through workflow history, up to batchSize of them
  // three times per batch. The export now reads them by id inside the activity.
  it("exports the batch's documents read by id in the tenant, under a batch id of its own", async () => {
    const aIds = await seedTie();
    const bId = await seedUserEvent('tenant-b', 'b-event');

    const result = await activities.exportArchivalBatch(
      'tenant-a',
      'user_events',
      [...aIds.slice(0, 2), bId],
      { provider: 's3' },
    );

    expect(result.documentCount).toBe(2);
    const calls = storage.upload.mock.calls;
    const [buffer, key] = calls[calls.length - 1] as [Buffer, string];
    const { gunzipSync } = await import('zlib');
    const lines = gunzipSync(buffer)
      .toString('utf8')
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines.map((d) => d.title)).toEqual(['t1', 't2']);
    expect(key.startsWith('tenant-a/user_events/')).toBe(true);
    expect(key.endsWith(`/${result.batchId}.ndjson.gz`)).toBe(true);
    expect(result.path).toBe(`s3://bucket/${key}`);
    const again = await activities.exportArchivalBatch('tenant-a', 'user_events', [aIds[2]], {
      provider: 's3',
    });
    expect(again.batchId).not.toBe(result.batchId);
  });

  // HX-G follow-up: when every document of a found batch was gone before the export read it (the
  // TTL index, once archival lags), exportBatchToStorage threw "Cannot export empty batch" and the
  // run failed after its retries. The export now answers an empty batch and uploads nothing.
  it('answers an empty export, uploading nothing, when every document of the batch is gone', async () => {
    const goneId = await seedUserEvent('tenant-a', 'gone');
    await withTenantContext('tenant-a', () => userEventModel.deleteMany({}).exec());
    storage.upload.mockClear();

    const result = await activities.exportArchivalBatch('tenant-a', 'user_events', [goneId], {
      provider: 's3',
    });

    expect(result.documentCount).toBe(0);
    expect(storage.upload).not.toHaveBeenCalled();
  });
});
