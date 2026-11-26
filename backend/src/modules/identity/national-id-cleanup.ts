/**
 * Removing national IDs already stored in identities: the values a tenant's Hashed National ID
 * rule field (and `hetu`) holds in `sources[].rawData` and its customAttributes,
 * `profile.customAttributes`, the access baseline's copy and a held conflict row. Correlation
 * removes them from every incoming record (national-id.ts); these remove what was stored before.
 *
 * Migration 20261125000000-strip-raw-national-id runs it once over every tenant (with its own
 * handling of the retired fallback key and of rollback snapshots). Saving a Brain config whose
 * rule names a new key runs it for that tenant (removeStoredNationalIds), since values stored
 * under the key before it was named are still raw. Counts and ids are logged, never values.
 */
import type { Collection, Document, ObjectId } from 'mongodb';
import type { CorrelationConfig } from '@shared/types/correlation-config';
import {
  correlationSecret,
  nationalIdDigest,
  tenantCorrelationKey,
} from '@infrastructure/services/correlation-hash.service';
import {
  isRemovableTopLevelKey,
  nationalIdField,
  nationalIdKeys,
  nationalIdRule,
} from './national-id';

/** The held conflict row's raw record. */
export const HELD_RAW = 'metadata.conflictDetails.incomingSource.rawData';
/** The profile values policy access was last applied with (shared/utils/access-baseline.ts). */
export const BASELINE_CUSTOM = 'accessBaseline.attributes.customAttributes';
/** A key a path can name (a custom attribute key, hr-field-map.ts); others are skipped. */
export const PATH_SAFE_KEY = /^[A-Za-z0-9_-]{1,100}$/;

/** The fields an identity's plan reads. */
export const PLAN_FIELDS = {
  'profile.correlationId': 1,
  'profile.customAttributes': 1,
  'sources.sourceName': 1,
  'sources.externalId': 1,
  'sources.rawData': 1,
  [BASELINE_CUSTOM]: 1,
  [HELD_RAW]: 1,
};

type Doc = Record<string, unknown>;

/** What one identity's cleanup writes. */
export interface IdentityPlan {
  id: ObjectId;
  current?: string;
  currentIsFallback: boolean;
  /** undefined: keep profile.correlationId; null: remove it; a string: set it. */
  target?: string | null;
  rawPaths: string[];
  /** The sources the index paths name, as read: the update applies only while they are there. */
  sourceFilter: Doc;
}

const isPlainObject = (v: unknown): v is Doc =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const has = (obj: unknown, key: string): obj is Doc =>
  isPlainObject(obj) && Object.prototype.hasOwnProperty.call(obj, key);
const text = (v: unknown): string =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';

/** Identities of the tenant holding a raw value under one of `keys`, anywhere. */
export function rawValueFilter(tenantId: string, keys: string[]): Document {
  const paths: string[] = [];
  for (const key of keys) {
    if (isRemovableTopLevelKey(key)) paths.push(`sources.rawData.${key}`, `${HELD_RAW}.${key}`);
    paths.push(
      `sources.rawData.customAttributes.${key}`,
      `profile.customAttributes.${key}`,
      `${BASELINE_CUSTOM}.${key}`,
      `${HELD_RAW}.customAttributes.${key}`,
    );
  }
  return { tenantId, $or: paths.map((p) => ({ [p]: { $exists: true } })) };
}

/** The identity's own values (sources, then profile), the rule's field first. Not a held row's. */
export function ownValues(doc: Doc, keys: string[]): string[] {
  const sources = Array.isArray(doc.sources) ? (doc.sources as Doc[]) : [];
  const profile = isPlainObject(doc.profile) ? doc.profile : {};
  const values: string[] = [];
  for (const key of keys) {
    for (const source of sources) {
      const raw = isPlainObject(source?.rawData) ? source.rawData : {};
      if (isRemovableTopLevelKey(key)) values.push(text(raw[key]));
      values.push(text((raw.customAttributes as Doc | undefined)?.[key]));
    }
    values.push(text((profile.customAttributes as Doc | undefined)?.[key]));
  }
  return values.filter((v) => v.trim() !== '');
}

