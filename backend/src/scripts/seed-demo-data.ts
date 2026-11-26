/**
 * Demo data for development and demos: fills one tenant with about 200 identities of a
 * fictitious European company and the data every page shows about them (provisioning, catalog,
 * policies, timeline, drift, anomalies, risk, access requests, reviews, webhooks, dead letters,
 * joiner, mover and leaver batches). Deterministic: two runs give the same people and ids.
 *
 * Usage (from backend/): npm run seed:demo -- [--tenant <id>] [--count <n>] [--reset]
 *   --tenant  tenant to fill (default: DEV_TENANT_ID, else dev-tenant)
 *   --count   identities the identity hub lists (default 200, at least 60)
 *   --reset   remove what the seed wrote in the tenant, then seed again
 *
 * Refuses to run with NODE_ENV=production. Loads MONGO_URI from .env (backend/.env or cwd/.env).
 */
import { Logger } from '@nestjs/common';
import { resolve } from 'path';
import { existsSync } from 'fs';
import mongoose from 'mongoose';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import { seedDemoData } from './demo-seed/seed-demo';
import { SOFT_DELETED } from './demo-seed/people';
import { parseSeedArgs } from './demo-seed/args';

const logger = new Logger('SeedDemoData');

const envPaths = [
  resolve(__dirname, '../../.env'),
  resolve(process.cwd(), '.env'),
  resolve(process.cwd(), 'backend', '.env'),
].filter((p) => existsSync(p));
if (envPaths[0]) require('dotenv').config({ path: envPaths[0] });

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/euroid';

async function main(): Promise<void> {
  const args = parseSeedArgs(process.argv.slice(2), process.env);
  // Before any model compiles: the tenant plugin scopes and stamps every write
  mongoose.plugin(tenantPlugin);
  await mongoose.connect(MONGO_URI);
  try {
    const result = await seedDemoData(mongoose.connection, args);
    if (result.removed) {
      const total = Object.values(result.removed).reduce((s, n) => s + (n ?? 0), 0);
      logger.log(`Removed ${total} demo documents from tenant ${args.tenantId}`);
    }
    if (!result.seeded) {
      logger.log(
        `Tenant ${args.tenantId} already has the demo data; nothing written. Use --reset to seed it again.`,
      );
      return;
    }
    for (const [collection, n] of Object.entries(result.inserted))
      logger.log(`  ${collection}: ${n}`);
    logger.log(
      `Seeded tenant ${args.tenantId}: ${args.count} identities in the hub (+${SOFT_DELETED} offboarded)`,
    );
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    logger.error(
      `Demo seed failed: ${err instanceof Error ? err.message : String(err)}. ` +
        'A partly written seed is removed with --reset.',
    );
    process.exit(1);
  });
}
