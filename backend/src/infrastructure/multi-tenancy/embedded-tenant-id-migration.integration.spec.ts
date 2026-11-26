/**
 * Migration 20261125000001: the global tenant plugin gave every embedded schema an indexed
 * tenantId, so Mongoose built indexes such as sources.tenantId_1 that no query uses, and
 * subdocuments stored before 2ae3a960 (and identity sources, controls and provisioning entries
 * since, through ensureTenantId) carry a stamped tenantId the API returns. The plugin now leaves
 * embedded schemas alone; the migration drops those indexes and removes the stamped values.
 * In-memory MongoDB.
 */
import { Mongoose } from 'mongoose';
import { MongoClient, type Db } from 'mongodb';
import { closeTestDb, testDbName, testDbUri } from '@testing/test-db';
import { tenantPlugin } from './tenant.plugin';
import { Identity, IdentitySchema } from '../../modules/identity/schemas/identity.schema';
import { up, down } from '../../../migrations/20261125000001-drop-embedded-tenant-id';

const T = 'tenant-a';

const indexNames = async (db: Db, collection: string) =>
  (await db.collection(collection).indexes()).map((i) => i.name).sort();

/** Runs `up` and returns what it logged. */
async function runUp(db: Db): Promise<string> {
  const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    await up(db);
    return log.mock.calls.map((c) => c.join(' ')).join('\n');
  } finally {
    log.mockRestore();
  }
}

