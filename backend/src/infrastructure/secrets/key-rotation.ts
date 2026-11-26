/**
 * Key rotation (src/scripts/rotate-encryption-key.ts): re-encrypts every stored secret under the
 * current key. A run first decrypts every stored secret and refuses, writing nothing, when one
 * does not decrypt, because the settings that would lose it are what the message must name. Then
 * it rewrites each secret that is not under the current key and checks again that every one is:
 * only then is it safe to remove ENCRYPTION_KEY_PREVIOUS. Steps: ROTATION_STEPS.
 */
import { randomBytes } from 'crypto';
import type { ConfigService } from '@nestjs/config';
import type { Db, Document } from 'mongodb';
import { EncryptionService } from './encryption.service';

/** Every collection that stores EncryptionService ciphertext, with the fields and their writer. */
export const SECRET_COLLECTIONS = [
  'connector_configs', // configEncrypted (ConnectorConfigService)
  'blueprintnodes', // config (BlueprintsService, encryptConfigIfNeeded)
  'canvasblueprints', // nodes[].data.config, connectorConfigs.<name> (BlueprintsService)
  'admin_users', // mfaSecret (MfaService)
  'event_subscriptions', // webhook.signingSecret (EventSubscriptionService)
  'rollback_snapshots', // ciphertext (RollbackSnapshotService)
] as const;

/** What --generate prints after the new key and key id, and the order the docs give. */
export const ROTATION_STEPS = [
  '1. Set ENCRYPTION_KEY_PREVIOUS to your current ENCRYPTION_KEY, and ENCRYPTION_KEY_PREVIOUS_ID to',
  '   your current ENCRYPTION_KEY_ID (leave it unset if you never set ENCRYPTION_KEY_ID).',
  '2. Set ENCRYPTION_KEY and ENCRYPTION_KEY_ID to the values above, and restart the API and the',
  '   worker with these settings. The worker re-encodes its Temporal schedules under the new key',
  '   at this start: check that its log names every schedule "updated" (or "created").',
  '3. Run this script with --dry-run, then without it, with the same settings.',
  '4. When it reports every stored secret under the new key id, the schedules were re-encoded',
  '   (step 2) and no Temporal workflow started before step 2 is still running (its payloads stay',
  '   encrypted under the previous key), remove ENCRYPTION_KEY_PREVIOUS and',
  '   ENCRYPTION_KEY_PREVIOUS_ID, keep ENCRYPTION_KEY_ID, and restart the API and the worker.',
];

/** A new key and a key id for it, for --generate. */
export function generateKeySettings(now = new Date()): {
  ENCRYPTION_KEY: string;
  ENCRYPTION_KEY_ID: string;
} {
  return {
    ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    ENCRYPTION_KEY_ID: `key-${now.toISOString().slice(0, 10)}-${randomBytes(3).toString('hex')}`,
  };
}

/** EncryptionService with the keys of these environment variables, loaded (throws on bad settings). */
export async function encryptionFromEnv(
  env: Record<string, string | undefined>,
): Promise<EncryptionService> {
  const config = { get: (key: string) => env[key.replace(/^encryption\./, '')] };
  const encryption = new EncryptionService(config as unknown as ConfigService);
  await encryption.onModuleInit();
  return encryption;
}

export interface UndecryptableSecret {
  collection: string;
  id: string;
  keyId: string;
  reason: string;
}

export interface RotationReport {
  dryRun: boolean;
  currentKeyId: string;
  /** Per collection: the secrets found and how many were not under the current key. */
  collections: Array<{ name: string; secrets: number; notUnderCurrentKey: number }>;
  /** Secrets these settings cannot decrypt. When there is one, the run wrote nothing. */
  undecryptable: UndecryptableSecret[];
  /** After the run, secrets not under the current key (0: ENCRYPTION_KEY_PREVIOUS can go). */
  remaining: number;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null &&
  typeof v === 'object' &&
  [Object.prototype, null].includes(Object.getPrototypeOf(v));

/** `value` with `fn` applied to every ciphertext in it, at any depth of arrays and objects. */
function mapSecrets(enc: EncryptionService, value: unknown, fn: (c: string) => string): unknown {
  if (typeof value === 'string') return enc.isEncrypted(value) ? fn(value) : value;
  if (Array.isArray(value)) return value.map((v) => mapSecrets(enc, v, fn));
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapSecrets(enc, v, fn)]));
  }
  return value;
}

/** The key id a stored secret names, for the refusal message. */
const keyIdOf = (enc: EncryptionService, c: string): string => {
  try {
    return enc.keyIdOf(c);
  } catch {
    return '(malformed)';
  }
};

