/**
 * Migration 20261126000006: agents whose owner left before the deploy are marked ownerless (HX-G
 * follow-up). From the deploy on, an owner's offboarding or erasure marks the owner's agents
 * (NhiOwnershipService); an agent whose owner was offboarded or erased earlier would otherwise
 * keep being issued credentials.
 */
import { MongoClient, ObjectId } from 'mongodb';
import { closeTestDb, testDbName, testDbUri } from '@testing/test-db';
import { up, down } from '../../../migrations/20261126000006-nhi-ownerless-backfill';

const LIVE = '64b7f0c2a1b2c3d4e5f60e01';
const OFFBOARDED = '64b7f0c2a1b2c3d4e5f60e02';
const ERASED = '64b7f0c2a1b2c3d4e5f60e03';
const EARLIER = new Date('2026-10-01T10:00:00Z');

describe('Migration: agents whose owner left are ownerless (MongoDB)', () => {
  let client: MongoClient;

  beforeAll(async () => {
    client = await MongoClient.connect(testDbUri());
  });

  afterAll(async () => {
    await client?.close();
    await closeTestDb();
  });

  const agent = (agentId: string, owner: string, extra: Record<string, unknown> = {}) => ({
    tenantId: 'a',
    agentId,
    owner: { identityId: owner, email: `${agentId}@corp.example` },
    status: 'active',
    ...extra,
  });

  async function seed(label: string) {
    const db = client.db(testDbName(label));
    await db.collection('identities').insertMany([
      { _id: new ObjectId(LIVE), tenantId: 'a', profile: { status: 'ACTIVE' } },
      { _id: new ObjectId(OFFBOARDED), tenantId: 'a', deletedAt: EARLIER },
    ]);
    await db.collection('agent_identities').insertMany([
      agent('live-bot', LIVE),
      agent('left-bot', OFFBOARDED, { status: 'expired' }),
      agent('erased-bot', ERASED, { owner: { identityId: ERASED, email: '(erased)' } }),
      // Revoked: nothing to ask about; already marked: keeps its date and reason
      agent('revoked-bot', OFFBOARDED, { status: 'revoked' }),
      agent('marked-bot', OFFBOARDED, { ownerlessSince: EARLIER, ownerlessReason: 'offboarded' }),
      // The same owner id in another tenant, where no such identity lives
      { ...agent('other-tenant-bot', LIVE), tenantId: 'b' },
    ]);
    return db;
  }

  const state = async (db: ReturnType<MongoClient['db']>) =>
    Object.fromEntries(
      (await db.collection('agent_identities').find({}).toArray()).map((a) => [
        a.agentId,
        a.ownerlessReason ?? null,
      ]),
    );

  it('marks the agents of owners offboarded or erased before, and leaves the others', async () => {
    const db = await seed('nhi-ownerless-up');

    await up(db);
    await up(db);

    expect(await state(db)).toEqual({
      'live-bot': null,
      'left-bot': 'offboarded',
      'erased-bot': 'erased',
      'revoked-bot': null,
      'marked-bot': 'offboarded',
      'other-tenant-bot': 'offboarded',
    });
    const marked = await db.collection('agent_identities').findOne({ agentId: 'marked-bot' });
    expect(marked?.ownerlessSince).toEqual(EARLIER);
    const left = await db.collection('agent_identities').findOne({ agentId: 'left-bot' });
    expect(left?.ownerlessSince).toBeInstanceOf(Date);
  });

  it('down leaves the marks: removing them would let ownerless agents get credentials again', async () => {
    const db = await seed('nhi-ownerless-down');
    await up(db);

    await down();

    expect((await state(db))['left-bot']).toBe('offboarded');
  });
});