/** The paths of every raw value under `keys`, the held row's included. */
export function rawValuePaths(doc: Doc, keys: string[]): string[] {
  const paths: string[] = [];
  const collect = (raw: unknown, prefix: string) => {
    for (const key of keys) {
      if (isRemovableTopLevelKey(key) && has(raw, key)) paths.push(`${prefix}.${key}`);
      const custom = isPlainObject(raw) ? raw.customAttributes : undefined;
      if (has(custom, key)) paths.push(`${prefix}.customAttributes.${key}`);
    }
  };
  const sources = Array.isArray(doc.sources) ? (doc.sources as Doc[]) : [];
  sources.forEach((source, i) => collect(source?.rawData, `sources.${i}.rawData`));
  const profileCustom = (doc.profile as Doc | undefined)?.customAttributes;
  const baseline = (doc.accessBaseline as Doc | undefined)?.attributes as Doc | undefined;
  for (const key of keys) {
    if (has(profileCustom, key)) paths.push(`profile.customAttributes.${key}`);
    if (has(baseline?.customAttributes, key)) paths.push(`${BASELINE_CUSTOM}.${key}`);
  }
  const conflict = (doc.metadata as Doc | undefined)?.conflictDetails as Doc | undefined;
  collect((conflict?.incomingSource as Doc | undefined)?.rawData, HELD_RAW);
  return paths;
}

/** For each `sources.<i>` the paths name: that source's sourceName and externalId as read. */
export function sourceFilterOf(doc: Doc, rawPaths: string[]): Doc {
  const sources = Array.isArray(doc.sources) ? (doc.sources as Doc[]) : [];
  const filter: Doc = {};
  for (const p of rawPaths) {
    const index = /^sources\.(\d+)\./.exec(p)?.[1];
    if (index === undefined) continue;
    filter[`sources.${index}.sourceName`] = sources[Number(index)]?.sourceName ?? null;
    filter[`sources.${index}.externalId`] = sources[Number(index)]?.externalId ?? null;
  }
  return filter;
}

/**
 * A recomputed hash another identity of the tenant has or would get is set on none of them (each
 * keeps its correlationId, a fallback-key hash is removed). Returns how many were held back.
 * `warn` gets the message naming the identities (ids only).
 */
export async function holdBackShared(
  identities: Collection,
  tenantId: string,
  plans: IdentityPlan[],
  warn: (message: string) => void,
): Promise<number> {
  const changes = (p: IdentityPlan) => typeof p.target === 'string' && p.target !== p.current;
  const targets = plans.filter(changes).map((p) => p.target as string);
  if (targets.length === 0) return 0;
  const planned = new Set(plans.map((p) => String(p.id)));
  const others = await identities
    .find(
      { tenantId, 'profile.correlationId': { $in: targets } },
      { projection: { 'profile.correlationId': 1 } },
    )
    .toArray();
  const heldBack = new Set<string>();
  for (;;) {
    const holders = new Map<string, string[]>();
    const hold = (value: string | undefined, id: string) => {
      if (value) holders.set(value, [...(holders.get(value) ?? []), id]);
    };
    for (const o of others) {
      if (!planned.has(String(o._id))) hold(o.profile?.correlationId as string, String(o._id));
    }
    for (const p of plans) {
      hold(p.target === undefined ? p.current : (p.target ?? undefined), String(p.id));
    }
    let revised = false;
    for (const ids of holders.values()) {
      const movers = plans.filter((p) => ids.includes(String(p.id)) && changes(p));
      if (ids.length < 2 || movers.length === 0) continue;
      warn(
        `tenant ${tenantId}: ${ids.length} identities would share one correlationId ` +
          `(${ids.join(', ')}), so it was set on none of them. Merge them.`,
      );
      for (const m of movers) {
        m.target = m.currentIsFallback ? null : undefined;
        heldBack.add(String(m.id));
        revised = true;
      }
    }
    if (!revised) return heldBack.size;
  }
}

/** What removeStoredNationalIds did, as counts. */
export interface StoredNationalIdCleanup {
  identities: number;
  values: number;
  hashed: number;
  heldBack: number;
  changedMeanwhile: number;
}

/**
 * Remove the raw values under `keys` from the tenant's identities, live and soft-deleted. With
 * `hash` (the tenant has the rule and the secret is set) an identity without the hash of one of
 * its own values as its correlationId gets it, unless another identity has or would get it
 * (holdBackShared, or the unique index meanwhile): that one keeps its correlationId, and the
 * value goes all the same. An identity whose sources moved meanwhile is left and counted. A key a
 * database path cannot name is skipped (`warn`). Safe to run again.
 */
