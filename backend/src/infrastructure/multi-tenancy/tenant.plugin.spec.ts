import { Mongoose, Schema, createConnection } from 'mongoose';
import { closeTestDb, testDbUri } from '@testing/test-db';
import { tenantPlugin } from './tenant.plugin';
import { withTenantContext } from './tenant-context.helper';

const TestSchema = new Schema({
  name: { type: String, required: true },
  n: { type: Number, default: 0 },
});
tenantPlugin(TestSchema);

const SkipPluginSchema = new Schema({
  name: { type: String, required: true },
});
(SkipPluginSchema as any).set('skipTenantPlugin', true);
tenantPlugin(SkipPluginSchema);

describe('tenantPlugin', () => {
  let connection: Awaited<ReturnType<typeof createConnection>>;
  let TestModel: ReturnType<typeof connection.model>;

  beforeAll(async () => {
    connection = await createConnection(testDbUri()).asPromise();
    TestModel = connection.model('TenantPluginTest', TestSchema);
  });

  afterAll(async () => {
    await connection.dropDatabase();
    await connection.close();
    await closeTestDb();
  });

  beforeEach(async () => {
    await TestModel.deleteMany({}).setOptions({ skipTenantScope: true } as any);
  });

  describe('query middleware', () => {
    it('should inject tenantId filter when context is set', async () => {
      // The same name in two tenants: only the context's tenant's document comes back.
      await TestModel.create([
        { name: 'Doc1', tenantId: 'tenant-b' },
        { name: 'Doc1', tenantId: 'tenant-a' },
      ]);

      let found: any[] = [];
      await withTenantContext('tenant-a', async () => {
        found = await TestModel.find({ name: 'Doc1' }).lean().exec();
      });

      expect(found).toHaveLength(1);
      expect((found[0] as { tenantId: string }).tenantId).toBe('tenant-a');
    });

    it('should throw when context is missing (never fail open)', async () => {
      await TestModel.create([{ name: 'DocNoCtx', tenantId: 'tenant-orphan' }]);

      await expect(TestModel.find({ name: 'DocNoCtx' }).lean().exec()).rejects.toThrow(
        /Tenant context required/,
      );
    });

    it('should skip tenantId when skipTenantScope option is set', async () => {
      await TestModel.create([
        { name: 'DocT1', tenantId: 'tenant-1' },
        { name: 'DocT2', tenantId: 'tenant-2' },
      ]);

      const found = await TestModel.find({ name: 'DocT1' })
        .setOptions({ skipTenantScope: true } as any)
        .lean()
        .exec();

      expect(found).toHaveLength(1);
    });
  });

  // Every query operation the plugin scopes, run in tenant-a's context over a document of
  // tenant-a and one of tenant-b with the same name. tenant-b's is inserted first, so an unscoped
  // single-document operation would reach it.
  describe('every scoped query operation', () => {
    const SAME = { name: 'same' };
    type Stored = { tenantId: string; n: number };

    beforeEach(async () => {
      await TestModel.insertMany([
        { name: 'same', tenantId: 'tenant-b' },
        { name: 'same', tenantId: 'tenant-a' },
      ]);
    });

    /** Each document as "tenant:n", read without the scope. */
    const stored = async () =>
      (await TestModel.find({}).setOptions({ skipTenantScope: true }).lean<Stored[]>().exec())
        .map((d) => `${d.tenantId}:${d.n}`)
        .sort();

    it.each<[string, () => Promise<unknown>, unknown]>([
      [
        'find',
        async () => (await TestModel.find(SAME).lean<Stored[]>().exec()).map((d) => d.tenantId),
        ['tenant-a'],
      ],
      [
        'findOne',
        async () => (await TestModel.findOne(SAME).lean<Stored>().exec())?.tenantId,
        'tenant-a',
      ],
      ['countDocuments', () => TestModel.countDocuments(SAME).exec(), 1],
      ['distinct', () => TestModel.distinct('tenantId', SAME).exec(), ['tenant-a']],
    ])('%s reads only the tenant of the context', async (_op, read, expected) => {
      await expect(withTenantContext('tenant-a', read)).resolves.toEqual(expected);
    });

    it.each<[string, () => Promise<unknown>, string[]]>([
      [
        'findOneAndUpdate',
        () => TestModel.findOneAndUpdate(SAME, { $set: { n: 1 } }).exec(),
        ['tenant-a:1', 'tenant-b:0'],
      ],
      ['findOneAndDelete', () => TestModel.findOneAndDelete(SAME).exec(), ['tenant-b:0']],
      [
        'findOneAndReplace',
        () =>
          TestModel.findOneAndReplace(SAME, { name: 'same', n: 2, tenantId: 'tenant-a' }).exec(),
        ['tenant-a:2', 'tenant-b:0'],
      ],
      [
        'updateOne',
        () => TestModel.updateOne(SAME, { $set: { n: 1 } }).exec(),
        ['tenant-a:1', 'tenant-b:0'],
      ],
      [
        'updateMany',
        () => TestModel.updateMany(SAME, { $set: { n: 1 } }).exec(),
        ['tenant-a:1', 'tenant-b:0'],
      ],
      ['deleteOne', () => TestModel.deleteOne(SAME).exec(), ['tenant-b:0']],
      ['deleteMany', () => TestModel.deleteMany(SAME).exec(), ['tenant-b:0']],
    ])('%s changes only the tenant of the context', async (_op, write, after) => {
      await withTenantContext('tenant-a', write);

      expect(await stored()).toEqual(after);
    });

    // A tenantId the caller names is kept, so it must be a plain string: an operator such as
    // { $gt: '' } would match every tenant.
    it.each<[string, () => Promise<unknown>]>([
      [
        'find',
        () =>
          TestModel.find({ tenantId: { $gt: '' } })
            .lean()
            .exec(),
      ],
      ['deleteMany', () => TestModel.deleteMany({ tenantId: { $gt: '' } }).exec()],
    ])('%s refuses an operator in place of the tenantId', async (_op, run) => {
      await expect(withTenantContext('tenant-a', run)).rejects.toThrow(
        'Invalid tenantId: must be a non-empty string.',
      );
      expect(await stored()).toEqual(['tenant-a:0', 'tenant-b:0']);
    });
  });

  describe('save middleware', () => {
    it('should auto-set tenantId on new document from context', async () => {
      let doc: any;
      await withTenantContext('tenant-save', async () => {
        doc = new TestModel({ name: 'NewDoc' });
        await doc.save();
      });

      expect(doc.tenantId).toBe('tenant-save');
      let fromDb: any;
      await withTenantContext('tenant-save', async () => {
        fromDb = await TestModel.findOne({ name: 'NewDoc' }).lean().exec();
      });
      expect(fromDb?.tenantId).toBe('tenant-save');
    });
  });

  describe('skipTenantPlugin', () => {
    it('should not add tenantId or scope when schema has skipTenantPlugin', async () => {
      const SkipModel = connection.model('SkipPluginTest', SkipPluginSchema);
      await SkipModel.create([{ name: 'NoTenant' }]);

      const found = await SkipModel.find({ name: 'NoTenant' }).lean().exec();
      expect(found).toHaveLength(1);
      expect((found[0] as { tenantId?: string }).tenantId).toBeUndefined();
    });
  });

  describe('aggregate middleware', () => {
    it('should prepend $match with tenantId to aggregate pipeline', async () => {
      await withTenantContext('tenant-agg-a', async () => {
        await TestModel.create([
          { name: 'AggA1', tenantId: 'tenant-agg-a' },
          { name: 'AggA2', tenantId: 'tenant-agg-a' },
        ]);
      });
      await withTenantContext('tenant-agg-b', async () => {
        await TestModel.create([{ name: 'AggB1', tenantId: 'tenant-agg-b' }]);
      });

      let results: any[] = [];
      await withTenantContext('tenant-agg-a', async () => {
        results = await TestModel.aggregate([
          { $group: { _id: '$tenantId', count: { $sum: 1 } } },
        ]).exec();
      });

      expect(results).toHaveLength(1);
      expect(results[0]._id).toBe('tenant-agg-a');
      expect(results[0].count).toBe(2);
    });

    it('should throw when context is missing for aggregate', async () => {
      await expect(
        TestModel.aggregate([{ $group: { _id: null, count: { $sum: 1 } } }]).exec(),
      ).rejects.toThrow(/Tenant context required for aggregate/);
    });

    it('should skip tenant scoping when skipTenantScope option is set', async () => {
      await withTenantContext('tenant-agg-skip1', async () => {
        await TestModel.create([{ name: 'SkipAgg1', tenantId: 'tenant-agg-skip1' }]);
      });
      await withTenantContext('tenant-agg-skip2', async () => {
        await TestModel.create([{ name: 'SkipAgg2', tenantId: 'tenant-agg-skip2' }]);
      });

      const results = await TestModel.aggregate([
        { $match: { name: { $regex: /^SkipAgg/ } } },
        { $group: { _id: '$tenantId', count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ])
        .option({ skipTenantScope: true })
        .exec();

      expect(results.length).toBeGreaterThanOrEqual(2);
    });
  });

  // Registered globally as TenantModule does, Mongoose applies the plugin to embedded schemas
  // too. A subdocument belongs to its parent's tenant: only the top-level document is stamped.
  describe('subdocuments (plugin registered globally)', () => {
    const SettingsSchema = new Schema({ maxAgeDays: Number }, { _id: false });
    const EntrySchema = new Schema({ label: String }, { _id: false });
    let ParentModel: ReturnType<typeof connection.model>;

    beforeAll(() => {
      const runtime = new Mongoose();
      runtime.plugin(tenantPlugin);
      const ParentSchema = new runtime.Schema({
        name: { type: String, required: true },
        settings: { type: SettingsSchema },
        entries: { type: [EntrySchema] },
      });
      ParentModel = runtime.createConnection(testDbUri()).model('TenantPluginParent', ParentSchema);
    });

    afterAll(async () => {
      await ParentModel.db.dropDatabase();
      await ParentModel.db.close();
    });

    it('stamps the document and leaves its subdocuments without a tenantId', async () => {
      await withTenantContext('tenant-sub', async () => {
        await ParentModel.create({
          name: 'Policy',
          settings: { maxAgeDays: 90 },
          entries: [{ label: 'a' }, { label: 'b' }],
        });
      });

      const stored = await ParentModel.findOne({ name: 'Policy' })
        .setOptions({ skipTenantScope: true })
        .lean()
        .exec();
      expect(stored).toMatchObject({ name: 'Policy', tenantId: 'tenant-sub' });
      expect(stored).toEqual(
        expect.objectContaining({
          settings: { maxAgeDays: 90 },
          entries: [{ label: 'a' }, { label: 'b' }],
        }),
      );
    });

    it('saves a document with its own tenantId and subdocuments outside a tenant context', async () => {
      // A poller has no request context; the document names its tenant itself
      await ParentModel.create({
        name: 'FromPoller',
        tenantId: 'tenant-poller',
        settings: { maxAgeDays: 30 },
        entries: [{ label: 'c' }],
      });

      const stored = await ParentModel.findOne({ name: 'FromPoller' })
        .setOptions({ skipTenantScope: true })
        .lean()
        .exec();
      expect(stored).toMatchObject({ tenantId: 'tenant-poller', settings: { maxAgeDays: 30 } });
    });

    it('still refuses a document without a tenantId outside a tenant context', async () => {
      await expect(
        ParentModel.create({ name: 'Orphan', settings: { maxAgeDays: 30 } }),
      ).rejects.toThrow(/Tenant context required/);
    });
  });

  // Mongoose applies a global plugin to each embedded schema after the model's own. The plugin
  // gave every embedded schema an indexed tenantId, so Mongoose built indexes such as
  // sources.tenantId_1 that no query uses and every write maintains.
  describe('embedded schemas (plugin registered globally)', () => {
    const NoteSchema = new Schema({ text: String }, { _id: false });
    const StepSchema = new Schema({ label: String, note: { type: NoteSchema } }, { _id: false });
    const LimitsSchema = new Schema({ max: Number }, { _id: false });
    const OwnedSettingsSchema = new Schema({ maxAgeDays: Number }, { _id: false });

    /** Compiles a model as TenantModule's global registration does. */
    function compile(name: string, schema: Schema) {
      const runtime = new Mongoose();
      runtime.plugin(tenantPlugin);
      return runtime.model(name, schema);
    }

    const indexedPaths = (schema: Schema) => schema.indexes().flatMap(([key]) => Object.keys(key));

    it('adds tenantId and its index to the model schema only, at any depth', () => {
      const model = compile(
        'TenantPluginEmbedded',
        new Schema({
          name: String,
          steps: { type: [StepSchema] },
          limits: { type: LimitsSchema },
          byKey: { type: Map, of: OwnedSettingsSchema },
        }),
      );

      expect(model.schema.path('tenantId')).toBeDefined();
      expect(indexedPaths(model.schema)).toContain('tenantId');
      expect(indexedPaths(model.schema).filter((p) => p.endsWith('.tenantId'))).toEqual([]);
      for (const embedded of [StepSchema, NoteSchema, LimitsSchema, OwnedSettingsSchema]) {
        expect(embedded.path('tenantId')).toBeUndefined();
      }
    });

    // Tenant and AdminUser skip the plugin; what they embed has no tenant of its own either.
    it('adds nothing to the schemas embedded in a schema that skips the plugin', () => {
      const ChildSchema = new Schema({ minLength: Number }, { _id: false });
      const parent = new Schema({ name: String, policy: { type: ChildSchema } });
      parent.set('skipTenantPlugin', true);
      const model = compile('TenantPluginSkippedParent', parent);

      expect(model.schema.path('tenantId')).toBeUndefined();
      expect(ChildSchema.path('tenantId')).toBeUndefined();
      expect(indexedPaths(model.schema)).toEqual([]);
    });
  });

  describe('insertMany middleware', () => {
    it('should set tenantId on all documents in insertMany', async () => {
      const docs = [{ name: 'Bulk1' }, { name: 'Bulk2' }];

      await withTenantContext('tenant-bulk', async () => {
        await TestModel.insertMany(docs);
      });

      const found = await TestModel.find({ name: { $in: ['Bulk1', 'Bulk2'] } })
        .setOptions({ skipTenantScope: true } as any)
        .lean()
        .exec();

      expect(found).toHaveLength(2);
      expect(found.every((d: any) => d.tenantId === 'tenant-bulk')).toBe(true);
    });
  });
});
