/**
 * One-time migration: Create shadow Identity records for SCIM Tokens (Service Accounts).
 * Run for Machine Identity Governance (CURRENT_TASK_94).
 *
 * Usage: npx ts-node -r tsconfig-paths/register src/scripts/migrate-scim-to-identity.ts
 *
 * Does NOT modify scim_tokens — SCIM inbound flow unchanged. Creates Identity records for governance.
 * Loads MONGO_URI from .env (backend/.env or cwd/.env).
 */

import { Logger } from '@nestjs/common';
import { resolve } from 'path';
import { existsSync } from 'fs';
import { MongoClient } from 'mongodb';

const logger = new Logger('MigrateScimToIdentity');

const envPaths = [
  resolve(__dirname, '../../.env'),
  resolve(process.cwd(), '.env'),
  resolve(process.cwd(), 'backend', '.env'),
].filter((p) => existsSync(p));
if (envPaths[0]) require('dotenv').config({ path: envPaths[0] });

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/euroid';
const SOURCE_NAME = 'scim-token';

function sanitizeForEmail(name: string): string {
  return (name || '')
    .replace(/[^a-zA-Z0-9-_]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50) || 'scim';
}

async function migrate() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db();
  const scimTokens = db.collection('scim_tokens');
  const identities = db.collection('identities');

  const cursor = scimTokens.find({});
  let migrated = 0;
  let skipped = 0;

  while (await cursor.hasNext()) {
    const token = await cursor.next();
    if (!token || !token._id) continue;

    const tenantId = token.tenantId || 'default';
    const externalId = token._id.toString();
    const name = (token.name || 'SCIM Token').trim();
    const sanitized = sanitizeForEmail(name);
    const email = `scim-${sanitized}-${externalId}@service.internal`;

    const existing = await identities.findOne({
      tenantId,
      'sources.sourceName': SOURCE_NAME,
      'sources.externalId': externalId,
    });
    if (existing) {
      skipped++;
      continue;
    }

    const status = token.status === 'active' ? 'ACTIVE' : 'SUSPENDED';
    const profile = {
      firstName: name,
      lastName: 'Service Account',
      displayName: name,
      email,
      employmentType: 'SERVICE_ACCOUNT',
      status,
    };

    try {
      await identities.insertOne({
        tenantId,
        profile,
        sources: [
          {
            sourceName: SOURCE_NAME,
            externalId,
            lastSync: new Date(),
            rawData: {},
            sourceRole: 'target',
          },
        ],
        provisioning: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      migrated++;
    } catch (err: unknown) {
      const isDuplicateKey = err && typeof err === 'object' && 'code' in err && (err as { code: number }).code === 11000;
      if (isDuplicateKey) {
        skipped++;
      } else {
        throw err;
      }
    }
  }

  logger.log(`Migrated ${migrated} SCIM tokens to Identity, skipped ${skipped} (already exist)`);
  await client.close();
}

migrate().catch((err) => {
  logger.error('Migration failed', err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
