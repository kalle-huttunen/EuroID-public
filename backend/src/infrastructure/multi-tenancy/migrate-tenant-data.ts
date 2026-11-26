/**
 * POST /tenants/migrate: assigns a tenant to documents stored without one (before multi-tenancy).
 * See TenantService.migrateDatabase for the checks around it.
 */
import type { Schema } from 'mongoose';
import { tenantPlugin } from './tenant.plugin';

/**
 * Collections named before the list was derived from the models (some, like `users` and
 * `blueprintnodes`, have no model now and may hold legacy data). Kept so a legacy database is
 * still migrated in full.
 */
const LEGACY_TENANT_DATA_COLLECTIONS = [
  'identities',
  'users',
  'policies',
  'blueprintnodes',
  'canvasblueprints',
  'connector_configs',
  'entitlement_catalog',
  'role_bundles',
  'dead_letter',
  'drift_records',
  'anomalies',
  'policy_suggestions',
  'review_campaigns',
  'review_items',
  'scim_tokens',
  'user_events',
  'transaction_logs',
];

/** Per-tenant hash chains and what anchors them: a document never changes tenant there. */
const NEVER_MOVED = new Set(['audit_events', 'audit_chain_heads', 'audit_roots']);

interface RegisteredModel {
  schema: Schema;
  collection: { collectionName: string };
}

/** Whether a model's schema carries the tenant plugin (registered globally, tenant.module.ts). */
function carriesTenantPlugin(schema: Schema): boolean {
  if (schema.get('skipTenantPlugin')) return false;
  return (
    (schema as Schema & { plugins?: Array<{ fn: unknown }> }).plugins?.some(
      (p) => p.fn === tenantPlugin,
    ) ?? false
  );
}

/**
 * The collections a migration looks at: every registered model whose schema carries the tenant
 * plugin (so a new tenant collection is never missed), plus the legacy names above, minus the
 * audit chain collections. The tenants and admin_users schemas opt out of the plugin. Only the
 * models of the calling process are known; the API boots AppModule, which reaches every module
 * that registers a model (ArchivalRecord too, through ActivitiesModule).
 * migrate-tenant-data.coverage.spec.ts fails when a tenant schema is registered only where
 * AppModule does not reach and its collection is not named above.
 */
export function tenantDataCollections(models: Record<string, RegisteredModel>): string[] {
  const derived = Object.values(models)
    .filter((m) => carriesTenantPlugin(m.schema))
    .map((m) => m.collection.collectionName);
  return [...new Set([...LEGACY_TENANT_DATA_COLLECTIONS, ...derived])]
    .filter((name) => !NEVER_MOVED.has(name))
    .sort();
}

interface MigrationDb {
  collection: (name: string) => {
    countDocuments: (filter: object) => Promise<number>;
    updateMany: (filter: object, update: object) => Promise<{ modifiedCount: number }>;
  };
}

export interface TenantDataMigrationResult {
  dryRun: boolean;
  targetTenantId: string;
  /** Per collection: the documents it would move (dry run) or moved. */
  collections: Record<string, number>;
}

/**
 * Moves (or with dryRun counts) the documents without a tenant: tenantId missing, null or empty,
 * and `default` only when `includeLegacyDefault` (no live tenant has that id).
 */
export async function migrateTenantData(
  db: MigrationDb,
  collectionNames: readonly string[],
  targetTenantId: string,
  opts: { dryRun: boolean; includeLegacyDefault: boolean },
): Promise<TenantDataMigrationResult> {
  const unassigned: object[] = [
    { tenantId: { $exists: false } },
    { tenantId: null },
    { tenantId: '' },
  ];
  if (opts.includeLegacyDefault) unassigned.push({ tenantId: 'default' });
  const filter = { $or: unassigned };

  const collections: Record<string, number> = {};
  for (const name of collectionNames) {
    const coll = db.collection(name);
    collections[name] = opts.dryRun
      ? await coll.countDocuments(filter)
      : (await coll.updateMany(filter, { $set: { tenantId: targetTenantId } })).modifiedCount;
  }
  return { dryRun: opts.dryRun, targetTenantId, collections };
}
