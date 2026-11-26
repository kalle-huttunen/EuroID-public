/**
 * Baseline migration — documents existing schema state.
 *
 * All collections and indexes below already exist in production.
 * This migration serves as the anchor point for future versioned migrations.
 */
import { Db } from 'mongodb';

export async function up(db: Db): Promise<void> {
  // Ensure dead_letter indexes exist (idempotent — createIndex is a no-op if exists)
  const dl = db.collection('dead_letter');
  await dl.createIndex({ status: 1, createdAt: -1 });
  await dl.createIndex({ type: 1 });
  await dl.createIndex({ correlationId: 1 });
  await dl.createIndex({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

  // Ensure event_outbox indexes exist
  const outbox = db.collection('event_outbox');
  await outbox.createIndex({ status: 1, createdAt: 1 });
  await outbox.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 });
}

export async function down(): Promise<void> {
  // Baseline cannot be rolled back
}
