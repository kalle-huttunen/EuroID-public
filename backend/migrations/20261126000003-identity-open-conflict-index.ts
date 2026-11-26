/**
 * Migration: the partial index over identities with an open correlation conflict,
 * `{ tenantId, metadata.conflictDetails.matchedBy }` where `metadata.requiresReview` is true.
 *
 * Before a record mints an identity, correlation now also looks for an open email conflict naming
 * the record's address in another case (backend/src/modules/identity/identity-email-case-conflict.ts):
 * the pairs 20261125000003-identity-email-lowercase left unchanged and raised for a merge. The
 * index keeps that lookup to the tenant's open conflicts instead of every identity it has.
 * Mongoose builds it at start too; built here first, the start finds it in place. The key and
 * options are the schema's (identity.schema.ts), so Mongoose takes it as its own.
 *
 * No document changes. Rerunning it is safe.
 */
import { Db } from 'mongodb';

const COLLECTION = 'identities';
/** Must match EMAIL_CONFLICT_INDEX, _KEY and _OPTIONS in identity-email-case-conflict.ts. */
const NAME = 'tenantId_1_open_conflict_matchedBy_1';
const KEY = { tenantId: 1, 'metadata.conflictDetails.matchedBy': 1 } as const;
const OPTIONS = { name: NAME, partialFilterExpression: { 'metadata.requiresReview': true } };

export async function up(db: Db): Promise<void> {
  // createIndex creates the collection when it is missing and is a no-op for an identical index
  await db.collection(COLLECTION).createIndex(KEY, OPTIONS);
}

/** Drops the index (correlation then reads the open email conflicts without it). */
export async function down(db: Db): Promise<void> {
  const exists = await db.listCollections({ name: COLLECTION }, { nameOnly: true }).hasNext();
  if (!exists) return;
  const names = (await db.collection(COLLECTION).indexes()).map((i) => i.name);
  if (names.includes(NAME)) await db.collection(COLLECTION).dropIndex(NAME);
}
