/**
 * Migration: Create event_subscriptions and webhook_delivery_attempts collections.
 */
import { Db } from 'mongodb';

export async function up(db: Db): Promise<void> {
  // event_subscriptions
  const subs = db.collection('event_subscriptions');
  await subs.createIndex({ tenantId: 1, status: 1 });
  await subs.createIndex({ tenantId: 1, name: 1 }, { unique: true });

  // webhook_delivery_attempts
  const attempts = db.collection('webhook_delivery_attempts');
  await attempts.createIndex({ subscriptionId: 1, createdAt: -1 });
  await attempts.createIndex({ status: 1, nextRetryAt: 1 });
  await attempts.createIndex(
    { createdAt: 1 },
    { expireAfterSeconds: 30 * 24 * 60 * 60 },
  );
}

export async function down(db: Db): Promise<void> {
  await db.dropCollection('webhook_delivery_attempts').catch(() => {});
  await db.dropCollection('event_subscriptions').catch(() => {});
}
