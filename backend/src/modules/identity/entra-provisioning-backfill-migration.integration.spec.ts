/**
 * Migration 20261126000007 (HX-E4): identities whose Entra ID account bulk provisioning recorded
 * (an `entra-id` target source) without a provisioning entry get a SYNCED Entra ID entry, so
 * provisionedSystems lists Entra ID for them and the mover and offboarding reach the account.
 */
import { MongoClient, ObjectId } from 'mongodb';
import { closeTestDb, testDbName, testDbUri } from '@testing/test-db';
import { up, down } from '../../../migrations/20261126000007-entra-provisioning-backfill';

const EARLIER = new Date('2026-10-01T10:00:00Z');

describe('Migration: a SYNCED Entra ID entry for identities with an Entra ID account (MongoDB)', () => {
  let client: MongoClient;

  beforeAll(async () => {
    client = await MongoClient.connect(testDbUri());
  });

  afterAll(async () => {
    await client?.close();
    await closeTestDb();
  });

  const entraSource = (externalId: string | null = 'obj-1', sourceName = 'entra-id') => ({
    sourceName,
    externalId,
    sourceRole: 'target',
  });
  const hrSource = { sourceName: 'csv-hr', externalId: 'E-1', sourceRole: 'authoritative' };

  async function seed(label: string) {
    const db = client.db(testDbName(label));
    await db.collection('identities').insertMany([
      // Bulk provisioned: the account id is recorded, no entry
      { _id: new ObjectId(), key: 'bulk', tenantId: 'a', sources: [hrSource, entraSource()] },
      { _id: new ObjectId(), key: 'bulk-other-tenant', tenantId: 'b', sources: [entraSource()] },
      {
        _id: new ObjectId(),
        key: 'bulk-with-ad',
        tenantId: 'a',
        sources: [entraSource('obj-2', 'Entra')],
        provisioning: [{ targetSystem: 'ad', status: 'SYNCED', provisionedAt: EARLIER }],
      },
      // Has an Entra ID entry already (onboarding names it `entra`), even a deprovisioned one
      {
        _id: new ObjectId(),
        key: 'onboarded',
        tenantId: 'a',
        sources: [entraSource('obj-3')],
        provisioning: [{ targetSystem: 'entra', status: 'SYNCED', provisionedAt: EARLIER }],
      },
      {
        _id: new ObjectId(),
        key: 'deprovisioned',
        tenantId: 'a',
        sources: [entraSource('obj-4')],
        provisioning: [{ targetSystem: 'entra-id', status: 'DEPROVISIONED', provisionedAt: null }],
      },
      // Not to be touched: deleted, no account id, Entra ID only as an HR-like source, no source
      {
        _id: new ObjectId(),
        key: 'deleted',
        tenantId: 'a',
        sources: [entraSource('obj-5')],
        deletedAt: EARLIER,
      },
      { _id: new ObjectId(), key: 'no-id', tenantId: 'a', sources: [entraSource(null)] },
      {
        _id: new ObjectId(),
        key: 'inbound',
        tenantId: 'a',
        sources: [{ sourceName: 'entra-id', externalId: 'obj-6', sourceRole: 'authoritative' }],
      },
      { _id: new ObjectId(), key: 'hr-only', tenantId: 'a', sources: [hrSource] },
    ]);
    return db;
  }

  const entriesOf = async (db: ReturnType<MongoClient['db']>) =>
    Object.fromEntries(
      (await db.collection('identities').find({}).toArray()).map((i) => [
        i.key,
        ((i.provisioning ?? []) as Array<{ targetSystem: string; status: string }>).map(
          (p) => `${p.targetSystem}:${p.status}`,
        ),
      ]),
    );

  it('adds entra-id SYNCED where an Entra ID account is recorded without an entry, once', async () => {
    const db = await seed('entra-provisioning-backfill-up');

    await up(db);
    await up(db);

    expect(await entriesOf(db)).toEqual({
      bulk: ['entra-id:SYNCED'],
      'bulk-other-tenant': ['entra-id:SYNCED'],
      'bulk-with-ad': ['ad:SYNCED', 'entra-id:SYNCED'],
      onboarded: ['entra:SYNCED'],
      deprovisioned: ['entra-id:DEPROVISIONED'],
      deleted: [],
      'no-id': [],
      inbound: [],
      'hr-only': [],
    });
    const bulk = await db.collection('identities').findOne({ key: 'bulk' });
    expect(bulk?.provisioning[0].provisionedAt).toBeInstanceOf(Date);
    expect(bulk?.provisioning[0].lastSync).toBeInstanceOf(Date);
  });

  it('down leaves the entries: removing them would hide the accounts again', async () => {
    const db = await seed('entra-provisioning-backfill-down');
    await up(db);

    await down();

    expect((await entriesOf(db)).bulk).toEqual(['entra-id:SYNCED']);
  });
});
