/**
 * Seed Entitlement Catalog with admin roles and SCIM scopes for Machine Identity Governance.
 * Run after migrations (CURRENT_TASK_94).
 *
 * Usage: npx ts-node -r tsconfig-paths/register src/scripts/seed-machine-identity-entitlements.ts
 *
 * Seeds per tenant (from admin_users and scim_tokens). Uses DEFAULT_TENANT_ID if no tenants found.
 * Loads MONGO_URI from .env (backend/.env or cwd/.env).
 */

import { Logger } from '@nestjs/common';
import { resolve } from 'path';
import { existsSync } from 'fs';
import { MongoClient } from 'mongodb';

const logger = new Logger('SeedMachineIdentityEntitlements');

const envPaths = [
  resolve(__dirname, '../../.env'),
  resolve(process.cwd(), '.env'),
  resolve(process.cwd(), 'backend', '.env'),
].filter((p) => existsSync(p));
if (envPaths[0]) require('dotenv').config({ path: envPaths[0] });

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/euroid';
const DEFAULT_TENANT = process.env.DEFAULT_TENANT_ID || 'default';

const ADMIN_ROLES = ['super-admin', 'connector-admin', 'policy-admin', 'operator', 'viewer'];
const SCIM_SCOPES = ['Users:read', 'Users:write', 'Groups:read', 'Groups:write'];

async function seed() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db();
  const catalog = db.collection('entitlement_catalog');
  const adminUsers = db.collection('admin_users');
  const scimTokens = db.collection('scim_tokens');

  const tenantIds = new Set<string>();
  const admins = await adminUsers.find({}).toArray();
  const tokens = await scimTokens.find({}).toArray();
  for (const a of admins) {
    if (a.tenantId) tenantIds.add(a.tenantId);
  }
  for (const t of tokens) {
    if (t.tenantId) tenantIds.add(t.tenantId);
  }
  if (tenantIds.size === 0) tenantIds.add(DEFAULT_TENANT);

  let adminUpserted = 0;
  let scimUpserted = 0;

  for (const tenantId of tenantIds) {
    for (const role of ADMIN_ROLES) {
      const now = new Date();
      await catalog.updateOne(
        { tenantId, system: 'euroid-admin', name: role },
        {
          $set: {
            tenantId,
            system: 'euroid-admin',
            name: role,
            nativeId: role,
            type: 'Group',
            origin: 'POLICY',
            governanceLevel: 'STRICT',
            updatedAt: now,
          },
          $setOnInsert: { createdAt: now },
        },
        { upsert: true },
      );
      adminUpserted++;
    }

    for (const scope of SCIM_SCOPES) {
      const now = new Date();
      await catalog.updateOne(
        { tenantId, system: 'euroid-scim', name: scope },
        {
          $set: {
            tenantId,
            system: 'euroid-scim',
            name: scope,
            nativeId: scope,
            type: 'License',
            origin: 'POLICY',
            governanceLevel: 'STRICT',
            updatedAt: now,
          },
          $setOnInsert: { createdAt: now },
        },
        { upsert: true },
      );
      scimUpserted++;
    }
  }

  logger.log(
    `Seeded ${adminUpserted} admin role entries and ${scimUpserted} SCIM scope entries for ${tenantIds.size} tenant(s)`,
  );
  await client.close();
}

seed().catch((err) => {
  logger.error('Seed failed', err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
