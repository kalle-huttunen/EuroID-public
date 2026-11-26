/**
 * Migration: consents holds one record per tenant, identity and purpose.
 *
 * grantConsent upserts the record of an identity and purpose, on a non-unique
 * `{ tenantId, identityId, purpose }` index, so two grants at once (a double click, a retried
 * request) could insert two records. revokeConsent then updated one of them and the other stayed
 * `granted`, so the consent report overstated consent (hunt 06 F5). The index is now unique.
 *
 * Mongoose never replaces an index with other options, and a unique index cannot be built over
 * duplicates, so this migration first removes the duplicate records of each identity and purpose,
 * keeping the one changed last (its `updatedAt`, then the newest `_id`): every grant and revoke
 * after the duplicate was made went to one record, so the one changed last holds the consent's
 * current state. Then it replaces the index under the same name. Rerunning it is safe.
 */
import { Db, ObjectId } from 'mongodb';

const COLLECTION = 'consents';
/** Must match ConsentSchema.index({ tenantId: 1, identityId: 1, purpose: 1 }, { unique: true }). */
const INDEX_NAME = 'tenantId_1_identityId_1_purpose_1';
const KEY = { tenantId: 1, identityId: 1, purpose: 1 };

async function currentIndex(db: Db): Promise<Record<string, unknown> | undefined | null> {
  const exists = await db.listCollections({ name: COLLECTION }, { nameOnly: true }).hasNext();
  if (!exists) return null;
  return (await db.collection(COLLECTION).indexes()).find((i) => i.name === INDEX_NAME);
}

/** Deletes every record but the one changed last of each duplicated identity and purpose. */
async function removeDuplicates(db: Db): Promise<number> {
  const consents = db.collection(COLLECTION);
  const groups = consents.aggregate<{ ids: ObjectId[] }>(
    [
      { $sort: { updatedAt: -1, _id: -1 } },
      {
        $group: {
          _id: { tenantId: '$tenantId', identityId: '$identityId', purpose: '$purpose' },
          ids: { $push: '$_id' },
          count: { $sum: 1 },
        },
      },
      { $match: { count: { $gt: 1 } } },
    ],
    { allowDiskUse: true },
  );
  let removed = 0;
  for await (const group of groups) {
    const result = await consents.deleteMany({ _id: { $in: group.ids.slice(1) } });
    removed += result.deletedCount;
  }
  return removed;
}

export async function up(db: Db): Promise<void> {
  const index = await currentIndex(db);
  if (index === null || index?.unique) return;
  const removed = await removeDuplicates(db);
  if (removed > 0) {
    console.log(`[migration] removed ${removed} duplicate consent records`);
  }
  const consents = db.collection(COLLECTION);
  if (index) await consents.dropIndex(INDEX_NAME);
  await consents.createIndex(KEY, { name: INDEX_NAME, unique: true });
}

/** Back to the non-unique index. The removed duplicate records are not restored. */
export async function down(db: Db): Promise<void> {
  const index = await currentIndex(db);
  if (index === null || (index && !index.unique)) return;
  const consents = db.collection(COLLECTION);
  if (index) await consents.dropIndex(INDEX_NAME);
  await consents.createIndex(KEY, { name: INDEX_NAME });
}
