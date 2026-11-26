/**
 * Key rotation end to end on in-memory MongoDB. A deployment that never set ENCRYPTION_KEY_ID
 * stored secrets under key A in every collection that holds ciphertext (so they name the key id
 * "default"). The script's steps (--generate, the rotation settings, a dry run, the run) move every
 * secret to key B; with key A dropped, every secret still decrypts. A second rotation, B to C,
 * works the same way. Settings that would lose secrets are refused before anything is written.
 */
import mongoose, { Model } from 'mongoose';
import type { Db } from 'mongodb';
import { connectTestDb, clearTestDb, closeTestDb } from '@testing';
import {
  ConnectorConfig,
  ConnectorConfigSchema,
} from '../../modules/connectors/schemas/connector-config.schema';
import {
  BlueprintNode,
  BlueprintSchema,
  CanvasBlueprint,
  CanvasBlueprintSchema,
} from '../../modules/blueprints/schemas/blueprint.schema';
import { AdminUser, AdminUserSchema } from '../../modules/auth/schemas/admin-user.schema';
import {
  EventSubscription,
  EventSubscriptionSchema,
} from '../../modules/event-subscriptions/schemas/event-subscription.schema';
import {
  RollbackSnapshot,
  RollbackSnapshotSchema,
} from '../../modules/bulk-provisioning/schemas/rollback-snapshot.schema';
import type { EncryptionService } from './encryption.service';
import {
  SECRET_COLLECTIONS,
  describeRotation,
  encryptionFromEnv,
  generateKeySettings,
  rotateStoredSecrets,
} from './key-rotation';

const KEY_A = Buffer.alloc(32, 'a').toString('base64');
const TENANT = 'tenant-a';

/** The plaintext of every secret this test stores, by where it is stored. */
const PLAINTEXT = {
  connector: JSON.stringify({ orgName: 'acme', personalAccessToken: 'ghp_s3cret' }),
  blueprintNode: JSON.stringify({ clientSecret: 'entra-s3cret' }),
  canvasNode: JSON.stringify({ apiToken: 'okta-s3cret' }),
  canvasConnector: JSON.stringify({ bindPassword: 'ad-s3cret' }),
  mfaSecret: 'JBSWY3DPEHPK3PXP',
  signingSecret: 'whsec_s3cret',
  snapshot: JSON.stringify({ upn: 'person@example.com' }),
  legacyV1: JSON.stringify({ password: 'v1-s3cret' }),
};

/** The stored fields this test reads back (each collection has some of them). */
type StoredDoc = {
  configEncrypted: string;
  config: string;
  mfaSecret: string;
  ciphertext: string;
  webhook: { signingSecret: string };
  nodes: Array<{ data: { config: string } }>;
  connectorConfigs: Record<string, string>;
};

const model = (name: string, schema: mongoose.Schema) =>
  (mongoose.models[name] ?? mongoose.model(name, schema)) as Model<unknown>;

/** v1 ciphertext (no key id), as TASK_102 found it stored: `default` key. */
function v1Ciphertext(encryption: EncryptionService, plaintext: string): string {
  const v2 = encryption.encrypt(plaintext);
  return `euroid:v1:${v2.slice(v2.lastIndexOf(':') + 1)}`;
}

