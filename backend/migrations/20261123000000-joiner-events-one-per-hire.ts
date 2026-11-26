/**
 * Migration: joiner_events holds one joiner per identity and hire.
 *
 * A rehire an HR sync revives is a joiner again (plan 2.8), so the unique index moves from
 * `{ tenantId, identityId }` to `{ tenantId, identityId, rehiredAt }`: an identity keeps the
 * joiner of its first hire (`rehiredAt` unset) and gets one per rehire. Existing joiner events
 * have no `rehiredAt` and stay unique under the new index. Mongoose builds indexes but never drops
 * them, and the old index would refuse a rehire's joiner, so this migration creates the new index
 * first and then drops the old one if present. Rerunning it is safe.
 */
import { Db } from 'mongodb';

const COLLECTION = 'joiner_events';
const OLD_INDEX_NAME = 'tenantId_1_identityId_1';
/** Must match JoinerEventSchema.index({ tenantId: 1, identityId: 1, rehiredAt: 1 }, ...). */
const NEW_INDEX_NAME = 'tenantId_1_identityId_1_rehiredAt_1';

async function indexNames(db: Db): Promise<string[]> {
  const exists = await db.listCollections({ name: COLLECTION }, { nameOnly: true }).hasNext();
  if (!exists) return [];
  return (await db.collection(COLLECTION).indexes()).map((i) => i.name ?? '');
}

export async function up(db: Db): Promise<void> {
  const events = db.collection(COLLECTION);
  const names = await indexNames(db);

  // Create the new index first, so joiner events are never left without a uniqueness check.
  if (!names.includes(NEW_INDEX_NAME)) {
    await events.createIndex(
      { tenantId: 1, identityId: 1, rehiredAt: 1 },
      { name: NEW_INDEX_NAME, unique: true },
    );
  }
  if (names.includes(OLD_INDEX_NAME)) {
    await events.dropIndex(OLD_INDEX_NAME);
  }
}

/** Fails (duplicate key) once an identity has a rehire's joiner, which the old index cannot hold. */
export async function down(db: Db): Promise<void> {
  await db
    .collection(COLLECTION)
    .createIndex({ tenantId: 1, identityId: 1 }, { name: OLD_INDEX_NAME, unique: true });
}
