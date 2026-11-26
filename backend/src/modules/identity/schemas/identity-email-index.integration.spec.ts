import { closeTestDb, testDbName, testDbUri } from '@testing/test-db';
import { MongoClient } from 'mongodb';
import mongoose from 'mongoose';
import { Identity, IdentitySchema } from './identity.schema';
import { up, down } from '../../../../migrations/20261123000001-identity-email-unique-among-live';

const INDEX_NAME = 'tenantId_1_profile.email_1';
const DELETED_AT = new Date('2026-06-01T10:00:00Z');

function identity(tenantId: string, email: string, deletedAt?: Date | null) {
  return {
    tenantId,
    profile: { firstName: 'Test', lastName: 'User', email },
    ...(deletedAt !== undefined ? { deletedAt } : {}),
  };
}

/**
 * The email is unique per tenant among live identities only. The unique index counted
 * soft-deleted identities too, so a new hire could never take a former employee's address: the
 * HR row was minted and failed on the index at every sync. Live identities have no `deletedAt`
 * or `deletedAt: null` (a merge undo unsets it); `{ deletedAt: null }` matches both. Runs on
 * the mongodb-memory-server binary (MongoDB 8.2).
 */
describe('identities profile.email unique index among live identities', () => {
  afterAll(async () => {
    await closeTestDb();
  });

  describe('schema', () => {
    let connection: mongoose.Connection;
    let IdentityModel: mongoose.Model<unknown>;

    beforeAll(async () => {
      connection = await mongoose
        .createConnection(testDbUri('schema'), { autoIndex: false })
        .asPromise();
      IdentityModel = connection.model(Identity.name, IdentitySchema) as mongoose.Model<unknown>;
      await IdentityModel.createIndexes();
    });

    afterAll(async () => {
      await connection?.close();
    });

    it('creates the unique index over live identities', async () => {
      const index = (await IdentityModel.collection.indexes()).find((i) => i.name === INDEX_NAME);

      expect(index).toMatchObject({
        key: { tenantId: 1, 'profile.email': 1 },
        unique: true,
        partialFilterExpression: { deletedAt: null },
      });
    });

    it.each([
      ['no deletedAt', undefined],
      ['deletedAt null', null],
    ])('rejects a second live identity (%s) with the same email', async (_label, deletedAt) => {
      const email = `live-${String(deletedAt)}@example.com`;
      await IdentityModel.create(identity('tenant-a', email));

      await expect(
        IdentityModel.create(identity('tenant-a', email, deletedAt)),
      ).rejects.toMatchObject({ code: 11000 });
    });

    it('gives a live identity the email of a soft-deleted one, and keeps deleted ones apart', async () => {
      await IdentityModel.create(identity('tenant-b', 'former@example.com', DELETED_AT));
      await IdentityModel.create(identity('tenant-b', 'former@example.com', new Date()));

      await expect(
        IdentityModel.create(identity('tenant-b', 'former@example.com')),
      ).resolves.toBeDefined();
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

    /** A database with the index every existing deployment has: unique, deleted ones included. */
    async function databaseWithOldIndex(name: string) {
      const db = client.db(testDbName(name));
      await db
        .collection('identities')
        .insertMany([
          identity('tenant-a', 'former@example.com', DELETED_AT),
          identity('tenant-a', 'live@example.com'),
        ]);
      await db
        .collection('identities')
        .createIndex({ tenantId: 1, 'profile.email': 1 }, { name: INDEX_NAME, unique: true });
      return db;
    }

    it('replaces the old index, keeps every identity, and is safe to rerun', async () => {
      const db = await databaseWithOldIndex('migration-old-index');
      const identities = db.collection('identities');
      await expect(
        identities.insertOne(identity('tenant-a', 'former@example.com')),
      ).rejects.toMatchObject({ code: 11000 });

      await up(db);
      await up(db);

      const index = (await identities.indexes()).find((i) => i.name === INDEX_NAME);
      expect(index).toMatchObject({ unique: true, partialFilterExpression: { deletedAt: null } });
      expect(await identities.countDocuments()).toBe(2);
      await expect(
        identities.insertOne(identity('tenant-a', 'former@example.com')),
      ).resolves.toBeDefined();
      await expect(
        identities.insertOne(identity('tenant-a', 'live@example.com', null)),
      ).rejects.toMatchObject({ code: 11000 });
    });

    it('creates the index on a database without one, and accepts the one Mongoose built', async () => {
      await up(client.db(testDbName('migration-empty')));
      const created = (
        await client.db(testDbName('migration-empty')).collection('identities').indexes()
      ).find((i) => i.name === INDEX_NAME);
      expect(created).toMatchObject({ partialFilterExpression: { deletedAt: null } });

      const connection = await mongoose
        .createConnection(testDbUri('migration-after-autoindex'), { autoIndex: false })
        .asPromise();
      try {
        await connection.model(Identity.name, IdentitySchema).createIndexes();
        await expect(
          up(client.db(testDbName('migration-after-autoindex'))),
        ).resolves.toBeUndefined();
      } finally {
        await connection.close();
      }
    });

    it('goes back to the old index while no live identity shares an email with a deleted one', async () => {
      const db = await databaseWithOldIndex('migration-down');
      await up(db);

      await down(db);

      const index = (await db.collection('identities').indexes()).find(
        (i) => i.name === INDEX_NAME,
      );
      expect(index).toMatchObject({ unique: true });
      expect(index?.partialFilterExpression).toBeUndefined();
    });

    it('refuses to go back, changing nothing, once a live identity has a deleted one email', async () => {
      const db = await databaseWithOldIndex('migration-down-shared');
      await up(db);
      await db.collection('identities').insertOne(identity('tenant-a', 'former@example.com'));

      await expect(down(db)).rejects.toThrow('tenant-a (1 shared)');

      const index = (await db.collection('identities').indexes()).find(
        (i) => i.name === INDEX_NAME,
      );
      expect(index).toMatchObject({ partialFilterExpression: { deletedAt: null } });
    });
  });
});
