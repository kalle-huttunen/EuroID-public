/**
 * Migration: Fix unique indexes to include tenantId.
 *
 * Drops old single/compound unique indexes that lack tenantId and creates
 * new compound unique indexes with tenantId as the first field.
 *
 * Usage: npx ts-node -r tsconfig-paths/register src/scripts/fix-tenant-unique-indexes.ts
 *
 * Collections affected:
 * - entitlement_catalog: { system, nativeId } → { tenantId, system, nativeId }
 * - connector_configs:   { connectorName }    → { tenantId, connectorName }
 * - blueprintnodes:      { nodeId }           → { tenantId, nodeId }
 */

import { Logger } from '@nestjs/common';
import { MongoClient } from 'mongodb';

const logger = new Logger('FixTenantIndexes');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/euroid';

interface IndexMigration {
  collection: string;
  oldIndex: Record<string, 1>;
  newIndex: Record<string, 1>;
  options?: { sparse?: boolean; partialFilterExpression?: Record<string, unknown> };
}

const MIGRATIONS: IndexMigration[] = [
  {
    collection: 'entitlement_catalog',
    oldIndex: { system: 1, nativeId: 1 },
    newIndex: { tenantId: 1, system: 1, nativeId: 1 },
    // As entitlement-catalog.schema.ts: rows without a nativeId are not indexed (not as null)
    options: { partialFilterExpression: { nativeId: { $type: 'string' } } },
  },
  {
    collection: 'connector_configs',
    oldIndex: { connectorName: 1 },
    newIndex: { tenantId: 1, connectorName: 1 },
  },
  {
    collection: 'blueprintnodes',
    oldIndex: { nodeId: 1 },
    newIndex: { tenantId: 1, nodeId: 1 },
  },
];

async function checkForDuplicates(
  client: MongoClient,
  dbName: string,
  migration: IndexMigration,
): Promise<boolean> {
  const db = client.db(dbName);
  const coll = db.collection(migration.collection);

  const fields = Object.keys(migration.newIndex);
  const groupId: Record<string, string> = {};
  for (const field of fields) {
    groupId[field] = `$${field}`;
  }

  const dupes = await coll
    .aggregate([
      { $group: { _id: groupId, count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
      { $limit: 5 },
    ])
    .toArray();

  if (dupes.length > 0) {
    logger.warn(
      `[WARN] ${migration.collection}: Found ${dupes.length} duplicate key groups under new compound index. Sample: ${JSON.stringify(dupes, null, 2)}`,
    );
    return true;
  }
  return false;
}

async function migrate() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();

  const url = new URL(MONGO_URI);
  const dbName = url.pathname.replace('/', '') || 'euroid';
  const db = client.db(dbName);

  logger.log(`Connected to ${MONGO_URI}, database: ${dbName}`);
  logger.log('---');

  for (const migration of MIGRATIONS) {
    const coll = db.collection(migration.collection);
    logger.log(`\n[${migration.collection}]`);

    // Check for duplicates first
    const hasDupes = await checkForDuplicates(client, dbName, migration);
    if (hasDupes) {
      logger.error('  SKIPPED — resolve duplicate records before creating unique index.');
      continue;
    }

    // Drop old unique index
    try {
      await coll.dropIndex(
        Object.keys(migration.oldIndex)
          .map((k) => `${k}_1`)
          .join('_'),
      );
      logger.log(`  Dropped old index: ${JSON.stringify(migration.oldIndex)}`);
    } catch (err: unknown) {
      const obj =
        err && typeof err === 'object' ? (err as { code?: number; codeName?: string }) : null;
      const isIndexNotFound = obj && (obj.codeName === 'IndexNotFound' || obj.code === 27);
      if (isIndexNotFound) {
        logger.log(`  Old index not found (already dropped or never existed) — OK.`);
      } else {
        throw err;
      }
    }

    // Create new compound unique index
    const indexOptions: Record<string, any> = { unique: true };
    if (migration.options?.sparse) indexOptions.sparse = true;
    if (migration.options?.partialFilterExpression) {
      indexOptions.partialFilterExpression = migration.options.partialFilterExpression;
    }

    await coll.createIndex(migration.newIndex, indexOptions);
    logger.log(
      `  Created compound unique index: ${JSON.stringify(migration.newIndex)} (options: ${JSON.stringify(indexOptions)})`,
    );
  }

  logger.log('\n--- Migration complete ---');
  await client.close();
}

migrate().catch((err) => {
  logger.error('Migration failed', err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
