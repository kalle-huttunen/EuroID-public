/**
 * Migration: raw national IDs leave the stored identities.
 *
 * Identity correlation stored the national ID (HETU) a hashedNationalId rule reads as it came, in
 * `sources[].rawData` (and its customAttributes) and the profile's customAttributes, and without
 * CORRELATION_HMAC_SECRET it hashed the value with a fixed key from the source code, the same for
 * every tenant (FOLLOWUPS 2026-11-25). Correlation now removes the value from every record
 * (src/modules/identity/national-id.ts); this removes what was stored before. Per tenant the keys
 * are the field of its hashedNationalId rule (the Brain's correlation settings in its draft canvas)
 * and `hetu`, in `sources[].rawData` and its customAttributes, `profile.customAttributes`, the
 * access baseline's copy of them (`accessBaseline.attributes.customAttributes`) and a held conflict
 * row (`metadata.conflictDetails.incomingSource.rawData`), on live and soft-deleted identities. A StandardUserDto field (email, employeeNumber...) is never removed from the top
 * level of a record, as correlation does.
 *
 * `profile.correlationId`, from the identity's own values (its sources and profile; a held row is
 * another person's record and only loses its values):
 * - A tenant with the rule: the hash correlation makes now with CORRELATION_HMAC_SECRET
 *   (CorrelationHashService's functions), unless it already is that hash of one of the
 *   identity's values. This repairs the hashes made with the fallback key. The raw values are the
 *   only way to rebuild those hashes, so while any tenant has the rule and the secret is missing
 *   (or under 16 characters) in this environment the run fails before any write: set it to the
 *   value the API uses, or remove the rule, and run it again.
 * - A tenant without the rule: no correlationId is made or changed; one that is the fallback-key
 *   hash of one of the identity's values (reversed by trying every HETU, and no rule uses it) is
 *   removed. Such a tenant needs no secret.
 * A recomputed hash that another identity of the tenant has or would get (one person twice, the
 * per-tenant unique index of 20261121000000) is set on none of them: each keeps its correlationId,
 * except a fallback-key hash, which is removed. Their ids and the count are logged (merge them),
 * and the run goes on.
 *
 * Then the raw values are removed. Counts and ids are logged, never values. A rule field that a
 * database path cannot name (a dot, a space) is logged by name and left. A value under
 * `sources.<i>` is removed by index with the update's filter naming the source read there
 * (sourceName, externalId): an identity whose sources changed meanwhile (a sync) is left as it is
 * and logged, never another source's entry changed. A second run changes nothing: no identity
 * holds a raw value any more.
 *
 * Bulk rollback snapshots (`rollback_snapshots`, kinds `hub-identity` and `hub-conflict-flags`,
 * kept ROLLBACK_SNAPSHOT_TTL_HOURS) taken before this release hold the same raw values, and a
 * rollback would write them back: each is decrypted, loses the same keys in its profile, sources,
 * held row and conflict flags (national-id.ts, as IdentityMutationService.restoreHubState removes
 * them), and a `profile.correlationId` that is the fallback-key hash of one of its own values is
 * removed (never replaced: the next sync of a restored identity sets the hash again). A changed
 * snapshot is encrypted again; the others are left as they are.
 *
 * Reading a tenant's correlation settings needs the encryption settings the API uses
 * (ENCRYPTION_KEY or KMS) when the Brain's config is encrypted, and so does reading a snapshot: a
 * config or a snapshot that cannot be decrypted fails the run before any identity or snapshot is
 * changed.
 */
import type { Db, Document, ObjectId } from 'mongodb';
import {
  correlationSecret,
  nationalIdDigest,
  tenantCorrelationKey,
} from '../src/infrastructure/services/correlation-hash.service';
import { decryptConfigIfEncrypted } from '../src/infrastructure/secrets/config-encryption.helper';
import type { EncryptionService } from '../src/infrastructure/secrets/encryption.service';
import { encryptionFromEnv } from '../src/infrastructure/secrets/key-rotation';
import {
  nationalIdKeys,
  nationalIdRule,
  removeNationalIdsFromConflict,
  removeNationalIdsFromHubState,
} from '../src/modules/identity/national-id';
import {
  PATH_SAFE_KEY,
  PLAN_FIELDS,
  holdBackShared,
  ownValues,
  rawValueFilter,
  rawValuePaths,
  sourceFilterOf,
  type IdentityPlan,
} from '../src/modules/identity/national-id-cleanup';
import type { CorrelationConfig } from '../src/shared/types/correlation-config';

