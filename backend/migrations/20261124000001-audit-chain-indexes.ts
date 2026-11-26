/**
 * Migration: the unique indexes the per-tenant audit hash chain relies on, in place before the new
 * API and worker write their first chained audit event.
 *
 * AuditChainWriter keeps two writers apart with the unique `{ tenantId, seq }` index on
 * audit_events (of two writers that take one chain position, one stores its event), and creates one
 * chain head per tenant through the unique `{ tenantId }` index on audit_chain_heads. The unique
 * `{ tenantId, firstSeq }` index on audit_roots keeps two checkpoints over the same events apart.
 * Mongoose builds them at start too, but a partial index build scans the whole audit_events
 * collection, and writes made meanwhile have no uniqueness check: two writers could take one
 * position, and the build would then fail. Built here first, the start finds them in place.
 *
 * No document changes: existing events and checkpoints have no seq or firstSeq and stay outside
 * the partial indexes. The options match the schemas exactly, so Mongoose accepts the indexes as
 * its own. Rerunning it is safe.
 */
import { Db, type CreateIndexesOptions, type IndexSpecification } from 'mongodb';

interface ChainIndex {
  collection: string;
  key: IndexSpecification;
  name: string;
  options: CreateIndexesOptions;
}

/** Must match audit-event.schema.ts, audit-chain-head.schema.ts and audit-merkle-root.schema.ts. */
const INDEXES: ChainIndex[] = [
  {
    collection: 'audit_events',
    key: { tenantId: 1, seq: 1 },
    name: 'tenantId_1_seq_1',
    options: { unique: true, partialFilterExpression: { seq: { $type: 'number' } } },
  },
  {
    collection: 'audit_chain_heads',
    key: { tenantId: 1 },
    name: 'tenantId_1',
    options: { unique: true },
  },
  {
    collection: 'audit_roots',
    key: { tenantId: 1, firstSeq: 1 },
    name: 'tenantId_1_firstSeq_1',
    options: { unique: true, partialFilterExpression: { firstSeq: { $type: 'number' } } },
  },
];

export async function up(db: Db): Promise<void> {
  for (const index of INDEXES) {
    // createIndex creates the collection when it is missing and is a no-op for an identical index
    await db.collection(index.collection).createIndex(index.key, { ...index.options, name: index.name });
  }
}

/** Drops the indexes (the code before the chain head does not use them). */
export async function down(db: Db): Promise<void> {
  for (const index of INDEXES) {
    const exists = await db.listCollections({ name: index.collection }, { nameOnly: true }).hasNext();
    if (!exists) continue;
    const names = (await db.collection(index.collection).indexes()).map((i) => i.name);
    if (names.includes(index.name)) await db.collection(index.collection).dropIndex(index.name);
  }
}