describe('migration: drop embedded tenantId', () => {
  let client: MongoClient;

  beforeAll(async () => {
    client = await MongoClient.connect(testDbUri());
  });

  afterAll(async () => {
    await client?.close();
    await closeTestDb();
  });

  describe('over stamped documents', () => {
    let db: Db;
    let firstRun: string;
    let secondRun: string;

    beforeAll(async () => {
      db = client.db(testDbName('stamped'));
      await db.collection('identities').insertMany([
        {
          tenantId: T,
          // Declared by IdentityProfile itself (not the plugin's): kept
          profile: { email: 'a@example.com', tenantId: T },
          sources: [
            { sourceName: 'csv-hr', externalId: '1', tenantId: T },
            { sourceName: 'json-api-hr', externalId: '2' },
          ],
          controls: { tenantId: T, frozenFields: [] },
          provisioning: [{ system: 'entra-id', status: 'SYNCED', tenantId: T }],
        },
        // Nothing embedded at all, and an empty array: left as they are
        { tenantId: T, profile: { email: 'b@example.com' }, sources: [] },
      ]);
      await db.collection('policies').insertOne({
        tenantId: T,
        name: 'Joiner baseline',
        conditionGroups: [
          {
            id: 'g1',
            tenantId: T,
            conditions: [{ id: 'c1', field: 'department', tenantId: T }, { id: 'c2' }],
          },
          // A group without conditions, and one whose conditions are null
          { id: 'g2', tenantId: T },
          { id: 'g3', conditions: null },
        ],
        actions: [{ id: 'a1', type: 'assign_group', tenantId: T }],
      });
      await db.collection('credential_policies').insertOne({
        tenantId: T,
        name: 'Service accounts',
        passwordPolicy: { maxAgeDays: 90, tenantId: T },
        rotationPolicy: null,
      });
      await db.collection('review_items').insertOne({
        tenantId: T,
        entitlements: [
          { system: 'entra-id', tenantId: T, revocation: { outcome: 'removed', tenantId: T } },
          { system: 'ad', revocation: null },
        ],
      });

      const identities = db.collection('identities');
      await identities.createIndex({ tenantId: 1 });
      await identities.createIndex({ 'sources.tenantId': 1 });
      await identities.createIndex({ 'provisioning.tenantId': 1 });
      // Compound: never dropped, though it names a nested tenantId
      await identities.createIndex({ tenantId: 1, 'profile.status': 1 });
      await identities.createIndex({ 'sources.tenantId': 1, 'sources.externalId': 1 });
      await db.collection('policies').createIndex({ 'conditionGroups.conditions.tenantId': 1 });
      await db.collection('credential_policies').createIndex({ 'passwordPolicy.tenantId': 1 });
      // A collection no model embeds in: the index rule holds for every collection
      await db.collection('archival_records').createIndex({ 'meta.tenantId': 1 });

      firstRun = await runUp(db);
      secondRun = await runUp(db);
    });

    it('drops the single-key nested tenantId indexes only', async () => {
      expect(await indexNames(db, 'identities')).toEqual([
        '_id_',
        'sources.tenantId_1_sources.externalId_1',
        'tenantId_1',
        'tenantId_1_profile.status_1',
      ]);
      expect(await indexNames(db, 'policies')).toEqual(['_id_']);
      expect(await indexNames(db, 'credential_policies')).toEqual(['_id_']);
      expect(await indexNames(db, 'archival_records')).toEqual(['_id_']);
    });

    it('removes the stamped tenantId of every embedded document, at any depth', async () => {
      const [a, b] = await db
        .collection('identities')
        .find({}, { projection: { _id: 0 } })
        .sort({ 'profile.email': 1 })
        .toArray();
      expect(a).toEqual({
        tenantId: T,
        profile: { email: 'a@example.com', tenantId: T },
        sources: [
          { sourceName: 'csv-hr', externalId: '1' },
          { sourceName: 'json-api-hr', externalId: '2' },
        ],
        controls: { frozenFields: [] },
        provisioning: [{ system: 'entra-id', status: 'SYNCED' }],
      });
      expect(b).toEqual({ tenantId: T, profile: { email: 'b@example.com' }, sources: [] });

      const policy = await db.collection('policies').findOne({}, { projection: { _id: 0 } });
      expect(policy).toEqual({
        tenantId: T,
        name: 'Joiner baseline',
        conditionGroups: [
          { id: 'g1', conditions: [{ id: 'c1', field: 'department' }, { id: 'c2' }] },
          { id: 'g2' },
          { id: 'g3', conditions: null },
        ],
        actions: [{ id: 'a1', type: 'assign_group' }],
      });
      expect(
        await db.collection('credential_policies').findOne({}, { projection: { _id: 0 } }),
      ).toEqual({
        tenantId: T,
        name: 'Service accounts',
        passwordPolicy: { maxAgeDays: 90 },
        rotationPolicy: null,
      });
      expect(await db.collection('review_items').findOne({}, { projection: { _id: 0 } })).toEqual({
        tenantId: T,
        entitlements: [
          { system: 'entra-id', revocation: { outcome: 'removed' } },
          { system: 'ad', revocation: null },
        ],
      });
    });

    it('logs what it changed, and a second run changes nothing', () => {
      expect(firstRun).toContain('5 nested tenantId indexes dropped');
      expect(firstRun).toContain('identities.sources[]: 1 documents');
      expect(firstRun).toContain('policies.conditionGroups[].conditions[]: 1 documents');
      expect(secondRun).toContain('0 nested tenantId indexes dropped');
      expect(secondRun).toContain('0 documents changed');
    });

    // Mongoose builds what the models declare at start: the dropped indexes do not come back.
    it('leaves indexes Mongoose does not build again', async () => {
      const runtime = new Mongoose();
      runtime.plugin(tenantPlugin);
      const connection = await runtime
        .createConnection(testDbUri('stamped'), { autoIndex: false })
        .asPromise();
      try {
        await connection.model(Identity.name, IdentitySchema).createIndexes();
      } finally {
        await connection.close();
      }

      const nested = (await db.collection('identities').indexes())
        .map((i) => Object.keys(i.key))
        .filter((keys) => keys.length === 1 && keys[0].endsWith('.tenantId'));
      expect(nested).toEqual([]);
    });
  });

  it('runs on a database without these collections and creates none', async () => {
    const db = client.db(testDbName('empty'));

    await runUp(db);

    expect(await db.listCollections().toArray()).toEqual([]);
  });

  it('has nothing to undo', async () => {
    await expect(down()).resolves.toBeUndefined();
  });
});