const IDENTITIES = 'identities';
const CANVASES = 'canvasblueprints';
const SNAPSHOTS = 'rollback_snapshots';
/** The snapshot kinds that hold a Golden Record or its conflict flags (rollback-snapshot.schema.ts). */
const HUB_SNAPSHOT_KINDS = ['hub-identity', 'hub-conflict-flags'];
const BRAIN = 'euroid-core';
const LOG = '[strip-raw-national-id]';
/**
 * The key CorrelationHashService hashed with before this release when the secret was missing.
 * Only to recognize the hashes made with it; nothing hashes with it any more.
 */
const RETIRED_FALLBACK_KEY = Buffer.from('fallback-tenant-key-do-not-use-in-prod', 'utf8');

type Doc = Record<string, unknown>;

interface TenantSettings {
  tenantId: string;
  /** The keys a database path can name (the identity updates). */
  keys: string[];
  /** Every key, for what is cleaned in memory (the snapshots). */
  allKeys: string[];
  hasRule: boolean;
}

interface SnapshotPlan {
  id: ObjectId;
  ciphertext: string;
  next: string;
}

type LazyEncryption = () => Promise<EncryptionService>;

const isPlainObject = (v: unknown): v is Doc =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The tenant's Brain config, decrypted when it is stored encrypted. */
async function brainConfig(
  value: unknown,
  encryption: LazyEncryption,
  tenantId: string,
): Promise<Doc> {
  if (isPlainObject(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    return decryptConfigIfEncrypted(await encryption(), value);
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `${LOG} Cannot read the correlation settings of tenant ${tenantId}: ${reason}. Run the ` +
        'migration with the encryption settings the API uses. No identity was changed.',
    );
  }
}

/** Per tenant: the keys to remove and whether it has a hashedNationalId rule. */
async function tenantSettings(
  db: Db,
  tenantIds: string[],
  lazyEncryption: LazyEncryption,
): Promise<TenantSettings[]> {
  const settings: TenantSettings[] = [];
  for (const tenantId of tenantIds) {
    const canvas = await db.collection(CANVASES).findOne({ version: 'draft', tenantId });
    const configs = (canvas?.connectorConfigs ?? {}) as Doc;
    const brain = await brainConfig(configs[BRAIN], lazyEncryption, tenantId);
    const correlation = brain.correlationConfig as CorrelationConfig | undefined;
    const rule = Array.isArray(correlation?.rules) ? nationalIdRule(correlation) : undefined;
    const allKeys = nationalIdKeys(rule);
    const keys = allKeys.filter((k) => PATH_SAFE_KEY.test(k));
    const skipped = allKeys.filter((k) => !PATH_SAFE_KEY.test(k));
    if (skipped.length > 0) {
      console.warn(
        `${LOG} tenant ${tenantId}: ${skipped.length} rule field(s) a database path cannot name ` +
          `were not cleaned: ${skipped.map((k) => JSON.stringify(k)).join(', ')}. Values ` +
          'stored under them stay; remove them by hand.',
      );
    }
    settings.push({ tenantId, keys, allKeys, hasRule: Boolean(rule) });
  }
  return settings;
}

function planIdentity(doc: Doc, tenant: TenantSettings, tenantKey: Buffer | null): IdentityPlan {
  const values = ownValues(doc, tenant.keys);
  const stored = (doc.profile as Doc | undefined)?.correlationId;
  const current = typeof stored === 'string' ? stored : undefined;
  const currentIsFallback =
    current !== undefined &&
    values.some((v) => nationalIdDigest(RETIRED_FALLBACK_KEY, v) === current);
  // Without the rule a correlationId is never made or changed: only a fallback-key hash goes
  let target: string | null | undefined = currentIsFallback ? null : undefined;
  if (tenant.hasRule && tenantKey && values.length > 0) {
    const hashes = values.map((v) => nationalIdDigest(tenantKey, v));
    target = current !== undefined && hashes.includes(current) ? undefined : hashes[0];
  }
  const rawPaths = rawValuePaths(doc, tenant.keys);
  return {
    id: doc._id as ObjectId,
    current,
    currentIsFallback,
    target,
    rawPaths,
    sourceFilter: sourceFilterOf(doc, rawPaths),
  };
}

/**
 * Clean one decrypted snapshot in place (see the header). True when it changed. A
 * `profile.correlationId` that is the fallback-key hash of the snapshot's own values is removed.
 */
