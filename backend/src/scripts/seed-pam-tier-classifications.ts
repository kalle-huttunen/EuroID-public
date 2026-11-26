/**
 * Seed Entitlement Catalog with PAM tier classifications for well-known Entra ID roles.
 * Run after catalog discovery to tag directory roles with adminTier and requiresAdminAccount.
 *
 * Usage: npx ts-node -r tsconfig-paths/register src/scripts/seed-pam-tier-classifications.ts
 *
 * Uses DEFAULT_TENANT_ID if no tenants found. Loads MONGO_URI from .env.
 */

import { Logger } from '@nestjs/common';
import { resolve } from 'path';
import { existsSync } from 'fs';
import { MongoClient } from 'mongodb';

const logger = new Logger('SeedPamTierClassifications');

const envPaths = [
  resolve(__dirname, '../../.env'),
  resolve(process.cwd(), '.env'),
  resolve(process.cwd(), 'backend', '.env'),
].filter((p) => existsSync(p));
if (envPaths[0]) require('dotenv').config({ path: envPaths[0] });

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/euroid';
const DEFAULT_TENANT = process.env.DEFAULT_TENANT_ID || 'default';

/** Well-known Entra ID directory role template IDs (from Microsoft docs) */
const TIER_0_ROLES = [
  { name: 'Global Administrator', nativeId: '62e90394-69f5-4237-9190-012177145e10' },
  { name: 'Exchange Administrator', nativeId: '29232cdf-9323-42fd-ade2-1d097af3e4de' },
  { name: 'SharePoint Administrator', nativeId: 'f28a1f50-6a38-4fd4-8e6e-2e0e4e0e4e0e' },
  { name: 'Security Administrator', nativeId: '194ae4cb-b126-4cea-9a6b-9e6e4e0e4e0e' },
  { name: 'Privileged Role Administrator', nativeId: 'e8611ab8-c189-46a8-b94f-6d307ad2c2b0' },
];

const TIER_1_ROLES = [
  { name: 'User Administrator', nativeId: 'fe930be7-5e62-47db-91af-98c3e49fc006' },
  { name: 'Groups Administrator', nativeId: 'fdd7a751-b60d-444a-9842-33567139b033' },
  { name: 'License Administrator', nativeId: '4d6ac14a-9153-4469-9a43-8f4326020f1f' },
  { name: 'Intune Administrator', nativeId: '158c047a-c907-4556-b7ef-446551a6b8f7' },
];

const TIER_2_ROLES = [
  { name: 'Password Administrator', nativeId: '966707d0-3269-4327-8823-9996ab0e62af' },
  { name: 'Helpdesk Administrator', nativeId: '729827e3-6e6e-4e0e-8e6e-2e0e4e0e4e0e' },
  { name: 'Reports Reader', nativeId: '4a5d8f65-41df-43e7-8cbc-8765f3567452' },
];

async function seed() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db();
  const catalog = db.collection('entitlement_catalog');

  const tenantIds = new Set<string>();
  const existing = await catalog.find({ system: 'entra-id' }).limit(1).toArray();
  if (existing.length > 0) {
    for (const doc of existing) {
      if (doc.tenantId) tenantIds.add(doc.tenantId);
    }
  }
  if (tenantIds.size === 0) tenantIds.add(DEFAULT_TENANT);

  let upserted = 0;

  for (const tenantId of tenantIds) {
    for (const { name, nativeId } of TIER_0_ROLES) {
      await catalog.updateOne(
        { tenantId, system: 'entra-id', $or: [{ nativeId }, { name }] },
        {
          $set: {
            tenantId,
            system: 'entra-id',
            name,
            nativeId,
            type: 'Group',
            adminTier: 'TIER_0',
            requiresAdminAccount: true,
            riskLevel: 'CRITICAL',
            updatedAt: new Date(),
          },
          $setOnInsert: { createdAt: new Date(), origin: 'EXTERNAL', governanceLevel: 'OPEN', governanceTags: [] },
        },
        { upsert: true },
      );
      upserted++;
    }

    for (const { name, nativeId } of TIER_1_ROLES) {
      await catalog.updateOne(
        { tenantId, system: 'entra-id', $or: [{ nativeId }, { name }] },
        {
          $set: {
            tenantId,
            system: 'entra-id',
            name,
            nativeId,
            type: 'Group',
            adminTier: 'TIER_1',
            requiresAdminAccount: true,
            riskLevel: 'HIGH',
            updatedAt: new Date(),
          },
          $setOnInsert: { createdAt: new Date(), origin: 'EXTERNAL', governanceLevel: 'OPEN', governanceTags: [] },
        },
        { upsert: true },
      );
      upserted++;
    }

    for (const { name, nativeId } of TIER_2_ROLES) {
      await catalog.updateOne(
        { tenantId, system: 'entra-id', $or: [{ nativeId }, { name }] },
        {
          $set: {
            tenantId,
            system: 'entra-id',
            name,
            nativeId,
            type: 'Group',
            adminTier: 'TIER_2',
            requiresAdminAccount: true,
            riskLevel: 'MEDIUM',
            updatedAt: new Date(),
          },
          $setOnInsert: { createdAt: new Date(), origin: 'EXTERNAL', governanceLevel: 'OPEN', governanceTags: [] },
        },
        { upsert: true },
      );
      upserted++;
    }
  }

  logger.log(`Seeded ${upserted} PAM tier classifications for ${tenantIds.size} tenant(s)`);
  await client.close();
}

seed().catch((err) => {
  logger.error('Seed failed', err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
