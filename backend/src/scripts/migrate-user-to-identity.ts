/**
 * One-time migration: Copy User documents to Identity (Onion model).
 * Run when switching to IDENTITY_AS_SOURCE_OF_TRUTH=true.
 *
 * Usage: npx ts-node -r tsconfig-paths/register src/scripts/migrate-user-to-identity.ts
 *
 * Skips users that already have a matching Identity (by sourceSystem+sourceUserId+tenantId).
 */

import { Logger } from '@nestjs/common';
import { MongoClient } from 'mongodb';

const logger = new Logger('MigrateUserToIdentity');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/euroid';

async function migrate() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db();
  const users = db.collection('users');
  const identities = db.collection('identities');

  const cursor = users.find({ deletedAt: null });
  let migrated = 0;
  let skipped = 0;

  while (await cursor.hasNext()) {
    const user = await cursor.next();
    if (!user) continue;

    const sourceSystem = user.sourceSystem || 'HR-FEED';
    const sourceUserId = user.sourceUserId || user.email;
    const tenantId = user.tenantId || 'default';

    const existing = await identities.findOne({
      'sources.sourceName': sourceSystem,
      'sources.externalId': sourceUserId,
      tenantId,
    });
    if (existing) {
      skipped++;
      continue;
    }

    const profileWithMeta = {
      firstName: user.firstName || '',
      lastName: user.lastName || '',
      email: user.email || '',
      jobTitle: user.jobTitle,
      departmentCode: user.departmentCode,
      departmentName: user.departmentName,
      status: user.status || 'ACTIVE',
      sourceSystem,
      sourceUserId,
      tenantId,
      ...user,
    };
    const { _id: _omitId, sourceSystem: _omitSource, sourceUserId: _omitUser, tenantId: _omitTenant, ...profile } = profileWithMeta;

    await identities.insertOne({
      profile,
      sources: [
        {
          sourceName: sourceSystem,
          externalId: sourceUserId,
          lastSync: new Date(),
          rawData: user,
          contractType: 'primary',
          sourceRole: 'primary-hr',
        },
      ],
      tenantId,
      metadata: { version: 1 },
      provisioning: [],
      createdAt: user.createdAt || new Date(),
      updatedAt: new Date(),
    });
    migrated++;
  }

  logger.log(`Migrated ${migrated} users, skipped ${skipped} (already in Identity)`);
  await client.close();
}

migrate().catch((err) => {
  logger.error('Migration failed', err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
