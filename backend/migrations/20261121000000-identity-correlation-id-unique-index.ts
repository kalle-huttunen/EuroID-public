/**
 * Migration: per-tenant unique index on identities.profile.correlationId.
 *
 * The schema used `$ne: null` in partialFilterExpression, which MongoDB rejects
 * ("Expression not supported in partial index: $not"), so the index was never created and
 * two identities in one tenant could share a correlationId. This migration reports such
 * duplicates without changing any data, and only creates the index when there are none.
 */
import { Db } from 'mongodb';

const COLLECTION = 'identities';
const CORRELATION_INDEX_NAME = 'tenantId_1_profile.correlationId_1';
/** Must match the partialFilterExpression in identity.schema.ts. */
const PARTIAL_FILTER = { 'profile.correlationId': { $type: 'string' } };

interface DuplicateKey {
  _id: { tenantId: string; correlationId: string };
  count: number;
}

export async function up(db: Db): Promise<void> {
  const identities = db.collection(COLLECTION);

  const duplicates = await identities
    .aggregate<DuplicateKey>([
      { $match: PARTIAL_FILTER },
      {
        $group: {
          _id: { tenantId: '$tenantId', correlationId: '$profile.correlationId' },
          count: { $sum: 1 },
        },
      },
      { $match: { count: { $gt: 1 } } },
      { $sort: { '_id.tenantId': 1, '_id.correlationId': 1 } },
    ])
    .toArray();

  if (duplicates.length > 0) {
    const keys = duplicates.map(
      (d) =>
        `  tenantId=${d._id.tenantId} correlationId=${d._id.correlationId} (${d.count} identities)`,
    );
    throw new Error(
      `Cannot create unique index ${CORRELATION_INDEX_NAME}: ${duplicates.length} ` +
        `(tenantId, profile.correlationId) pair(s) are shared by more than one identity. ` +
        `No data was changed. Merge or correct these identities, then rerun the migration:\n` +
        keys.join('\n'),
    );
  }

  await identities.createIndex(
    { tenantId: 1, 'profile.correlationId': 1 },
    { name: CORRELATION_INDEX_NAME, unique: true, partialFilterExpression: PARTIAL_FILTER },
  );
}

export async function down(db: Db): Promise<void> {
  await db
    .collection(COLLECTION)
    .dropIndex(CORRELATION_INDEX_NAME)
    .catch(() => {});
}