/** Every stored secret: how many per collection, which are not under the current key, which fail. */
async function scan(db: Db, enc: EncryptionService) {
  const collections: RotationReport['collections'] = [];
  const undecryptable: UndecryptableSecret[] = [];
  for (const name of SECRET_COLLECTIONS) {
    const entry = { name, secrets: 0, notUnderCurrentKey: 0 };
    for await (const doc of db.collection(name).find({})) {
      mapSecrets(enc, doc, (c) => {
        entry.secrets++;
        try {
          enc.decrypt(c);
          if (!enc.isUnderCurrentKey(c)) entry.notUnderCurrentKey++;
        } catch (err: unknown) {
          const reason = err instanceof Error ? err.message : String(err);
          undecryptable.push({
            collection: name,
            id: String(doc._id),
            keyId: keyIdOf(enc, c),
            reason,
          });
        }
        return c;
      });
    }
    collections.push(entry);
  }
  return { collections, undecryptable };
}

/** Re-encrypts the secrets of one document that are not under the current key. */
async function reEncryptDocument(db: Db, name: string, doc: Document, enc: EncryptionService) {
  const filter: Document = { _id: doc._id };
  const set: Document = {};
  for (const [field, value] of Object.entries(doc)) {
    if (field === '_id') continue;
    let changed = false;
    const next = mapSecrets(enc, value, (c) => {
      if (enc.isUnderCurrentKey(c)) return c;
      changed = true;
      return enc.reEncrypt(c);
    });
    if (changed) {
      // Written only over the value read here: a concurrent write is kept, and counted as remaining.
      filter[field] = value;
      set[field] = next;
    }
  }
  if (Object.keys(set).length === 0) return;
  await db.collection(name).updateOne(filter, { $set: set });
}

/**
 * Re-encrypts every stored secret under `encryption`'s current key. Refuses (writes nothing) when
 * any stored secret does not decrypt with these settings; `dryRun` reports and writes nothing.
 */
export async function rotateStoredSecrets(
  db: Db,
  encryption: EncryptionService,
  { dryRun }: { dryRun: boolean },
): Promise<RotationReport> {
  const before = await scan(db, encryption);
  const pending = (s: typeof before) => s.collections.reduce((n, c) => n + c.notUnderCurrentKey, 0);
  const report = { dryRun, currentKeyId: encryption.getCurrentKeyId(), ...before };
  if (dryRun || before.undecryptable.length > 0) return { ...report, remaining: pending(before) };

  for (const name of SECRET_COLLECTIONS) {
    for await (const doc of db.collection(name).find({})) {
      await reEncryptDocument(db, name, doc, encryption);
    }
  }
  const after = await scan(db, encryption);
  return { ...report, remaining: pending(after) + after.undecryptable.length };
}

/** What the run did and what the operator does next, one line each. */
export function describeRotation(report: RotationReport): string[] {
  const lines = report.collections.map(
    (c) =>
      `${c.name}: ${c.secrets} secrets, ${c.notUnderCurrentKey} not under key "${report.currentKeyId}"`,
  );
  if (report.undecryptable.length > 0) {
    return [...lines, ...describeUndecryptable(report)];
  }
  if (report.dryRun) {
    return [
      ...lines,
      `Dry run: ${report.remaining} secrets would be re-encrypted. Nothing written.`,
    ];
  }
  if (report.remaining > 0) {
    return [
      ...lines,
      `${report.remaining} stored secrets are still not under key "${report.currentKeyId}" (written ` +
        'or changed while this ran). Run the script again. Do not remove ENCRYPTION_KEY_PREVIOUS yet.',
    ];
  }
  return [
    ...lines,
    `Every stored secret is encrypted under key "${report.currentKeyId}". You can remove ` +
      'ENCRYPTION_KEY_PREVIOUS and ENCRYPTION_KEY_PREVIOUS_ID (keep ENCRYPTION_KEY_ID) and restart ' +
      'the API and the worker once no Temporal workflow started before the rotation is still ' +
      'running (its payloads stay encrypted under the previous key) and the worker restarted ' +
      'with the new key logged every schedule "updated" (schedules keep their args as encoded ' +
      'when last written).',
  ];
}

function describeUndecryptable(report: RotationReport): string[] {
  const byKeyId = new Map<string, UndecryptableSecret[]>();
  for (const u of report.undecryptable) byKeyId.set(u.keyId, [...(byKeyId.get(u.keyId) ?? []), u]);
  const lines = [
    `Refused: ${report.undecryptable.length} stored secrets do not decrypt with these settings. ` +
      'Nothing was written.',
  ];
  for (const [keyId, secrets] of byKeyId) {
    const where = secrets
      .slice(0, 5)
      .map((s) => `${s.collection} ${s.id}`)
      .join(', ');
    const missing = secrets.every((s) => s.reason.startsWith('Encryption key not found'));
    lines.push(
      missing
        ? `${secrets.length} name key id "${keyId}", which these settings have no key for (${where}). ` +
            `If it is the key you are rotating from, set ENCRYPTION_KEY_PREVIOUS to that key and ` +
            `ENCRYPTION_KEY_PREVIOUS_ID=${keyId}.`
        : `${secrets.length} name key id "${keyId}" but do not decrypt with the key these settings ` +
            `give it (${where}): ${secrets[0].reason}. Set ENCRYPTION_KEY_PREVIOUS (for ` +
            `"${keyId}" during a rotation) or ENCRYPTION_KEY to the key they were encrypted with.`,
    );
  }
  return lines;
}
