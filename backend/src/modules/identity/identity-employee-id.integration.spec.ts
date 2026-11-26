/**
 * Live identities by HR employee id (in-memory MongoDB, tenant plugin): the lookup an access
 * review makes for a manager named only by managerId (IdentityQueryService
 * findEmailsByEmployeeIds), and migration 20261126000004, which builds the index it reads with
 * the key and options the schema declares.
 */
import mongoose, { Model } from 'mongoose';
import type { Db } from 'mongodb';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import type { LoggerFactoryService } from '@infrastructure/observability/contextual-logger.service';
import { connectTestDb, closeTestDb, createMockLoggerFactory } from '@testing';
import { up, down } from '../../../migrations/20261126000004-identity-employee-id-index';
import { IdentitySchema, type IdentityDocument } from './schemas/identity.schema';
import { IdentityQueryService } from './identity-query.service';
import {
  EMPLOYEE_ID_INDEX,
  EMPLOYEE_ID_INDEX_KEY,
  liveEmployeeIdFilter,
} from './identity-employee-id';

mongoose.plugin(tenantPlugin);

const A = 'tenant-a';
const B = 'tenant-b';

describe('Identities by employee id (MongoDB)', () => {
  let db: Db;
  let identityModel: Model<IdentityDocument>;
  let query: IdentityQueryService;
  const identities = () => db.collection('identities');
  const indexOf = async () =>
    (await identities().indexes()).find((i) => i.name === EMPLOYEE_ID_INDEX);

  beforeAll(async () => {
    await connectTestDb();
    db = mongoose.connection.db as unknown as Db;
    // The migration builds the index under test; the others are irrelevant here
    mongoose.set('autoIndex', false);
    identityModel = mongoose.model(
      'Identity',
      IdentitySchema,
    ) as unknown as Model<IdentityDocument>;
    query = new IdentityQueryService(
      identityModel,
      createMockLoggerFactory().factory as unknown as LoggerFactoryService,
    );
  });

  beforeEach(async () => {
    const exists = await db.listCollections({ name: 'identities' }).hasNext();
    if (exists) await identities().drop();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  const seed = (tenantId: string, employeeId: string, email: string, deletedAt?: Date) =>
    identities().insertOne({
      tenantId,
      profile: { firstName: 'P', lastName: 'Q', email, employeeId },
      ...(deletedAt ? { deletedAt } : {}),
    });

  describe('findEmailsByEmployeeIds', () => {
    it("answers the email of the tenant's one live identity with each employee id", async () => {
      await seed(A, 'E-1', 'max@a.example');
      await seed(A, 'E-2', 'mia@a.example');
      await seed(B, 'E-3', 'ola@b.example');

      const found = await withTenantContext(A, () =>
        query.findEmailsByEmployeeIds(['E-1', ' E-2 ', 'E-3', 'E-9', '']),
      );

      expect(found).toEqual(
        new Map([
          ['E-1', 'max@a.example'],
          ['E-2', 'mia@a.example'],
        ]),
      );
    });

    it('leaves out an id two live identities carry, and ignores deleted ones', async () => {
      await seed(A, 'E-1', 'max@a.example');
      await seed(A, 'E-1', 'max.other@a.example');
      await seed(A, 'E-2', 'former@a.example', new Date());
      await seed(A, 'E-2', 'mia@a.example');

      const found = await withTenantContext(A, () => query.findEmailsByEmployeeIds(['E-1', 'E-2']));

      expect(found).toEqual(new Map([['E-2', 'mia@a.example']]));
    });

    it('asks nothing for no ids', async () => {
      const find = jest.spyOn(identityModel, 'find');
      expect(await withTenantContext(A, () => query.findEmailsByEmployeeIds([]))).toEqual(
        new Map(),
      );
      expect(find).not.toHaveBeenCalled();
      find.mockRestore();
    });
  });

  describe('migration 20261126000004', () => {
    it('builds the index the schema declares, read by the lookup, and is safe to rerun', async () => {
      await seed(A, 'E-1', 'max@a.example');

      await up(db);
      await up(db);

      expect((await indexOf())?.key).toEqual(EMPLOYEE_ID_INDEX_KEY);
      const declared = IdentitySchema.indexes().find(([key]) => 'profile.employeeId' in key);
      expect(declared?.[0]).toEqual(EMPLOYEE_ID_INDEX_KEY);
      const plan = JSON.stringify(
        await identities()
          .find(liveEmployeeIdFilter(A, ['E-1']))
          .explain('queryPlanner'),
      );
      expect(plan).toContain(EMPLOYEE_ID_INDEX);
      expect(plan).not.toContain('COLLSCAN');
    });

    it('drops the index on down, and down without it changes nothing', async () => {
      await up(db);
      await down(db);
      expect(await indexOf()).toBeUndefined();
      await expect(down(db)).resolves.toBeUndefined();
    });
  });
});
