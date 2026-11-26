/**
 * Migration: webhook_delivery_attempts holds one delivery per subscription and event.
 *
 * deliverWebhook checked for an existing attempt and then inserted one, on a non-unique
 * `{ subscriptionId, eventId }` index, so two processes handling one event at once (an outbox
 * reclaim, a dead-letter replay, two replicas) both inserted an attempt and both posted the
 * webhook. The index is now unique and the insert is the claim (event-delivery.service.ts).
 *
 * Mongoose never replaces an index with other options, and a unique index cannot be built over
 * duplicates, so this migration first removes the duplicate attempts of each subscription and
 * event, keeping one: a DELIVERED attempt before a PENDING one before a FAILED one (the receiver
 * already has a delivered event, and a PENDING one is being sent), the oldest among equals. The
 * removed attempts would only have sent the event again. Then it replaces the index under the
 * same name. Attempts expire after 30 days (TTL), so only recent ones can be duplicated.
 * Rerunning it is safe.
 */
import { Db, ObjectId } from 'mongodb';

const COLLECTION = 'webhook_delivery_attempts';
/** Must match DeliveryAttemptSchema.index({ subscriptionId: 1, eventId: 1 }, { unique: true }). */
const INDEX_NAME = 'subscriptionId_1_eventId_1';
const KEY = { subscriptionId: 1, eventId: 1 };
/** Which attempt of a duplicate group stays: the lowest rank, then the oldest _id. */
const STATUS_RANK: Record<string, number> = { DELIVERED: 0, PENDING: 1, FAILED: 2 };

async function currentIndex(db: Db): Promise<Record<string, unknown> | undefined | null> {
  const exists = await db.listCollections({ name: COLLECTION }, { nameOnly: true }).hasNext();
  if (!exists) return null;
  return (await db.collection(COLLECTION).indexes()).find((i) => i.name === INDEX_NAME);
}

/** Deletes every attempt but the one to keep of each duplicated { subscriptionId, eventId }. */
async function removeDuplicates(db: Db): Promise<number> {
  const attempts = db.collection(COLLECTION);
  const groups = attempts.aggregate<{ ids: Array<{ _id: ObjectId; status?: string }> }>(
    [
      {
        $group: {
          _id: { subscriptionId: '$subscriptionId', eventId: '$eventId' },
          ids: { $push: { _id: '$_id', status: '$status' } },
          count: { $sum: 1 },
        },
      },
      { $match: { count: { $gt: 1 } } },
    ],
    { allowDiskUse: true },
  );
  let removed = 0;
  for await (const group of groups) {
    const ordered = [...group.ids].sort((a, b) => {
      const rank = (STATUS_RANK[a.status ?? ''] ?? 3) - (STATUS_RANK[b.status ?? ''] ?? 3);
      return rank !== 0 ? rank : String(a._id).localeCompare(String(b._id));
    });
    const drop = ordered.slice(1).map((entry) => entry._id);
    const result = await attempts.deleteMany({ _id: { $in: drop } });
    removed += result.deletedCount;
  }
  return removed;
}

export async function up(db: Db): Promise<void> {
  const index = await currentIndex(db);
  if (index === null || index?.unique) return;
  const removed = await removeDuplicates(db);
  if (removed > 0) {
    console.log(`[migration] removed ${removed} duplicate webhook delivery attempts`);
  }
  const attempts = db.collection(COLLECTION);
  if (index) await attempts.dropIndex(INDEX_NAME);
  await attempts.createIndex(KEY, { name: INDEX_NAME, unique: true });
}

/** Back to the non-unique index. The removed duplicate attempts are not restored. */
export async function down(db: Db): Promise<void> {
  const index = await currentIndex(db);
  if (index === null || (index && !index.unique)) return;
  const attempts = db.collection(COLLECTION);
  if (index) await attempts.dropIndex(INDEX_NAME);
  await attempts.createIndex(KEY, { name: INDEX_NAME });
}