function cleanSnapshot(kind: unknown, snapshot: unknown, keys: string[]): boolean {
  if (!isPlainObject(snapshot)) return false;
  const before = JSON.stringify(snapshot);
  if (kind === 'hub-identity' && isPlainObject(snapshot.state)) {
    const state = snapshot.state;
    const profile = isPlainObject(state.profile) ? state.profile : undefined;
    const current = profile?.correlationId;
    const values = ownValues(state, keys);
    if (
      typeof current === 'string' &&
      values.some((v) => nationalIdDigest(RETIRED_FALLBACK_KEY, v) === current)
    ) {
      delete profile?.correlationId;
    }
    removeNationalIdsFromHubState(state, keys);
  } else if (kind === 'hub-conflict-flags') {
    removeNationalIdsFromConflict(snapshot.conflictDetails, keys);
  }
  return JSON.stringify(snapshot) !== before;
}

/**
 * The hub snapshots that change, each with its new ciphertext. Read before any write: a snapshot
 * that cannot be decrypted fails the run before anything is changed.
 */
async function planSnapshots(
  db: Db,
  tenants: TenantSettings[],
  lazyEncryption: LazyEncryption,
): Promise<SnapshotPlan[]> {
  const docs = await db
    .collection(SNAPSHOTS)
    .find(
      { kind: { $in: HUB_SNAPSHOT_KINDS } },
      { projection: { tenantId: 1, kind: 1, ciphertext: 1 } },
    )
    .toArray();
  if (docs.length === 0) return [];
  let encryption: EncryptionService;
  try {
    encryption = await lazyEncryption();
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `${LOG} Cannot read the rollback snapshots: ${reason}. Run the migration with the ` +
        'encryption settings the API uses. No identity was changed.',
    );
  }
  const byTenant = new Map(tenants.map((t) => [t.tenantId, t]));
  const plans: SnapshotPlan[] = [];
  const unreadable: string[] = [];
  for (const doc of docs) {
    const keys = byTenant.get(doc.tenantId as string)?.allKeys ?? nationalIdKeys(undefined);
    let snapshot: unknown;
    try {
      snapshot = JSON.parse(encryption.decrypt(doc.ciphertext as string));
    } catch {
      unreadable.push(String(doc._id));
      continue;
    }
    if (!cleanSnapshot(doc.kind, snapshot, keys)) continue;
    const next = encryption.encrypt(JSON.stringify(snapshot));
    plans.push({ id: doc._id, ciphertext: doc.ciphertext as string, next });
  }
  if (unreadable.length > 0) {
    throw new Error(
      `${LOG} ${unreadable.length} rollback snapshot(s) cannot be decrypted ` +
        `(${unreadable.join(', ')}): run the migration with the encryption settings the API ` +
        'uses. A snapshot no key opens cannot be restored either: delete it from ' +
        'rollback_snapshots by _id, or wait until it expires (ROLLBACK_SNAPSHOT_TTL_HOURS), and ' +
        'run the migration again. No identity was changed.',
    );
  }
  return plans;
}

function updateOf(plan: IdentityPlan, withHash: boolean): Document {
  const $unset: Doc = Object.fromEntries(plan.rawPaths.map((p) => [p, '']));
  const update: Document = {};
  const target = withHash ? plan.target : plan.currentIsFallback ? null : undefined;
  if (target === null) $unset['profile.correlationId'] = '';
  if (typeof target === 'string' && target !== plan.current) {
    update.$set = { 'profile.correlationId': target };
  }
  if (Object.keys($unset).length > 0) update.$unset = $unset;
  return update;
}

/** The tenant ids of a collection's documents (`filter`), empty ones left out. */
async function tenantIdsOf(db: Db, collection: string, filter: Document = {}): Promise<string[]> {
  return (await db.collection(collection).distinct('tenantId', filter)).filter(
    (t): t is string => typeof t === 'string' && t !== '',
  );
}

