/**
 * One SCIM group per tenant and display name (r2-02 N6; in-memory MongoDB, tenant plugin, the
 * real EntitlementCatalogService).
 *
 * createScimGroup checked for a group with the name and then inserted one, on a non-unique index,
 * so an IdP retrying POST /scim/v2/Groups (or two at once) made duplicate groups. The unique
 * partial index makes the insert the claim: the loser answers 409. Migration
 * 20261125000004-scim-group-unique-name merges existing duplicates into the oldest group, moving
 * their members, the access requests and the nesting groups that name them.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { MongoClient, ObjectId } from 'mongodb';
import mongoose, { Model } from 'mongoose';
import { closeTestDb, testDbName, testDbUri } from '@testing/test-db';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { EntitlementCatalogService } from './entitlement-catalog.service';
import {
  EntitlementCatalog,
  EntitlementCatalogDocument,
  EntitlementCatalogSchema,
} from './schemas/entitlement-catalog.schema';
import { up, down } from '../../../migrations/20261125000004-scim-group-unique-name';

mongoose.plugin(tenantPlugin);

const A = 'tenant-a';
const B = 'tenant-b';
const INDEX = 'scim_group_name_unique';

describe('SCIM groups: one per tenant and name', () => {
  afterAll(async () => {
    await closeTestDb();
  });

  describe('create', () => {
    let moduleRef: TestingModule;
    let catalog: EntitlementCatalogService;
    let model: Model<EntitlementCatalogDocument>;

    beforeAll(async () => {
      moduleRef = await Test.createTestingModule({
        imports: [
          MongooseModule.forRoot(testDbUri('create')),
          MongooseModule.forFeature([
            { name: EntitlementCatalog.name, schema: EntitlementCatalogSchema },
          ]),
        ],
        providers: [
          EntitlementCatalogService,
          { provide: DomainEventEmitterService, useValue: { emit: jest.fn() } },
        ],
      }).compile();
      catalog = moduleRef.get(EntitlementCatalogService);
      model = moduleRef.get(getModelToken(EntitlementCatalog.name));
      await model.init();
    });

    afterAll(async () => {
      await moduleRef.close();
    });

    it('of two creates of one name at once, one makes the group and the other gets none', async () => {
      // Both look the name up before either inserts (an IdP retrying at once)
      let arrived = 0;
      let release!: () => void;
      const bothLooked = new Promise<void>((resolve) => (release = resolve));
      const findOne = model.findOne.bind(model);
      const spy = jest.spyOn(model, 'findOne').mockImplementation(((
        ...args: Parameters<typeof model.findOne>
      ) => {
        const query = findOne(...args);
        return {
          exec: async () => {
            const found = await query.exec();
            if (++arrived === 2) release();
            await bothLooked;
            return found;
          },
        };
      }) as never);

      const results = await Promise.all(
        [1, 2].map(() =>
          withTenantContext(A, () => catalog.createScimGroup({ name: 'Engineers' })),
        ),
      );

      spy.mockRestore();

      expect(results.filter(Boolean)).toHaveLength(1);
      expect(
        await model
          .countDocuments({ system: 'scim-inbound', name: 'Engineers' })
          .setOptions({ skipTenantScope: true }),
      ).toBe(1);
    });

    it('refuses renaming a group to a name another group has (E11000, SCIM 409 uniqueness)', async () => {
      const other = await withTenantContext(A, () => catalog.createScimGroup({ name: 'Leads' }));

      await expect(
        withTenantContext(A, () =>
          catalog.updateScimGroup(String(other!._id), { name: 'Engineers' }),
        ),
      ).rejects.toMatchObject({ code: 11000 });
    });

    it('lets another tenant have a group of the same name', async () => {
      const made = await withTenantContext(B, () => catalog.createScimGroup({ name: 'Engineers' }));

      expect(made).not.toBeNull();
    });
  });

  describe('migration', () => {
    let client: MongoClient;

    beforeAll(async () => {
      client = await MongoClient.connect(testDbUri());
    });

    afterAll(async () => {
      await client?.close();
    });

    const id = (n: number) => new ObjectId(n.toString(16).padStart(24, '0'));
    const group = (
      n: number,
      tenantId: string,
      name: string,
      metadata: object,
      ageDays: number,
    ) => ({
      _id: id(n),
      tenantId,
      system: 'scim-inbound',
      type: 'Group',
      name,
      origin: 'EXTERNAL',
      governanceLevel: 'OPEN',
      createdAt: new Date(Date.UTC(2026, 0, 1) + ageDays * 86_400_000),
      metadata,
    });

    async function legacy(label: string) {
      const db = client.db(testDbName(label));
      await db.collection('entitlement_catalog').insertMany([
        // Three "Engineers" in tenant A: 2 is the oldest
        group(1, A, 'Engineers', { scimMembers: ['u2', 'u3'], externalId: 'ext-1' }, 5),
        group(2, A, 'Engineers', { scimMembers: ['u1', 'u2'] }, 1),
        group(
          3,
          A,
          'Engineers',
          { scimMembers: ['u4'], scimMemberTypes: [{ value: 'u4', type: 'User' }] },
          9,
        ),
        // A group nesting one of the duplicates
        group(
          4,
          A,
          'All staff',
          {
            scimMembers: [String(id(3)), 'u9'],
            scimMemberTypes: [{ value: String(id(3)), type: 'Group' }],
          },
          2,
        ),
        // Another tenant's group of that name is no duplicate
        group(5, B, 'Engineers', { scimMembers: ['b1'] }, 0),
      ]);
      await db.collection('access_requests').insertOne({
        tenantId: A,
        requestId: 'req-1',
        status: 'ACTIVE',
        entitlements: [
          { catalogEntryId: String(id(3)), system: 'scim-inbound', entitlementName: 'Engineers' },
          { catalogEntryId: 'other', system: 'entra-id', entitlementName: 'Other' },
        ],
      });
      return db;
    }

    it('merges a tenant’s groups of one name into the oldest, moving members and references', async () => {
      const db = await legacy('migration-merge');

      await up(db);
      await up(db);

      const groups = await db
        .collection('entitlement_catalog')
        .find({}, { sort: { _id: 1 } })
        .toArray();
      expect(groups.map((g) => String(g._id))).toEqual([id(2), id(4), id(5)].map(String));
      const kept = groups[0];
      expect(kept.metadata).toEqual({
        scimMembers: ['u1', 'u2', 'u3', 'u4'],
        scimMemberTypes: [{ value: 'u4', type: 'User' }],
        externalId: 'ext-1',
      });
      expect(groups[1].metadata).toEqual({
        scimMembers: [String(id(2)), 'u9'],
        scimMemberTypes: [{ value: String(id(2)), type: 'Group' }],
      });
      expect(groups[2].metadata).toEqual({ scimMembers: ['b1'] });
      const request = await db.collection('access_requests').findOne({ requestId: 'req-1' });
      expect(
        request?.entitlements.map((e: { catalogEntryId: string }) => e.catalogEntryId),
      ).toEqual([String(id(2)), 'other']);
    });

    it('builds the unique index, so a second group of the name is refused', async () => {
      const db = await legacy('migration-index');

      await up(db);

      const index = (await db.collection('entitlement_catalog').indexes()).find(
        (i) => i.name === INDEX,
      );
      expect(index).toMatchObject({
        unique: true,
        key: { tenantId: 1, name: 1 },
        partialFilterExpression: { system: 'scim-inbound', type: 'Group' },
      });
      await expect(
        db.collection('entitlement_catalog').insertOne(group(6, A, 'Engineers', {}, 20)),
      ).rejects.toMatchObject({ code: 11000 });
      // Other systems may repeat a name
      await db.collection('entitlement_catalog').insertMany([
        { tenantId: A, system: 'entra-id', type: 'Group', name: 'Engineers' },
        { tenantId: A, system: 'entra-id', type: 'Group', name: 'Engineers' },
      ]);
    });

    it('does nothing on a database without the collection, and down drops the index', async () => {
      await expect(up(client.db(testDbName('migration-empty')))).resolves.toBeUndefined();
      const db = await legacy('migration-down');
      await up(db);

      await down(db);

      const names = (await db.collection('entitlement_catalog').indexes()).map((i) => i.name);
      expect(names).not.toContain(INDEX);
    });
  });
});
