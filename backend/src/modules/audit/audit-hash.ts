/**
 * How an audit event's integrityHash is computed. Pure functions, shared by the writer
 * (AuditService), the chain check and the checkpoint check.
 *
 * Version 2 (`hashVersion: 2`, every event written since the per-tenant chain head): SHA-256 of
 * the event's previousHash followed by the canonical JSON of every stored field except
 * integrityHash, previousHash and Mongoose's own bookkeeping (`__v`, `createdAt`, `updatedAt`).
 * `_id`, `seq`, `hashVersion`, `eventId` and the whole `payload` are covered.
 *
 * Version 1 (events without `hashVersion`, written before): JSON.stringify with the sorted
 * top-level key names as its replacer. The replacer is an allow-list at every depth, so nested
 * objects keep only keys that happen to share a top-level name: `payload` hashes as `{}` and a
 * changed payload goes unnoticed. Kept only to check those events; their stored hashes are never
 * rewritten.
 */
import { createHash } from 'crypto';

export const AUDIT_HASH_VERSION = 2;

/** previousHash of a tenant's first event. */
export const GENESIS_HASH = createHash('sha256').update('euroid-genesis').digest('hex');

/** Fields no hash covers: the hash itself, the link it is computed with, Mongoose bookkeeping. */
const NOT_HASHED = new Set(['integrityHash', 'previousHash', '__v', 'createdAt', 'updatedAt']);

/** Version 1 also left out `_id` (assigned by MongoDB after hashing). */
const NOT_HASHED_V1 = new Set([...NOT_HASHED, '_id']);

const sha256 = (input: string) => createHash('sha256').update(input).digest('hex');

/**
 * JSON with object keys sorted at every depth (UTF-16 code unit order, as RFC 8785). Values with
 * a toJSON (Date, ObjectId) are written as their JSON form; undefined object values are left out
 * and undefined array items are null, as JSON.stringify does.
 */
export function canonicalJson(value: unknown): string {
  const v =
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { toJSON?: unknown }).toJSON === 'function'
      ? (value as { toJSON: () => unknown }).toJSON()
      : value;
  if (Array.isArray(v)) {
    return `[${v.map((item) => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`;
  }
  if (v !== null && typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    const members = Object.keys(obj)
      .sort()
      .filter((key) => obj[key] !== undefined && typeof obj[key] !== 'function')
      // eslint-disable-next-line no-restricted-syntax -- hash input, never logged
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`);
    return `{${members.join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/** The hash of an event as stored, by the rule of its own hashVersion. */
export function auditEventHash(stored: Record<string, unknown>): string {
  return stored.hashVersion === AUDIT_HASH_VERSION ? hashV2(stored) : hashV1(stored);
}

function hashV2(stored: Record<string, unknown>): string {
  const covered: Record<string, unknown> = {};
  for (const key of Object.keys(stored)) {
    if (!NOT_HASHED.has(key)) covered[key] = stored[key];
  }
  return sha256(String(stored.previousHash) + canonicalJson(covered));
}

function hashV1(stored: Record<string, unknown>): string {
  const canonical: Record<string, unknown> = {};
  for (const key of Object.keys(stored).sort()) {
    if (!NOT_HASHED_V1.has(key)) canonical[key] = stored[key];
  }
  return sha256(
    String(stored.previousHash) + JSON.stringify(canonical, Object.keys(canonical).sort()),
  );
}