describe('Key rotation (in-memory MongoDB, every collection with secrets)', () => {
  let db: Db;

  beforeAll(async () => {
    await connectTestDb();
    db = mongoose.connection.db as unknown as Db;
  });

  afterEach(async () => {
    await clearTestDb();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  /** Secrets as each writer stores them, through each schema's own collection. */
  async function storeSecrets(enc: EncryptionService) {
    await model(ConnectorConfig.name, ConnectorConfigSchema).collection.insertMany([
      {
        tenantId: TENANT,
        connectorName: 'github',
        configEncrypted: enc.encrypt(PLAINTEXT.connector),
      },
      {
        tenantId: TENANT,
        connectorName: 'okta',
        configEncrypted: v1Ciphertext(enc, PLAINTEXT.legacyV1),
      },
    ]);
    await model(BlueprintNode.name, BlueprintSchema).collection.insertMany([
      { tenantId: TENANT, nodeId: 'entra-target', config: enc.encrypt(PLAINTEXT.blueprintNode) },
      { tenantId: TENANT, nodeId: 'csv-hr', config: { filePath: '/data/hr.csv' } },
    ]);
    await model(CanvasBlueprint.name, CanvasBlueprintSchema).collection.insertOne({
      tenantId: TENANT,
      version: 'draft',
      nodes: [
        { id: 'n1', data: { type: 'okta', config: enc.encrypt(PLAINTEXT.canvasNode) } },
        { id: 'n2', data: { type: 'csv-hr', config: { filePath: '/data/hr.csv' } } },
      ],
      connectorConfigs: { ad: enc.encrypt(PLAINTEXT.canvasConnector), 'csv-hr': { filePath: 'x' } },
    });
    await model(AdminUser.name, AdminUserSchema).collection.insertOne({
      email: 'owner@tenant-a.example',
      passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA',
      mfaSecret: enc.encrypt(PLAINTEXT.mfaSecret),
    });
    await model(EventSubscription.name, EventSubscriptionSchema).collection.insertOne({
      tenantId: TENANT,
      name: 'siem',
      webhook: {
        url: 'https://siem.example.com/hook',
        signingSecret: enc.encrypt(PLAINTEXT.signingSecret),
      },
    });
    await model(RollbackSnapshot.name, RollbackSnapshotSchema).collection.insertOne({
      tenantId: TENANT,
      kind: 'entra-state',
      ciphertext: enc.encrypt(PLAINTEXT.snapshot),
      createdAt: new Date(),
    });
  }

  /** Every stored ciphertext, decrypted by `enc`, by where it is stored. */
  async function decryptAll(enc: EncryptionService) {
    const one = async (collection: string, filter: object) =>
      db.collection(collection).findOne(filter) as unknown as Promise<StoredDoc>;
    const canvas = await one('canvasblueprints', { version: 'draft' });
    return {
      connector: enc.decrypt(
        (await one('connector_configs', { connectorName: 'github' })).configEncrypted,
      ),
      legacyV1: enc.decrypt(
        (await one('connector_configs', { connectorName: 'okta' })).configEncrypted,
      ),
      blueprintNode: enc.decrypt((await one('blueprintnodes', { nodeId: 'entra-target' })).config),
      canvasNode: enc.decrypt(canvas.nodes[0].data.config),
      canvasConnector: enc.decrypt(canvas.connectorConfigs.ad),
      mfaSecret: enc.decrypt((await one('admin_users', {})).mfaSecret),
      signingSecret: enc.decrypt((await one('event_subscriptions', {})).webhook.signingSecret),
      snapshot: enc.decrypt((await one('rollback_snapshots', {})).ciphertext),
    };
  }

  const snapshotDb = async () =>
    Promise.all(SECRET_COLLECTIONS.map((c) => db.collection(c).find({}).toArray()));

  it('stores secrets in every collection the script rotates', async () => {
    await storeSecrets(await encryptionFromEnv({ ENCRYPTION_KEY: KEY_A }));

    const counts = await Promise.all(
      SECRET_COLLECTIONS.map((c) => db.collection(c).countDocuments()),
    );
    expect(counts.every((n) => n > 0)).toBe(true);
  });

  it('A to B by the documented steps: with A dropped, every secret decrypts', async () => {
    await storeSecrets(await encryptionFromEnv({ ENCRYPTION_KEY: KEY_A }));

    // Step 1: --generate. Step 2: the previous key, the new key and its id (no previous id: the
    // deployment never set ENCRYPTION_KEY_ID).
    const keyB = generateKeySettings();
    const rotating = await encryptionFromEnv({ ...keyB, ENCRYPTION_KEY_PREVIOUS: KEY_A });
    // The API and the worker run with these settings: what they write is under B.
    const writtenDuringRotation = rotating.encrypt('written-during-rotation');

    // Step 3: the dry run writes nothing; the run re-encrypts every secret.
    const before = await snapshotDb();
    const dry = await rotateStoredSecrets(db, rotating, { dryRun: true });
    expect(dry).toMatchObject({ undecryptable: [], remaining: 8 });
    expect(await snapshotDb()).toEqual(before);

    const run = await rotateStoredSecrets(db, rotating, { dryRun: false });
    expect(run).toMatchObject({
      currentKeyId: keyB.ENCRYPTION_KEY_ID,
      undecryptable: [],
      remaining: 0,
    });
    expect(describeRotation(run).pop()).toMatch(/You can remove ENCRYPTION_KEY_PREVIOUS/);
    // Workflows started under the previous key still need it (Temporal payload codec)
    expect(describeRotation(run).pop()).toMatch(/no Temporal workflow started before the rotation/);
    // A schedule keeps its args as encoded when last written: the worker start re-encodes them.
    expect(describeRotation(run).pop()).toMatch(/logged every schedule "updated"/);

    // Step 4: ENCRYPTION_KEY_PREVIOUS removed.
    const after = await encryptionFromEnv(keyB);
    expect(await decryptAll(after)).toEqual(PLAINTEXT);
    expect(after.decrypt(writtenDuringRotation)).toBe('written-during-rotation');
    // Plain (non-secret) configs are left as they were.
    const csvNode = await db.collection('blueprintnodes').findOne({ nodeId: 'csv-hr' });
    expect(csvNode?.config).toEqual({ filePath: '/data/hr.csv' });

    // A second rotation, B to C, with the previous key's id.
    const keyC = generateKeySettings();
    const second = await encryptionFromEnv({
      ...keyC,
      ENCRYPTION_KEY_PREVIOUS: keyB.ENCRYPTION_KEY,
      ENCRYPTION_KEY_PREVIOUS_ID: keyB.ENCRYPTION_KEY_ID,
    });
    expect(await rotateStoredSecrets(db, second, { dryRun: false })).toMatchObject({
      remaining: 0,
    });
    expect(await decryptAll(await encryptionFromEnv(keyC))).toEqual(PLAINTEXT);
  });

  it('existing deployments without ENCRYPTION_KEY_ID keep decrypting what they stored', async () => {
    await storeSecrets(await encryptionFromEnv({ ENCRYPTION_KEY: KEY_A }));

    expect(await decryptAll(await encryptionFromEnv({ ENCRYPTION_KEY: KEY_A }))).toEqual(PLAINTEXT);
  });

  it('refuses ENCRYPTION_KEY_PREVIOUS without ENCRYPTION_KEY_ID, naming what to set', async () => {
    const { ENCRYPTION_KEY } = generateKeySettings();

    await expect(
      encryptionFromEnv({ ENCRYPTION_KEY, ENCRYPTION_KEY_PREVIOUS: KEY_A }),
    ).rejects.toThrow(/set ENCRYPTION_KEY_ID/);
  });

  it('refuses and writes nothing when the previous key id is missing (second rotation)', async () => {
    const keyB = generateKeySettings();
    await storeSecrets(await encryptionFromEnv(keyB));
    const before = await snapshotDb();
    const keyC = generateKeySettings();
    // ENCRYPTION_KEY_PREVIOUS_ID forgotten: the stored secrets name keyB's id.
    const rotating = await encryptionFromEnv({
      ...keyC,
      ENCRYPTION_KEY_PREVIOUS: keyB.ENCRYPTION_KEY,
    });

    const report = await rotateStoredSecrets(db, rotating, { dryRun: false });

    expect(report.undecryptable).toHaveLength(7);
    expect(await snapshotDb()).toEqual(before);
    expect(describeRotation(report).join('\n')).toContain(
      `ENCRYPTION_KEY_PREVIOUS_ID=${keyB.ENCRYPTION_KEY_ID}`,
    );
  });

  it('refuses and writes nothing when ENCRYPTION_KEY_PREVIOUS is not the key they were stored with', async () => {
    await storeSecrets(await encryptionFromEnv({ ENCRYPTION_KEY: KEY_A }));
    const before = await snapshotDb();
    const wrongPrevious = generateKeySettings().ENCRYPTION_KEY;
    const rotating = await encryptionFromEnv({
      ...generateKeySettings(),
      ENCRYPTION_KEY_PREVIOUS: wrongPrevious,
    });

    const report = await rotateStoredSecrets(db, rotating, { dryRun: false });

    expect(report.undecryptable).toHaveLength(8);
    expect(await snapshotDb()).toEqual(before);
    expect(describeRotation(report).join('\n')).toMatch(/Set ENCRYPTION_KEY_PREVIOUS/);
  });
});
