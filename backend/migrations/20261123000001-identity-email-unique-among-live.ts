/**
 * Migration: identities.profile.email is unique per tenant among live identities only.
 *
 * The `{ tenantId, profile.email }` unique index counted soft-deleted identities too, so a new
 * hire could never take the address of a former employee: correlation minted the HR row and the
 * insert failed on the index at every sync. The index is now partial over identities without a
 * `deletedAt` (`{ deletedAt: null }` matches a missing one too).
 *
 * Mongoose builds indexes but never replaces one with other options, so this migration drops the
 * old index and creates the partial one under the same name. No email is left duplicated among
 * live identities: the old index kept every email unique. Rerunning it is safe.
 */
import { Db } from 'mongodb';

const COLLECTION = 'identities';
const INDEX_NAME = 'tenantId_1_profile.email_1';
const KEY = { tenantId: 1, 'profile.email': 1 };
/** Must match the partialFilterExpression in identity.schema.ts. */
const PARTIAL_FILTER = { deletedAt: null };

async function currentIndex(db: Db): Promise<Record<string, unknown> | undefined> {
  const exists = await db.listCollections({ name: COLLECTION }, { nameOnly: true }).hasNext();
  if (!exists) return undefined;
  return (await db.collection(COLLECTION).indexes()).find((i) => i.name === INDEX_NAME);
}

export async function up(db: Db): Promise<void> {
  const index = await currentIndex(db);
  if (index?.partialFilterExpression) return;
  const identities = db.collection(COLLECTION);
  if (index) await identities.dropIndex(INDEX_NAME);
  await identities.createIndex(KEY, {
    name: INDEX_NAME,
    unique: true,
    partialFilterExpression: PARTIAL_FILTER,
  });
}

/**
 * Back to the index over every identity. Fails without changing anything while an email is
 * shared (a live identity took the address of a deleted one), naming the tenants.
 */
export async function down(db: Db): Promise<void> {
  const index = await currentIndex(db);
  if (index && !index.partialFilterExpression) return;
  const identities = db.collection(COLLECTION);
  const shared = await identities
    .aggregate<{
      _id: { tenantId: string };
      count: number;
    }>([{ $group: { _id: { tenantId: '$tenantId', email: '$profile.email' }, count: { $sum: 1 } } }, { $match: { count: { $gt: 1 } } }, { $group: { _id: { tenantId: '$_id.tenantId' }, count: { $sum: 1 } } }])
    .toArray();
  if (shared.length > 0) {
    const tenants = shared.map((s) => `${s._id.tenantId} (${s.count} shared)`).join(', ');
    throw new Error(
      `Cannot restore the unique index ${INDEX_NAME}: emails are shared by more than one ` +
        `identity (deleted ones included) in ${tenants}. No index was changed.`,
    );
  }
  if (index) await identities.dropIndex(INDEX_NAME);
  await identities.createIndex(KEY, { name: INDEX_NAME, unique: true });
}
