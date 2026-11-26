import { closeTestDb, testDbName, testDbUri } from '@testing/test-db';
import { MongoClient } from 'mongodb';
import mongoose from 'mongoose';
import { JoinerEvent, JoinerEventSchema } from './schemas/joiner-event.schema';
import { up, down } from '../../../migrations/20261123000000-joiner-events-one-per-hire';

const OLD_INDEX = 'tenantId_1_identityId_1';
const NEW_INDEX = 'tenantId_1_identityId_1_rehiredAt_1';
const REHIRED_AT = new Date('2026-11-23T10:00:00.000Z');

function joiner(identityId: string, rehiredAt?: Date) {
  return {
    tenantId: 'tenant-a',
    identityId,
    sourceName: 'csv-hr',
    status: 'waiting',
    open: true,
    detectedAt: new Date(),
    ...(rehiredAt ? { rehiredAt } : {}),
  };
}

/**
 * One joiner per identity and hire: an identity keeps the joiner of its first hire, and a rehire
 * an HR sync revives gets a joiner of its own. The old `{ tenantId, identityId }` unique index
 * refused it. Runs on the mongodb-memory-server binary.
 */
describe('joiner_events uniqueness per hire', () => {
  afterAll(async () => {
    await closeTestDb();
  });

  describe('schema', () => {
    let connection: mongoose.Connection;
    let EventModel: mongoose.Model<unknown>;

    beforeAll(async () => {
      connection = await mongoose
        .createConnection(testDbUri('schema'), { autoIndex: false })
        .asPromise();
      EventModel = connection.model(JoinerEvent.name, JoinerEventSchema) as mongoose.Model<unknown>;
      await EventModel.createIndexes();
    });

    afterAll(async () => {
      await connection?.close();
    });

    it('builds the per-hire unique index and not the per-identity one', async () => {
      const indexes = await EventModel.collection.indexes();

      expect(indexes.find((i) => i.name === NEW_INDEX)).toMatchObject({
        key: { tenantId: 1, identityId: 1, rehiredAt: 1 },
        unique: true,
      });
      expect(indexes.find((i) => i.name === OLD_INDEX)).toBeUndefined();
    });

    it('takes a rehire joiner next to the first hire, and refuses a second one of either', async () => {
      await EventModel.create(joiner('id-1'));
      await expect(EventModel.create(joiner('id-1', REHIRED_AT))).resolves.toBeDefined();

      await expect(EventModel.create(joiner('id-1'))).rejects.toMatchObject({ code: 11000 });
      await expect(EventModel.create(joiner('id-1', REHIRED_AT))).rejects.toMatchObject({
        code: 11000,
      });
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

    /** The index the previous schema built: one joiner per identity, ever. */
    async function legacyCollection(dbName: string) {
      const events = client.db(testDbName(dbName)).collection('joiner_events');
      await events.createIndex({ tenantId: 1, identityId: 1 }, { name: OLD_INDEX, unique: true });
      return events;
    }

    it('replaces the per-identity index, keeps existing joiners, and is safe to rerun', async () => {
      const events = await legacyCollection('migration-legacy');
      await events.insertOne(joiner('id-1'));
      await expect(events.insertOne(joiner('id-1', REHIRED_AT))).rejects.toMatchObject({
        code: 11000,
      });

      await up(client.db(testDbName('migration-legacy')));
      await up(client.db(testDbName('migration-legacy')));

      const names = (await events.indexes()).map((i) => i.name);
      expect(names).not.toContain(OLD_INDEX);
      expect(names).toContain(NEW_INDEX);
      await expect(events.insertOne(joiner('id-1', REHIRED_AT))).resolves.toBeDefined();
      await expect(events.insertOne(joiner('id-1'))).rejects.toMatchObject({ code: 11000 });
    });

    it('does nothing harmful on a deployment without a joiner_events collection', async () => {
      await expect(up(client.db(testDbName('migration-empty')))).resolves.toBeUndefined();
    });

    it('down restores the per-identity index while no identity has a rehire joiner', async () => {
      const events = await legacyCollection('migration-down');
      await events.insertOne(joiner('id-1'));
      await up(client.db(testDbName('migration-down')));

      await down(client.db(testDbName('migration-down')));

      expect((await events.indexes()).find((i) => i.name === OLD_INDEX)).toMatchObject({
        unique: true,
      });
    });
  });
});
