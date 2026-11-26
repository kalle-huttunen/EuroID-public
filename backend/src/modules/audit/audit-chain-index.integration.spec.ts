import { closeTestDb, testDbName, testDbUri } from '@testing/test-db';
import { MongoClient } from 'mongodb';
import mongoose from 'mongoose';
import { AuditEvent, AuditEventSchema } from './schemas/audit-event.schema';
import { AuditChainHead, AuditChainHeadSchema } from './schemas/audit-chain-head.schema';
import { AuditMerkleRoot, AuditMerkleRootSchema } from './schemas/audit-merkle-root.schema';
import { up, down } from '../../../migrations/20261124000001-audit-chain-indexes';

const legacyEvent = (n: number) => ({
  tenantId: 'tenant-a',
  action: 'CONFIG_CHANGED',
  severity: 'info',
  timestamp: new Date(),
  actor: 'admin',
  resourceType: 'config',
  resourceId: `cfg-${n}`,
  resourceName: `Config ${n}`,
  description: `Change ${n}`,
  integrityHash: `h${n}`,
  previousHash: `h${n - 1}`,
});

/**
 * The unique indexes that keep two audit writers on one chain: built by the migration before the
 * new code starts (a partial index build scans all of audit_events, and writes made meanwhile
 * would have no uniqueness check), with the options the schemas declare so Mongoose takes them as
 * its own. Runs on the mongodb-memory-server binary.
 */
describe('audit chain indexes', () => {
  let client: MongoClient;

  beforeAll(async () => {
    client = await MongoClient.connect(testDbUri());
  });

  afterAll(async () => {
    await client?.close();
    await closeTestDb();
  });

  it('builds the unique chain indexes over the events already in the log, and is safe to rerun', async () => {
    const db = client.db(testDbName('migration-legacy'));
    // Events written before chain positions: several per tenant, none with seq
    await db.collection('audit_events').insertMany([legacyEvent(1), legacyEvent(2)]);

    await up(db);
    await up(db);

    const events = db.collection('audit_events');
    await events.insertOne({ ...legacyEvent(3), seq: 1 });
    await expect(events.insertOne({ ...legacyEvent(4), seq: 1 })).rejects.toMatchObject({
      code: 11000,
    });
    await expect(
      events.insertOne({ ...legacyEvent(5), tenantId: 'tenant-b', seq: 1 }),
    ).resolves.toBeDefined();
    await db
      .collection('audit_chain_heads')
      .insertOne({ tenantId: 'tenant-a', seq: 1, lastHash: 'h3' });
    await expect(
      db.collection('audit_chain_heads').insertOne({ tenantId: 'tenant-a', seq: 0, lastHash: 'x' }),
    ).rejects.toMatchObject({ code: 11000 });
    await db.collection('audit_roots').insertOne({ tenantId: 'tenant-a', firstSeq: 1 });
    await expect(
      db.collection('audit_roots').insertOne({ tenantId: 'tenant-a', firstSeq: 1 }),
    ).rejects.toMatchObject({ code: 11000 });
  });

  it('matches the schemas: Mongoose builds the same indexes over the migrated ones without error', async () => {
    await up(client.db(testDbName('migration-then-schema')));
    const connection = await mongoose
      .createConnection(testDbUri('migration-then-schema'), { autoIndex: false })
      .asPromise();
    try {
      const models = [
        connection.model(AuditEvent.name, AuditEventSchema),
        connection.model(AuditChainHead.name, AuditChainHeadSchema),
        connection.model(AuditMerkleRoot.name, AuditMerkleRootSchema),
      ];
      await Promise.all(models.map((m) => m.createIndexes()));
      // No index left out by the migration, none it built that the schemas do not declare
      for (const model of models) {
        const diff = await model.diffIndexes();
        expect(diff.toDrop).toEqual([]);
      }
    } finally {
      await connection.close();
    }
  });

  it('does nothing harmful on an empty deployment, and down removes the indexes', async () => {
    const db = client.db(testDbName('migration-empty'));
    await expect(up(db)).resolves.toBeUndefined();

    await down(db);
    await down(db);

    const names = (await db.collection('audit_events').indexes()).map((i) => i.name);
    expect(names).not.toContain('tenantId_1_seq_1');
  });
});
