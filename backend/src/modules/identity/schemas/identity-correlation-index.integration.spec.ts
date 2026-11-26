import { closeTestDb, testDbName, testDbUri } from '@testing/test-db';
import { MongoClient } from 'mongodb';
import mongoose from 'mongoose';
import { Identity, IdentitySchema } from './identity.schema';
import { up } from '../../../../migrations/20261121000000-identity-correlation-id-unique-index';

const INDEX_NAME = 'tenantId_1_profile.correlationId_1';

function identity(tenantId: string, email: string, correlationId?: string) {
  return {
    tenantId,
    profile: { firstName: 'Test', lastName: 'User', email, correlationId },
  };
}

/**
 * Per-tenant uniqueness of profile.correlationId (hashed national ID). MongoDB rejects `$ne`
 * in a partial index, so the earlier `$ne: null` filter left the index silently missing.
 * Runs on the mongodb-memory-server binary; set MONGOMS_SYSTEM_BINARY to run it on another
 * server version (verified on 7.0).
 */
describe('identities profile.correlationId unique index', () => {
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

    it('creates the unique partial index', async () => {
      const index = (await IdentityModel.collection.indexes()).find((i) => i.name === INDEX_NAME);

      expect(index).toMatchObject({
        key: { tenantId: 1, 'profile.correlationId': 1 },
        unique: true,
        partialFilterExpression: { 'profile.correlationId': { $type: 'string' } },
      });
    });

    it('rejects a second identity with the same correlationId in the same tenant', async () => {
      await IdentityModel.create(identity('tenant-a', 'ada@example.com', 'hash-1'));

      await expect(
        IdentityModel.create(identity('tenant-a', 'ada.l@example.com', 'hash-1')),
      ).rejects.toMatchObject({ code: 11000 });
    });

    it('allows the same correlationId in different tenants', async () => {
      await IdentityModel.create(identity('tenant-b', 'ada@example.com', 'hash-2'));

      await expect(
        IdentityModel.create(identity('tenant-c', 'ada@example.com', 'hash-2')),
      ).resolves.toBeDefined();
    });

    it('allows many identities without a correlationId in one tenant', async () => {
      await IdentityModel.create(identity('tenant-d', 'one@example.com'));

      await expect(
        IdentityModel.create(identity('tenant-d', 'two@example.com')),
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

    it('fails without changing data when a tenant already has duplicates, listing them', async () => {
      const db = client.db(testDbName('migration-duplicates'));
      await db
        .collection('identities')
        .insertMany([
          identity('tenant-a', 'one@example.com', 'hash-dup'),
          identity('tenant-a', 'two@example.com', 'hash-dup'),
          identity('tenant-b', 'three@example.com', 'hash-dup'),
          identity('tenant-a', 'four@example.com'),
          identity('tenant-a', 'five@example.com'),
        ]);

      await expect(up(db)).rejects.toThrow(
        /tenantId=tenant-a correlationId=hash-dup \(2 identities\)/,
      );
      const indexNames = (await db.collection('identities').indexes()).map((i) => i.name);
      expect(indexNames).not.toContain(INDEX_NAME);
      expect(await db.collection('identities').countDocuments()).toBe(5);
    });

    it('creates the index when there are no duplicates, and is safe to rerun', async () => {
      const db = client.db(testDbName('migration-clean'));
      await db
        .collection('identities')
        .insertMany([
          identity('tenant-a', 'one@example.com', 'hash-1'),
          identity('tenant-b', 'two@example.com', 'hash-1'),
        ]);

      await up(db);
      await up(db);

      const index = (await db.collection('identities').indexes()).find(
        (i) => i.name === INDEX_NAME,
      );
      expect(index).toMatchObject({ unique: true });
      await expect(
        db.collection('identities').insertOne(identity('tenant-a', 'three@example.com', 'hash-1')),
      ).rejects.toMatchObject({ code: 11000 });
    });

    it('accepts the index Mongoose already built from the schema', async () => {
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
  });
});
