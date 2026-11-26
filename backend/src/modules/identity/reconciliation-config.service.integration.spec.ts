/**
 * Reconciliation config source names (in-memory MongoDB).
 *
 * Hunt 2026-11-25 02 F11: `hrSourceTags` and `sourcePriorityOrder` were stored as typed, and
 * every consumer compares them with lower-cased source names (`toSourceName`), so an admin who
 * typed `Workday` got no HR match: the source became a target with fill semantics, and the
 * primary-HR logic and contract-critical writes broke without a word. The config now stores them
 * lower-cased, and a config stored before is read lower-cased.
 */
import mongoose, { Model } from 'mongoose';
import { connectTestDb, closeTestDb } from '@testing';
import {
  ReconciliationConfig,
  ReconciliationConfigSchema,
  type ReconciliationConfigDocument,
} from './schemas/reconciliation-config.schema';
import { ReconciliationConfigService } from './reconciliation-config.service';
import { UpsertReconciliationConfigSchema } from './dtos/reconciliation-config.dto';

describe('Reconciliation config source names (MongoDB)', () => {
  let model: Model<ReconciliationConfigDocument>;
  let service: ReconciliationConfigService;

  beforeAll(async () => {
    await connectTestDb();
    model = mongoose.model(
      `${ReconciliationConfig.name}F11`,
      ReconciliationConfigSchema,
      'reconciliation_configs_f11',
    ) as unknown as Model<ReconciliationConfigDocument>;
    service = new ReconciliationConfigService(model);
  });

  afterEach(async () => {
    await model.collection.deleteMany({});
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('reads source names stored in another case lower-cased', async () => {
    await model.collection.insertOne({
      tenantId: 'tenant-a',
      hrSourceTags: ['Workday', ' CSV-HR'],
      sourcePriorityOrder: ['Workday', 'Entra-ID'],
      contractCriticalFields: ['departmentName'],
      defaultMastery: {},
      targetIdKeys: [],
    });

    expect(await service.getHrSourceTags('tenant-a')).toEqual(['workday', 'csv-hr']);
    const config = await service.getConfig('tenant-a');
    expect(config?.hrSourceTags).toEqual(['workday', 'csv-hr']);
    expect(config?.sourcePriorityOrder).toEqual(['workday', 'entra-id']);
    // Field names keep their case: they are profile keys
    expect(config?.contractCriticalFields).toEqual(['departmentName']);
  });

  it('stores the source names of a saved config lower-cased', async () => {
    const dto = UpsertReconciliationConfigSchema.parse({
      hrSourceTags: [' Workday '],
      sourcePriorityOrder: ['Workday', 'CSV-HR'],
      contractCriticalFields: [],
      defaultMastery: {},
      targetIdKeys: [],
    });
    await service.upsertConfig('tenant-a', dto);

    const stored = await model.collection.findOne({ tenantId: 'tenant-a' });
    expect(stored?.hrSourceTags).toEqual(['workday']);
    expect(stored?.sourcePriorityOrder).toEqual(['workday', 'csv-hr']);
  });
});
