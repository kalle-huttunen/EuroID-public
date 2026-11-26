/**
 * Migration: Add auto-retry fields to dead_letter collection.
 * New fields: maxRetries, nextRetryAt, lastRetryError.
 * New index: { status, nextRetryAt } for retry poller.
 */
import { Db } from 'mongodb';

export async function up(db: Db): Promise<void> {
  const collection = db.collection('dead_letter');

  // Add new fields to existing documents
  await collection.updateMany(
    { maxRetries: { $exists: false } },
    {
      $set: {
        maxRetries: 3,
        nextRetryAt: null,
        lastRetryError: null,
      },
    },
  );

  // Add retry polling index
  await collection.createIndex({ status: 1, nextRetryAt: 1 });
}

export async function down(db: Db): Promise<void> {
  const collection = db.collection('dead_letter');
  await collection.updateMany(
    {},
    {
      $unset: {
        maxRetries: '',
        nextRetryAt: '',
        lastRetryError: '',
      },
    },
  );
  await collection.dropIndex('status_1_nextRetryAt_1').catch(() => {});
}
