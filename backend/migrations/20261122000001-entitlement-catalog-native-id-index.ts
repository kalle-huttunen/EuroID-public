/**
 * Migration: entitlement_catalog's native id is unique only where a row has one.
 *
 * The `{ tenantId, system, nativeId }` unique index was sparse. A sparse compound index still
 * indexes every document that has any of its keys (tenantId and system always exist), so rows
 * without a nativeId counted as nativeId null and a second one on the same system failed with
 * E11000. Policies register the Entra groups they name before discovery has found their ids
 * (registerPolicyGroup), so a second policy naming another group answered POST /policy with 500.
 *
 * Mongoose builds indexes but never replaces one with other options, so this migration drops the
 * sparse index and creates the partial one (`nativeId` a string) under the same name. A native id
 * is never left duplicated: the old index kept them unique. Rerunning it is safe.
 */
import { Db } from 'mongodb';

const COLLECTION = 'entitlement_catalog';
const INDEX_NAME = 'tenantId_1_system_1_nativeId_1';
/** Must match the partialFilterExpression in entitlement-catalog.schema.ts. */
const PARTIAL_FILTER = { nativeId: { $type: 'string' } };

async function currentIndex(db: Db): Promise<Record<string, unknown> | undefined> {
  const exists = await db.listCollections({ name: COLLECTION }, { nameOnly: true }).hasNext();
  if (!exists) return undefined;
  return (await db.collection(COLLECTION).indexes()).find((i) => i.name === INDEX_NAME);
}

export async function up(db: Db): Promise<void> {
  const index = await currentIndex(db);
  if (index?.partialFilterExpression) return;
  const catalog = db.collection(COLLECTION);
  if (index) await catalog.dropIndex(INDEX_NAME);
  await catalog.createIndex(
    { tenantId: 1, system: 1, nativeId: 1 },
    { name: INDEX_NAME, unique: true, partialFilterExpression: PARTIAL_FILTER },
  );
}

/** Fails (duplicate key) once a system holds two rows without a nativeId, as the old index did. */
export async function down(db: Db): Promise<void> {
  const index = await currentIndex(db);
  if (index && !index.partialFilterExpression) return;
  const catalog = db.collection(COLLECTION);
  if (index) await catalog.dropIndex(INDEX_NAME);
  await catalog.createIndex(
    { tenantId: 1, system: 1, nativeId: 1 },
    { name: INDEX_NAME, unique: true, sparse: true },
  );
}
