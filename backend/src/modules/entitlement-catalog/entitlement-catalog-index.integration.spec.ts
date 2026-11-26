/**
 * entitlement_catalog's native id is unique per tenant and system only where a row has one.
 * Policies register the Entra groups they name (by name) before discovery finds their ids, so
 * one system holds several rows without a nativeId; the earlier sparse index counted them all as
 * nativeId null, and creating a second such policy answered 500 (E11000). In-memory MongoDB with
 * the tenant plugin; the migration moves an existing database from the sparse index.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { closeTestDb, testDbName, testDbUri } from '@testing/test-db';
import { MongoClient } from 'mongodb';
import mongoose, { Model } from 'mongoose';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { PolicyService } from '../policy/policy.service';
import { Policy, PolicySchema } from '../policy/schemas/policy.schema';
import type { Policy as PolicyClass } from '../policy/schemas/policy.schema';
import { EntitlementCatalogService } from './entitlement-catalog.service';
import {
  EntitlementCatalog,
  EntitlementCatalogDocument,
  EntitlementCatalogSchema,
} from './schemas/entitlement-catalog.schema';
import { up, down } from '../../../migrations/20261122000001-entitlement-catalog-native-id-index';

mongoose.plugin(tenantPlugin);

const INDEX_NAME = 'tenantId_1_system_1_nativeId_1';
const PARTIAL_FILTER = { nativeId: { $type: 'string' } };

function row(tenantId: string, name: string, nativeId?: string) {
  return {
    tenantId,
    system: 'entra-id',
    name,
    type: 'Group',
    origin: 'POLICY',
    governanceLevel: 'STRICT',
    ...(nativeId ? { nativeId } : {}),
  };
}

/** A draft policy assigning the Entra group `groupName`, as the Policy Engine page sends it. */
function groupPolicy(name: string, groupName: string): Partial<PolicyClass> {
  return {
    name,
    conditionGroups: [],
    actions: [
      {
        id: `${name}-action`,
        type: 'assign_group',
        target: 'entra-id',
        params: { groupId: '', groupName },
      },
    ],
  } as unknown as Partial<PolicyClass>;
}

describe('entitlement_catalog native id index', () => {
  afterAll(async () => {
    await closeTestDb();
  });

  describe('schema', () => {
    let moduleRef: TestingModule;
    let catalogModel: Model<EntitlementCatalogDocument>;
    let policies: PolicyService;

    beforeAll(async () => {
      moduleRef = await Test.createTestingModule({
        imports: [
          MongooseModule.forRoot(testDbUri('schema')),
          MongooseModule.forFeature([
            { name: EntitlementCatalog.name, schema: EntitlementCatalogSchema },
            { name: Policy.name, schema: PolicySchema },
          ]),
        ],
        providers: [
          PolicyService,
          EntitlementCatalogService,
          { provide: DomainEventEmitterService, useValue: { emit: jest.fn() } },
        ],
      }).compile();
      catalogModel = moduleRef.get(getModelToken(EntitlementCatalog.name));
      policies = moduleRef.get(PolicyService);
      await catalogModel.createIndexes();
    });

    afterAll(async () => {
      await moduleRef?.close();
    });

    it('builds the unique index for rows that have a nativeId only', async () => {
      const index = (await catalogModel.collection.indexes()).find((i) => i.name === INDEX_NAME);

      expect(index).toMatchObject({
        key: { tenantId: 1, system: 1, nativeId: 1 },
        unique: true,
        partialFilterExpression: PARTIAL_FILTER,
      });
      expect(index?.sparse).toBeUndefined();
    });

    it('creates a second policy that names another Entra group not yet discovered', async () => {
      await withTenantContext('tenant-a', async () => {
        await policies.create(groupPolicy('Sales access', 'Sales'), 'admin@a.example');
        await expect(
          policies.create(groupPolicy('Finance access', 'Finance'), 'admin@a.example'),
        ).resolves.toMatchObject({ name: 'Finance access' });

        const rows = await catalogModel.find({ system: 'entra-id' }).lean().exec();
        expect(rows.map((r) => [r.name, r.origin, r.nativeId])).toEqual(
          expect.arrayContaining([
            ['Sales', 'POLICY', undefined],
            ['Finance', 'POLICY', undefined],
          ]),
        );
      });
    });

    it('rejects a second row with the same nativeId on one system of one tenant', async () => {
      await catalogModel.create(row('tenant-b', 'Sales', 'obj-1'));

      await expect(
        catalogModel.create(row('tenant-b', 'Sales copy', 'obj-1')),
      ).rejects.toMatchObject({ code: 11000 });
      await expect(catalogModel.create(row('tenant-c', 'Sales', 'obj-1'))).resolves.toBeDefined();
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

    /** A database with the sparse index the schema used to build, and one row without a nativeId. */
    async function sparseDb(name: string) {
      const db = client.db(testDbName(name));
      const catalog = db.collection('entitlement_catalog');
      await catalog.createIndex(
        { tenantId: 1, system: 1, nativeId: 1 },
        { name: INDEX_NAME, unique: true, sparse: true },
      );
      await catalog.insertMany([row('tenant-a', 'Sales'), row('tenant-a', 'Engineering', 'obj-9')]);
      await expect(catalog.insertOne(row('tenant-a', 'Finance'))).rejects.toMatchObject({
        code: 11000,
      });
      return db;
    }

    it('replaces the sparse index: rows without a nativeId fit, native ids stay unique', async () => {
      const db = await sparseDb('migration-sparse');

      await up(db);
      await up(db);

      const catalog = db.collection('entitlement_catalog');
      const index = (await catalog.indexes()).find((i) => i.name === INDEX_NAME);
      expect(index).toMatchObject({ unique: true, partialFilterExpression: PARTIAL_FILTER });
      await expect(catalog.insertOne(row('tenant-a', 'Finance'))).resolves.toBeDefined();
      await expect(catalog.insertOne(row('tenant-a', 'Eng copy', 'obj-9'))).rejects.toMatchObject({
        code: 11000,
      });
      expect(await catalog.countDocuments()).toBe(3);
    });

    it('accepts the index Mongoose already built, and a database without the collection', async () => {
      const connection = await mongoose
        .createConnection(testDbUri('migration-after-autoindex'), { autoIndex: false })
        .asPromise();
      try {
        await connection.model(EntitlementCatalog.name, EntitlementCatalogSchema).createIndexes();
        await expect(
          up(client.db(testDbName('migration-after-autoindex'))),
        ).resolves.toBeUndefined();
      } finally {
        await connection.close();
      }

      await up(client.db(testDbName('migration-empty')));
      const index = (
        await client.db(testDbName('migration-empty')).collection('entitlement_catalog').indexes()
      ).find((i) => i.name === INDEX_NAME);
      expect(index).toMatchObject({ partialFilterExpression: PARTIAL_FILTER });
    });

    it('down restores the sparse index while each system has at most one row without a nativeId', async () => {
      const db = await sparseDb('migration-down');
      await up(db);

      await down(db);

      const index = (await db.collection('entitlement_catalog').indexes()).find(
        (i) => i.name === INDEX_NAME,
      );
      expect(index).toMatchObject({ unique: true, sparse: true });
      expect(index?.partialFilterExpression).toBeUndefined();
    });
  });
});
