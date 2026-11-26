import mongoose, { Schema } from 'mongoose';
import { closeTestDb, connectTestDb, testDbName, testDbUri } from './test-db';

/**
 * One in-memory MongoDB per jest run (test/mongo-global-setup.ts), a database per suite: suites
 * share the server, so a database, and the unique indexes built in it, must not leak from one
 * suite into another, and a duplicate key must still fail with E11000.
 */
describe('test-db: a database per suite on the run-wide server', () => {
  const ThingSchema = new Schema({ key: { type: String, unique: true } });
  const connections: mongoose.Connection[] = [];
  const open = async (uri: string) => {
    const connection = await mongoose.createConnection(uri).asPromise();
    connections.push(connection);
    return connection;
  };
  const dbOf = (uri: string) => new URL(uri).pathname.slice(1);

  afterAll(async () => {
    await Promise.all(connections.map((c) => c.close()));
    await closeTestDb();
  });

  it('gives each testDbUri() call its own database on the same server', () => {
    const a = testDbUri();
    const b = testDbUri();

    expect(new URL(a).host).toBe(new URL(process.env.TEST_MONGO_URI as string).host);
    expect(new URL(b).host).toBe(new URL(a).host);
    expect(dbOf(a)).toMatch(new RegExp(`^t_${process.env.JEST_WORKER_ID}_[0-9a-f]{8}$`));
    expect(dbOf(b)).not.toBe(dbOf(a));
  });

  it('gives the same database for the same label within the suite, a different one per label', () => {
    expect(testDbName('schema')).toBe(testDbName('schema'));
    expect(testDbName('migration')).not.toBe(testDbName('schema'));
    expect(dbOf(testDbUri('schema'))).toBe(testDbName('schema'));
    expect(testDbName('schema')).toMatch(
      new RegExp(`^t_${process.env.JEST_WORKER_ID}_[0-9a-f]{8}_schema$`),
    );
  });

  it('keeps a unique index built in one database out of the other', async () => {
    const one = await open(testDbUri());
    const other = await open(testDbUri());
    await one.model('Thing', ThingSchema).init();
    await other.createCollection('things');

    const names = async (c: mongoose.Connection) =>
      (await c.collection('things').indexes()).map((i) => i.name);
    expect(await names(one)).toContain('key_1');
    expect(await names(other)).toEqual(['_id_']);
    await other.collection('things').insertMany([{ key: 'same' }, { key: 'same' }]);
    expect(await other.collection('things').countDocuments()).toBe(2);
  });

  it('rejects a duplicate insert with E11000 once the model has built its unique index', async () => {
    const Thing = (await open(testDbUri())).model('Thing', ThingSchema);
    await Thing.init();
    await Thing.create({ key: 'k-1' });

    await expect(Thing.create({ key: 'k-1' })).rejects.toMatchObject({ code: 11000 });
  });

  it('closeTestDb drops every database the suite was given and closes the connections', async () => {
    const uri = await connectTestDb();
    await mongoose.connection.collection('things').insertOne({ key: 'kept-until-close' });
    const named = testDbName('dropped');
    await mongoose.connection.getClient().db(named).collection('things').insertOne({ key: 'x' });

    await closeTestDb();

    expect(mongoose.connection.readyState).toBe(mongoose.ConnectionStates.disconnected);
    const admin = await open(process.env.TEST_MONGO_URI as string);
    const { databases } = await admin.getClient().db().admin().listDatabases({ nameOnly: true });
    const left = databases.map((d) => d.name);
    expect(left).not.toContain(dbOf(uri));
    expect(left).not.toContain(named);
  });

  it('refuses to hand out a database without the run-wide server', () => {
    const saved = process.env.TEST_MONGO_URI;
    delete process.env.TEST_MONGO_URI;
    try {
      expect(() => testDbUri()).toThrow(/TEST_MONGO_URI is not set/);
    } finally {
      if (saved !== undefined) process.env.TEST_MONGO_URI = saved;
    }
  });
});