export async function up(db: Db): Promise<void> {
  const identities = db.collection(IDENTITIES);
  const tenantIds = await tenantIdsOf(db, IDENTITIES);
  const snapshotKinds = { kind: { $in: HUB_SNAPSHOT_KINDS } };
  const snapshotTenantIds = await tenantIdsOf(db, SNAPSHOTS, snapshotKinds);
  let encryption: Promise<EncryptionService> | undefined;
  const lazyEncryption = () => (encryption ??= encryptionFromEnv(process.env));
  // Every tenant's settings and every snapshot first: an unreadable one fails the run before
  // any change
  const tenants = await tenantSettings(
    db,
    [...new Set([...tenantIds, ...snapshotTenantIds])],
    lazyEncryption,
  );
  const snapshotPlans = await planSnapshots(db, tenants, lazyEncryption);
  const secret = correlationSecret();
  // A snapshot never gets a new hash, so only a tenant with identities needs the secret
  const withRule = tenants
    .filter((t) => t.hasRule && tenantIds.includes(t.tenantId))
    .map((t) => t.tenantId);
  if (!secret && withRule.length > 0) {
    throw new Error(
      `${LOG} CORRELATION_HMAC_SECRET is not set or shorter than 16 characters, and tenant(s) ` +
        `${withRule.join(', ')} have a Hashed National ID rule: the raw national IDs this removes ` +
        'are the only way to rebuild their hashes. Run it with CORRELATION_HMAC_SECRET: set it to ' +
        'the value the API uses, or remove the rule, then run the migration again. No identity ' +
        'was changed.',
    );
  }
  const totals = {
    identities: 0,
    values: 0,
    recomputed: 0,
    fallbackRemoved: 0,
    heldBack: 0,
    changedMeanwhile: 0,
  };

  for (const tenant of tenants) {
    const docs = await identities
      .find(rawValueFilter(tenant.tenantId, tenant.keys), { projection: PLAN_FIELDS })
      .toArray();
    if (docs.length === 0) continue;
    const tenantKey =
      secret && tenant.hasRule ? tenantCorrelationKey(secret, tenant.tenantId) : null;
    const plans = docs.map((doc) => planIdentity(doc as Doc, tenant, tenantKey));
    totals.heldBack += await holdBackShared(identities, tenant.tenantId, plans, (message) =>
      console.warn(`${LOG} ${message}`),
    );

    for (const plan of plans) {
      // The sources the index paths name must still be where they were read
      const filter = { _id: plan.id, ...plan.sourceFilter };
      let update = updateOf(plan, true);
      let matched: number;
      try {
        matched = (await identities.updateOne(filter, update)).matchedCount;
      } catch (err: unknown) {
        // Another write took the hash meanwhile: remove the raw values, keep the correlationId
        if ((err as { code?: number }).code !== 11000 || !update.$set) throw err;
        console.warn(
          `${LOG} tenant ${tenant.tenantId}: identity ${String(plan.id)} keeps its ` +
            'correlationId: another identity has the recomputed one. Merge them.',
        );
        totals.heldBack++;
        update = updateOf(plan, false);
        matched = (await identities.updateOne(filter, update)).matchedCount;
      }
      if (matched === 0) {
        console.warn(
          `${LOG} tenant ${tenant.tenantId}: identity ${String(plan.id)} changed while the ` +
            'migration ran (its sources moved): left as it is, run the migration again.',
        );
        totals.changedMeanwhile++;
        continue;
      }
      totals.identities++;
      totals.values += plan.rawPaths.length;
      if (update.$set) totals.recomputed++;
      else if ((update.$unset as Doc | undefined)?.['profile.correlationId'] === '') {
        totals.fallbackRemoved++;
      }
    }
  }

  console.log(
    `${LOG} ${totals.values} raw national ID values removed from ${totals.identities} identities ` +
      `(${tenants.length} tenants checked, ${withRule.length} with a Hashed National ID rule); ` +
      `correlationId recomputed on ${totals.recomputed}, fallback-key correlationId removed ` +
      `from ${totals.fallbackRemoved}, ${totals.heldBack} not given the recomputed one because ` +
      'another identity has the same national ID, ' +
      `${totals.changedMeanwhile} identities changed while the migration ran and were left as ` +
      'they are (logged above). CORRELATION_HMAC_SECRET was ' +
      `${secret ? 'set' : 'not set (no tenant has the rule)'}.`,
  );

  let snapshotsCleaned = 0;
  for (const plan of snapshotPlans) {
    // A snapshot that expired meanwhile (TTL index) is gone: nothing to clean
    const result = await db
      .collection(SNAPSHOTS)
      .updateOne(
        { _id: plan.id, ciphertext: plan.ciphertext },
        { $set: { ciphertext: plan.next } },
      );
    snapshotsCleaned += result.modifiedCount;
  }
  console.log(
    `${LOG} ${snapshotsCleaned} rollback snapshots cleaned of raw national IDs ` +
      `(${snapshotTenantIds.length} tenants with Golden Record snapshots).`,
  );
}

/**
 * No-op: the raw national IDs removed (from identities and rollback snapshots) cannot be restored
 * (they are not kept anywhere), and the correlationIds recomputed or removed are not put back (the
 * fallback-key hashes were reversible).
 */
export async function down(): Promise<void> {
  // Nothing to undo: see above
}
