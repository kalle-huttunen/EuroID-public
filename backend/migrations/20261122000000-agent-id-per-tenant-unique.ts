/**
 * Migration: agents.agentId is unique per tenant only.
 *
 * The schema declared `agentId` unique on its own besides the `{ tenantId, agentId }` unique
 * index, so a second tenant could not use an agentId another tenant holds, and the conflict told
 * it that the id exists. Mongoose builds indexes but never drops them, so this migration drops
 * the global `agentId_1` index if present and makes sure the per-tenant one exists. Rerunning
 * it is safe.
 */
import { Db } from 'mongodb';

const COLLECTION = 'agents';
const GLOBAL_INDEX_NAME = 'agentId_1';
/** Must match AgentSchema.index({ tenantId: 1, agentId: 1 }, { unique: true }) in agent.schema.ts. */
const TENANT_INDEX_NAME = 'tenantId_1_agentId_1';

async function indexNames(db: Db): Promise<string[]> {
  const exists = await db.listCollections({ name: COLLECTION }, { nameOnly: true }).hasNext();
  if (!exists) return [];
  return (await db.collection(COLLECTION).indexes()).map((i) => i.name ?? '');
}

export async function up(db: Db): Promise<void> {
  const agents = db.collection(COLLECTION);
  const names = await indexNames(db);

  // Create the per-tenant index first, so agentIds are never left without a uniqueness check.
  if (!names.includes(TENANT_INDEX_NAME)) {
    await agents.createIndex(
      { tenantId: 1, agentId: 1 },
      { name: TENANT_INDEX_NAME, unique: true },
    );
  }
  if (names.includes(GLOBAL_INDEX_NAME)) {
    await agents.dropIndex(GLOBAL_INDEX_NAME);
  }
}

/** Fails (duplicate key) once two tenants share an agentId, which the old schema cannot hold. */
export async function down(db: Db): Promise<void> {
  await db
    .collection(COLLECTION)
    .createIndex({ agentId: 1 }, { name: GLOBAL_INDEX_NAME, unique: true });
}