export async function removeStoredNationalIds(
  identities: Collection,
  tenantId: string,
  keys: string[],
  hash: ((value: string) => string) | null,
  warn: (message: string) => void,
): Promise<StoredNationalIdCleanup> {
  const totals = { identities: 0, values: 0, hashed: 0, heldBack: 0, changedMeanwhile: 0 };
  const safeKeys = keys.filter((k) => PATH_SAFE_KEY.test(k));
  if (safeKeys.length < keys.length) {
    warn(`tenant ${tenantId}: a rule field a database path cannot name was not cleaned`);
  }
  if (safeKeys.length === 0) return totals;
  const docs = await identities
    .find(rawValueFilter(tenantId, safeKeys), { projection: PLAN_FIELDS })
    .toArray();
  const plans: IdentityPlan[] = docs.map((doc) => {
    const values = ownValues(doc as Doc, safeKeys);
    const stored = (doc.profile as Doc | undefined)?.correlationId;
    const current = typeof stored === 'string' ? stored : undefined;
    const hashes = hash ? values.map(hash) : [];
    const keep = hashes.length === 0 || (current !== undefined && hashes.includes(current));
    const rawPaths = rawValuePaths(doc as Doc, safeKeys);
    return {
      id: doc._id as ObjectId,
      current,
      currentIsFallback: false,
      target: keep ? undefined : hashes[0],
      rawPaths,
      sourceFilter: sourceFilterOf(doc as Doc, rawPaths),
    };
  });
  totals.heldBack += await holdBackShared(identities, tenantId, plans, warn);
  for (const plan of plans) {
    const filter = { _id: plan.id, ...plan.sourceFilter };
    const $unset = Object.fromEntries(plan.rawPaths.map((p) => [p, '']));
    const hashed = typeof plan.target === 'string';
    const update: Document = hashed
      ? { $unset, $set: { 'profile.correlationId': plan.target } }
      : { $unset };
    let matched: number;
    let gotHash = hashed;
    try {
      matched = (await identities.updateOne(filter, update)).matchedCount;
    } catch (err: unknown) {
      // Another write took the hash meanwhile: remove the raw values, keep the correlationId
      if ((err as { code?: number }).code !== 11000 || !hashed) throw err;
      warn(
        `tenant ${tenantId}: identity ${String(plan.id)} keeps its correlationId: another ` +
          'identity has the hash of its national ID. Merge them.',
      );
      totals.heldBack++;
      gotHash = false;
      matched = (await identities.updateOne(filter, { $unset })).matchedCount;
    }
    if (matched === 0) {
      warn(`tenant ${tenantId}: identity ${String(plan.id)} changed meanwhile: left as it is`);
      totals.changedMeanwhile++;
      continue;
    }
    totals.identities++;
    totals.values += plan.rawPaths.length;
    if (gotHash) totals.hashed++;
  }
  return totals;
}

/**
 * After the Brain's correlation settings are saved (POST /blueprints/save): when its Hashed
 * National ID rule names a field it did not name before (the rule was added, or its field
 * changed), the values stored under the rule's keys are removed from the tenant's identities and
 * each identity gets the hash of its value as its correlationId (removeStoredNationalIds).
 * Correlation strips the key from every record it receives from now on. Null when the saved
 * settings name no new field.
 */
export async function cleanStoredNationalIdsAfterSave(
  identities: Collection,
  tenantId: string,
  previous: CorrelationConfig | undefined,
  saved: CorrelationConfig | undefined,
  logger: { log: (message: string) => void; warn: (message: string) => void },
): Promise<StoredNationalIdCleanup | null> {
  const rule = nationalIdRule(saved);
  if (!rule) return null;
  const before = nationalIdRule(previous);
  if (before && nationalIdField(before) === nationalIdField(rule)) return null;
  const secret = correlationSecret();
  const key = secret ? tenantCorrelationKey(secret, tenantId) : null;
  const result = await removeStoredNationalIds(
    identities,
    tenantId,
    nationalIdKeys(rule),
    key ? (value) => nationalIdDigest(key, value) : null,
    (message) => logger.warn(`[national-id cleanup] ${message}`),
  );
  logger.log(
    `[national-id cleanup] tenant ${tenantId}: ${result.values} stored national ID values ` +
      `removed from ${result.identities} identities, correlationId set on ${result.hashed}, ` +
      `${result.heldBack} held back (another identity has the hash), ` +
      `${result.changedMeanwhile} changed meanwhile`,
  );
  return result;
}
