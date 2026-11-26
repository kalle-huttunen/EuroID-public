/**
 * Verify that expected MongoDB indexes exist.
 *
 * Compares expected indexes (from schema definitions) with actual indexes.
 * Reports missing indexes. Exit 0 if all present, 1 if any missing.
 *
 * Usage: npx ts-node -r tsconfig-paths/register src/scripts/verify-indexes.ts
 */

import { Logger } from '@nestjs/common';
import { MongoClient } from 'mongodb';

const logger = new Logger('VerifyIndexes');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/euroid';

interface ExpectedIndex {
  key: Record<string, 1 | -1>;
  unique?: boolean;
}

const EXPECTED_INDEXES: Record<string, ExpectedIndex[]> = {
  policies: [
    { key: { tenantId: 1, status: 1, priority: 1 } },
  ],
  review_campaigns: [
    { key: { tenantId: 1 } },
    { key: { status: 1 } },
    { key: { tenantId: 1, status: 1 } },
  ],
  review_items: [
    { key: { tenantId: 1 } },
    { key: { campaignId: 1 } },
    { key: { campaignId: 1, decision: 1 } },
    { key: { tenantId: 1, campaignId: 1, decision: 1 } },
  ],
  connector_configs: [
    { key: { tenantId: 1, connectorName: 1 }, unique: true },
  ],
  user_events: [
    { key: { tenantId: 1, userId: 1, timestamp: -1 } },
  ],
};

function keyMatches(a: Record<string, 1 | -1>, b: Record<string, number>): boolean {
  const keysA = Object.keys(a).sort();
  const keysB = Object.keys(b).sort();
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}

async function verify() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();

  const url = new URL(MONGO_URI);
  const dbName = url.pathname.replace(/^\//, '') || 'euroid';
  const db = client.db(dbName);

  let hasMissing = false;

  for (const [collection, expected] of Object.entries(EXPECTED_INDEXES)) {
    const coll = db.collection(collection);
    const actualIndexes = await coll.indexes();

    for (const exp of expected) {
      const found = actualIndexes.some(
        (idx) => keyMatches(exp.key, idx.key as Record<string, number>),
      );
      if (!found) {
        logger.error(`[MISSING] ${collection}: ${JSON.stringify(exp.key)}`);
        hasMissing = true;
      }
    }
  }

  if (!hasMissing) {
    logger.log('All expected indexes present.');
  }

  await client.close();
  process.exit(hasMissing ? 1 : 0);
}

verify().catch((err) => {
  logger.error('Verify failed', err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
