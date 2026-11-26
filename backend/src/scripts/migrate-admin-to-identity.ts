/**
 * One-time migration: Create shadow Identity records for Admin Users.
 * Run for Machine Identity Governance (CURRENT_TASK_94).
 *
 * Usage: npx ts-node -r tsconfig-paths/register src/scripts/migrate-admin-to-identity.ts
 *
 * Does NOT modify admin_users — auth flow unchanged. Creates Identity records for governance.
 * Loads MONGO_URI from .env (backend/.env or cwd/.env).
 */

import { Logger } from '@nestjs/common';
import { resolve } from 'path';
import { existsSync } from 'fs';
import { MongoClient } from 'mongodb';

const logger = new Logger('MigrateAdminToIdentity');

const envPaths = [
  resolve(__dirname, '../../.env'),
  resolve(process.cwd(), '.env'),
  resolve(process.cwd(), 'backend', '.env'),
].filter((p) => existsSync(p));
if (envPaths[0]) require('dotenv').config({ path: envPaths[0] });

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/euroid';
const SOURCE_NAME = 'local-auth';

function parseName(name: string): { firstName: string; lastName: string } {
  const trimmed = (name || '').trim();
  if (!trimmed) return { firstName: 'Admin', lastName: 'User' };
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0], lastName: parts[0] };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

async function migrate() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db();
  const adminUsers = db.collection('admin_users');
  const identities = db.collection('identities');

  const cursor = adminUsers.find({});
  let migrated = 0;
  let skipped = 0;

  while (await cursor.hasNext()) {
    const admin = await cursor.next();
    if (!admin || !admin._id) continue;

    const tenantId = admin.tenantId || 'dev-tenant';
    const externalId = admin._id.toString();
    const { firstName, lastName } = parseName(admin.name || '');
    const email = (admin.email || '').trim().toLowerCase();
    if (!email) {
      skipped++;
      continue;
    }

    const existing = await identities.findOne({
      tenantId,
      'sources.sourceName': SOURCE_NAME,
      'sources.externalId': externalId,
    });
    if (existing) {
      skipped++;
      continue;
    }

    const status = admin.isActive === true ? 'ACTIVE' : 'SUSPENDED';
    const profile = {
      firstName,
      lastName,
      email,
      employmentType: 'ADMIN_ACCOUNT',
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

  logger.log(`Migrated ${migrated} admin users to Identity, skipped ${skipped} (already exist)`);
  await client.close();
}

migrate().catch((err) => {
  logger.error('Migration failed', err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
