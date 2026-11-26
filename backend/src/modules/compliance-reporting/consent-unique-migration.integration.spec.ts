/**
 * Migration 20261126000001: consents keeps one record per tenant, identity and purpose (hunt 06
 * F5). Two grants at once upserted two records on the old non-unique index; a revoke then changed
 * one, so the other stayed granted. The migration keeps the record changed last of each group and
 * makes the index unique.
 */
import { MongoClient, ObjectId } from 'mongodb';
import { closeTestDb, testDbName, testDbUri } from '@testing/test-db';
import { up, down } from '../../../migrations/20261126000001-consent-unique-per-purpose';

const INDEX = 'tenantId_1_identityId_1_purpose_1';
const ADA = '64b7f0c2a1b2c3d4e5f60a01';
const BEA = '64b7f0c2a1b2c3d4e5f60a02';

describe('Migration: one consent per identity and purpose (MongoDB)', () => {
  let client: MongoClient;

  beforeAll(async () => {
    client = await MongoClient.connect(testDbUri());
  });

  afterAll(async () => {
    await client?.close();
    await closeTestDb();
  });

  const row = (
    n: number,
    tenantId: string,
    identityId: string,
    purpose: string,
    status: string,
    updatedAt: string,
  ) => ({
    _id: new ObjectId(n.toString(16).padStart(24, '0')),
    tenantId,
    identityId,
    purpose,
    status,
    grantedBy: 'operator@example.test',
    updatedAt: new Date(updatedAt),
  });

  /** The previous schema's non-unique index, with the duplicates it let in. */
  async function legacyCollection(label: string) {
    const consents = client.db(testDbName(label)).collection('consents');
    await consents.createIndex({ tenantId: 1, identityId: 1, purpose: 1 }, { name: INDEX });
    await consents.insertMany([
      // Two grants at once, then a revoke that changed the second
      row(1, 'a', ADA, 'marketing', 'granted', '2026-10-01T10:00:00Z'),
      row(2, 'a', ADA, 'marketing', 'revoked', '2026-10-05T10:00:00Z'),
      // Three at once, none changed since: the newest _id stays
      row(3, 'a', ADA, 'analytics', 'granted', '2026-10-01T10:00:00Z'),
      row(4, 'a', ADA, 'analytics', 'granted', '2026-10-01T10:00:00Z'),
      row(5, 'a', ADA, 'analytics', 'granted', '2026-10-01T10:00:00Z'),
      // One record each: kept
      row(6, 'a', BEA, 'marketing', 'granted', '2026-10-01T10:00:00Z'),
      row(7, 'b', ADA, 'marketing', 'granted', '2026-10-01T10:00:00Z'),
    ]);
    return consents;
  }

  it('keeps the record changed last of each identity and purpose, and makes the index unique', async () => {
    const consents = await legacyCollection('legacy');

    await up(client.db(testDbName('legacy')));
    await up(client.db(testDbName('legacy')));

    const kept = await consents.find({}, { sort: { _id: 1 } }).toArray();
    expect(kept.map((c) => [String(c._id).slice(-1), c.purpose, c.status])).toEqual([
      ['2', 'marketing', 'revoked'],
      ['5', 'analytics', 'granted'],
      ['6', 'marketing', 'granted'],
      ['7', 'marketing', 'granted'],
    ]);
    expect((await consents.indexes()).find((i) => i.name === INDEX)).toMatchObject({
      unique: true,
    });
    await expect(
      consents.insertOne(row(8, 'a', ADA, 'marketing', 'granted', '2026-11-01T10:00:00Z')),
    ).rejects.toMatchObject({ code: 11000 });
  });

  it('does nothing harmful on a deployment without the collection', async () => {
    await expect(up(client.db(testDbName('empty')))).resolves.toBeUndefined();
  });

  it('down restores the non-unique index', async () => {
    const consents = await legacyCollection('down');
    await up(client.db(testDbName('down')));

    await down(client.db(testDbName('down')));
    await down(client.db(testDbName('down')));

    const index = (await consents.indexes()).find((i) => i.name === INDEX);
    expect(index).toBeDefined();
    expect(index?.unique).toBeUndefined();
  });
});
