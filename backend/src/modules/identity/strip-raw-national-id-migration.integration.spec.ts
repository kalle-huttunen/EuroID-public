/**
 * Migration 20261125000000: identity correlation stored the national ID a hashedNationalId rule
 * reads as it came (sources[].rawData, the profile's customAttributes, a held conflict row), and
 * without CORRELATION_HMAC_SECRET hashed it with a fixed key from the source code (FOLLOWUPS
 * 2026-11-25). The migration removes the raw values and repairs the fallback-key hashes of tenants
 * with the rule (it refuses to run without the secret while one has it) and removes them for the
 * others, whose correlationId it never makes or changes otherwise. In-memory MongoDB.
 */
import { createHmac, randomBytes } from 'crypto';
import mongoose from 'mongoose';
import type { Db, Document } from 'mongodb';
import { connectTestDb, closeTestDb } from '@testing';
import { encryptionFromEnv } from '@infrastructure/secrets/key-rotation';
import { up, down } from '../../../migrations/20261125000000-strip-raw-national-id';

const SECRET = 'national-id-secret-for-tests-0123456789';
const RETIRED_KEY = 'fallback-tenant-key-do-not-use-in-prod';
const HETU = '131085-999X';
const HETU_OTHER_SPELLING = '131085999x';
/** Every raw value seeded below, as the document JSON (uppercased) must not contain them. */
const RAW_VALUES = ['131085', '010190', '020202', '030303', '040404', '050505', '060606'];

const normalize = (v: string) => v.trim().toUpperCase().replace(/[- ]/g, '');
/** The hash correlation makes now, computed here apart from the code under test. */
const realHash = (tenantId: string, value: string) =>
  createHmac('sha256', createHmac('sha256', SECRET).update(tenantId).digest())
    .update(normalize(value))
    .digest('hex');
/** The hash made before this release without a secret. */
const fallbackHash = (value: string) =>
  createHmac('sha256', Buffer.from(RETIRED_KEY, 'utf8')).update(normalize(value)).digest('hex');

/** Tenant A's Brain names `henkilotunnus` as the national ID field; tenant B has no canvas. */
const brainWithRule = {
  correlationConfig: {
    rules: [
      { strategy: 'hashedNationalId', nationalIdSourceField: 'henkilotunnus' },
      { strategy: 'email' },
    ],
  },
};

function identity(tenantId: string, email: string, extra: Document = {}): Document {
  const { profile, ...rest } = extra as { profile?: Document };
  return {
    tenantId,
    profile: { email, firstName: 'T', lastName: 'U', ...profile },
    sources: [],
    ...rest,
  };
}

describe('migration: strip raw national IDs', () => {
  let db: Db;
  const identities = () => db.collection('identities');
  const canvases = () => db.collection('canvasblueprints');
  const byEmail = async (email: string) =>
    (await identities().findOne({ 'profile.email': email }))!;
  const all = async () => identities().find({}).sort({ 'profile.email': 1 }).toArray();
  const original = {
    secret: process.env.CORRELATION_HMAC_SECRET,
    key: process.env.ENCRYPTION_KEY,
  };
  let log: jest.SpyInstance;
  let warn: jest.SpyInstance;

  const restoreEnv = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };

  beforeAll(async () => {
    await connectTestDb();
    db = mongoose.connection.db as unknown as Db;
  });

  beforeEach(async () => {
    log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await identities().deleteMany({});
    await canvases().deleteMany({});
    await canvases().insertOne({
      version: 'draft',
      tenantId: 'tenant-a',
      connectorConfigs: { 'euroid-core': brainWithRule },
    });
    await identities().insertMany([
      identity('tenant-a', 'ada@corp.example', {
        // The tenant's field in one source's customAttributes, hetu at the top of another's
        profile: {
          customAttributes: { henkilotunnus: HETU, site: 'HQ' },
          correlationId: fallbackHash(HETU),
        },
        // The profile values its access was applied with, custom attributes included
        accessBaseline: {
          attributes: {
            departmentName: 'R&D',
            customAttributes: { henkilotunnus: HETU, site: 'HQ' },
          },
          recordedBy: 'provisioning',
        },
        sources: [
          {
            sourceName: 'csv-hr',
            externalId: 'E-1',
            rawData: {
              email: 'ada@corp.example',
              customAttributes: { henkilotunnus: HETU, site: 'HQ' },
            },
          },
          {
            sourceName: 'json-api-hr',
            externalId: 'J-1',
            rawData: {
              email: 'ada@corp.example',
              employeeNumber: 'E-1',
              hetu: HETU_OTHER_SPELLING,
            },
          },
        ],
      }),
      identity('tenant-b', 'bob@corp.example', {
        // Tenant without a rule, identity soft-deleted: hetu removed, no hash made
        deletedAt: new Date('2026-11-01T10:00:00Z'),
        profile: { customAttributes: { hetu: '010190-123A' } },
        sources: [{ sourceName: 'csv-hr', externalId: 'B-1', rawData: { hetu: '010190-123A' } }],
      }),
      identity('tenant-a', 'cy@corp.example', { profile: { correlationId: 'unrelated-hash' } }),
      identity('tenant-a', 'dan@corp.example', {
        // Holds another person's row on a conflict: that value is removed and never hashed
        sources: [
          {
            sourceName: 'csv-hr',
            externalId: 'D-1',
            rawData: { customAttributes: { henkilotunnus: '030303-333C' } },
          },
        ],
        metadata: {
          conflictDetails: {
            matchedBy: 'email',
            incomingSource: {
              sourceName: 'json-api-hr',
              externalId: 'X-1',
              rawData: {
                email: 'dan@corp.example',
                customAttributes: { henkilotunnus: '020202-222B' },
              },
            },
          },
        },
      }),
      identity('tenant-a', 'eve@corp.example', {
        // Hashed with the secret earlier: that hash is right and stays
        profile: {
          customAttributes: { henkilotunnus: '040404-444D' },
          correlationId: realHash('tenant-a', '040404-444D'),
        },
      }),
    ]);
  });

  afterEach(() => {
    log.mockRestore();
    warn.mockRestore();
    restoreEnv('CORRELATION_HMAC_SECRET', original.secret);
    restoreEnv('ENCRYPTION_KEY', original.key);
  });

  afterAll(async () => {
    await identities().deleteMany({});
    await canvases().deleteMany({});
    await closeTestDb();
  });

  const expectNoRawValue = async () => {
    const json = JSON.stringify(await all()).toUpperCase();
    for (const value of RAW_VALUES) expect(json).not.toContain(value);
  };

  it('with the secret: recomputes the hashes, removes every raw value, and a second run changes nothing', async () => {
    process.env.CORRELATION_HMAC_SECRET = SECRET;

    await up(db);

    const ada = await byEmail('ada@corp.example');
    expect(ada.profile.correlationId).toBe(realHash('tenant-a', HETU));
    expect(ada.profile.customAttributes).toEqual({ site: 'HQ' });
    expect(ada.sources[0].rawData).toEqual({
      email: 'ada@corp.example',
      customAttributes: { site: 'HQ' },
    });
    expect(ada.sources[1].rawData).toEqual({ email: 'ada@corp.example', employeeNumber: 'E-1' });
    expect(ada.accessBaseline.attributes).toEqual({
      departmentName: 'R&D',
      customAttributes: { site: 'HQ' },
    });
    const bob = await byEmail('bob@corp.example');
    expect(bob.profile.correlationId).toBeUndefined();
    expect(bob.deletedAt).toEqual(new Date('2026-11-01T10:00:00Z'));
    expect((await byEmail('cy@corp.example')).profile.correlationId).toBe('unrelated-hash');
    const dan = await byEmail('dan@corp.example');
    expect(dan.profile.correlationId).toBe(realHash('tenant-a', '030303-333C'));
    expect(dan.metadata.conflictDetails.incomingSource.rawData).toEqual({
      email: 'dan@corp.example',
      customAttributes: {},
    });
    expect((await byEmail('eve@corp.example')).profile.correlationId).toBe(
      realHash('tenant-a', '040404-444D'),
    );
    await expectNoRawValue();

    const afterFirst = await all();
    await up(db);
    expect(await all()).toEqual(afterFirst);
  });

  // Without the secret the raw values would go, and with them the only way to rebuild the hashes
  // a Hashed National ID rule matches on: the run is refused before any write
  it.each([
    ['not set', undefined],
    ['shorter than 16 characters', 'short-secret'],
  ])(
    'with the secret %s while a tenant has the rule: fails before any change',
    async (_label, value) => {
      restoreEnv('CORRELATION_HMAC_SECRET', value);
      const before = await all();

      await expect(up(db)).rejects.toThrow(
        /CORRELATION_HMAC_SECRET .* tenant-a .* set it to the value the API uses, or remove the rule, then run the migration again\. No identity was changed/,
      );

      expect(await all()).toEqual(before);
    },
  );

  it('without the secret and no tenant with the rule: removes raw values and fallback-key hashes only', async () => {
    delete process.env.CORRELATION_HMAC_SECRET;
    await canvases().deleteMany({});
    await identities().deleteMany({});
    await identities().insertMany([
      identity('tenant-b', 'kai@corp.example', {
        profile: { customAttributes: { hetu: HETU }, correlationId: fallbackHash(HETU) },
      }),
      identity('tenant-b', 'liv@corp.example', {
        profile: { customAttributes: { hetu: '010190-123A' }, correlationId: 'source-supplied-id' },
      }),
    ]);

    await up(db);

    expect((await byEmail('kai@corp.example')).profile).not.toHaveProperty('correlationId');
    expect((await byEmail('liv@corp.example')).profile.correlationId).toBe('source-supplied-id');
    await expectNoRawValue();
    expect(log.mock.calls.flat().join(' ')).toMatch(/CORRELATION_HMAC_SECRET was not set/);
  });

  it('with the secret: never makes or changes a correlationId for a tenant without the rule', async () => {
    process.env.CORRELATION_HMAC_SECRET = SECRET;
    await identities().insertMany([
      // A correlationId that is no hash of its own values (a source-supplied id)
      identity('tenant-b', 'mia@corp.example', {
        profile: { customAttributes: { hetu: '010190-123A' }, correlationId: 'source-supplied-id' },
      }),
      // A fallback-key hash: reversible and no rule uses it, so it goes
      identity('tenant-b', 'ned@corp.example', {
        profile: { customAttributes: { hetu: HETU }, correlationId: fallbackHash(HETU) },
      }),
    ]);

    await up(db);

    expect((await byEmail('mia@corp.example')).profile.correlationId).toBe('source-supplied-id');
    expect((await byEmail('ned@corp.example')).profile).not.toHaveProperty('correlationId');
    expect((await byEmail('bob@corp.example')).profile).not.toHaveProperty('correlationId');
    await expectNoRawValue();
  });

  it('logs the rule fields it cannot name in a path, by name and count, never a value', async () => {
    process.env.CORRELATION_HMAC_SECRET = SECRET;
    await canvases().insertOne({
      version: 'draft',
      tenantId: 'tenant-d',
      connectorConfigs: {
        'euroid-core': {
          correlationConfig: {
            rules: [{ strategy: 'hashedNationalId', nationalIdSourceField: 'national.id' }],
          },
        },
      },
    });
    await identities().insertOne(
      identity('tenant-d', 'oli@corp.example', {
        profile: { customAttributes: { hetu: '131085-999X' } },
      }),
    );

    await up(db);

    const warnings = warn.mock.calls.flat().join('\n');
    expect(warnings).toContain('tenant tenant-d: 1 rule field');
    expect(warnings).toContain('"national.id"');
    expect(warnings).not.toContain('131085');
    // hetu is still removed for that tenant
    expect((await byEmail('oli@corp.example')).profile.customAttributes).toEqual({});
  });

  // A sync that reorders `sources` between the read and the write must not make the update by
  // array index hit another source: the update misses, and the identity is logged
  it('leaves an identity whose sources changed during the run as it is, and logs it', async () => {
    process.env.CORRELATION_HMAC_SECRET = SECRET;
    await identities().deleteMany({});
    await identities().insertOne(
      identity('tenant-a', 'pia@corp.example', {
        sources: [
          {
            sourceName: 'csv-hr',
            externalId: 'E-9',
            rawData: { customAttributes: { henkilotunnus: HETU } },
          },
          { sourceName: 'json-api-hr', externalId: 'J-9', rawData: { hetu: HETU } },
        ],
      }),
    );
    const pia = await byEmail('pia@corp.example');
    let raced = false;
    const racing = new Proxy(db, {
      get(target, prop) {
        if (prop !== 'collection') {
          const value = Reflect.get(target, prop);
          return typeof value === 'function' ? value.bind(target) : value;
        }
        return (name: string) => {
          const collection = target.collection(name);
          if (name !== 'identities') return collection;
          return new Proxy(collection, {
            get(c, p) {
              const value = Reflect.get(c, p);
              if (p !== 'updateOne') return typeof value === 'function' ? value.bind(c) : value;
              return async (...args: Parameters<typeof c.updateOne>) => {
                if (!raced) {
                  raced = true;
                  // Another write reorders the sources after the migration read them
                  await c.updateOne(
                    { _id: pia._id },
                    { $set: { sources: [...pia.sources].reverse() } },
                  );
                }
                return c.updateOne(...args);
              };
            },
          });
        };
      },
    });

    await up(racing as Db);

    const after = await byEmail('pia@corp.example');
    expect(after.sources.map((x: { sourceName: string }) => x.sourceName)).toEqual([
      'json-api-hr',
      'csv-hr',
    ]);
    expect(after.profile).not.toHaveProperty('correlationId');
    const warnings = warn.mock.calls.flat().join('\n');
    expect(warnings).toContain(String(pia._id));
    expect(warnings).toMatch(/changed while the migration ran/);
    expect(log.mock.calls.flat().join(' ')).toMatch(/1 identities changed while the migration ran/);
  });

  it('sets a hash two identities would share on neither, logs both ids, and goes on', async () => {
    process.env.CORRELATION_HMAC_SECRET = SECRET;
    await identities().deleteMany({});
    const custom = (value: string) => ({ customAttributes: { henkilotunnus: value } });
    await identities().insertMany([
      // One person twice: a fallback-key hash and no hash
      identity('tenant-a', 'fay@corp.example', {
        profile: { ...custom(HETU), correlationId: fallbackHash(HETU) },
      }),
      identity('tenant-a', 'gus@corp.example', { profile: custom(HETU_OTHER_SPELLING) }),
      // Its recomputed hash is already another identity's (one without raw values)
      identity('tenant-a', 'ivy@corp.example', {
        profile: { correlationId: realHash('tenant-a', '050505-555E') },
      }),
      identity('tenant-a', 'jon@corp.example', {
        profile: { ...custom('050505-555E'), correlationId: fallbackHash('050505-555E') },
      }),
      // Unaffected by either: recomputed as usual
      identity('tenant-a', 'hal@corp.example', {
        profile: { ...custom('060606-666F'), correlationId: fallbackHash('060606-666F') },
      }),
    ]);
    const id = async (email: string) => String((await byEmail(email))._id);

    await up(db);

    expect((await byEmail('fay@corp.example')).profile).toEqual({
      email: 'fay@corp.example',
      firstName: 'T',
      lastName: 'U',
      customAttributes: {},
    });
    expect((await byEmail('gus@corp.example')).profile).not.toHaveProperty('correlationId');
    expect((await byEmail('ivy@corp.example')).profile.correlationId).toBe(
      realHash('tenant-a', '050505-555E'),
    );
    expect((await byEmail('jon@corp.example')).profile).not.toHaveProperty('correlationId');
    expect((await byEmail('hal@corp.example')).profile.correlationId).toBe(
      realHash('tenant-a', '060606-666F'),
    );
    await expectNoRawValue();
    const warnings = warn.mock.calls.flat().join('\n');
    expect(warnings).toContain(`2 identities would share one correlationId`);
    for (const email of ['fay', 'gus', 'ivy', 'jon']) {
      expect(warnings).toContain(await id(`${email}@corp.example`));
    }
    expect(warnings).not.toContain(await id('hal@corp.example'));
    expect(log.mock.calls.flat().join(' ')).toMatch(
      /3 not given the recomputed one because another identity has the same national ID/,
    );
  });

  it('reads an encrypted Brain config with the encryption settings the API uses', async () => {
    const key = randomBytes(32).toString('base64');
    const encryption = await encryptionFromEnv({ ENCRYPTION_KEY: key });
    await canvases().insertOne({
      version: 'draft',
      tenantId: 'tenant-c',
      connectorConfigs: {
        'euroid-core': encryption.encrypt(
          JSON.stringify({
            correlationConfig: {
              rules: [{ strategy: 'hashedNationalId', nationalIdSourceField: 'sotu' }],
            },
          }),
        ),
      },
    });
    await identities().insertOne(
      identity('tenant-c', 'kim@corp.example', {
        profile: { customAttributes: { sotu: '131085-999X' } },
      }),
    );
    process.env.ENCRYPTION_KEY = key;
    process.env.CORRELATION_HMAC_SECRET = SECRET;

    await up(db);

    expect((await byEmail('kim@corp.example')).profile.customAttributes).toEqual({});
  });

  it('fails before any change when an encrypted Brain config cannot be read', async () => {
    const encryption = await encryptionFromEnv({
      ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    });
    await canvases().insertOne({
      version: 'draft',
      tenantId: 'tenant-c',
      connectorConfigs: { 'euroid-core': encryption.encrypt(JSON.stringify(brainWithRule)) },
    });
    await identities().insertOne(identity('tenant-c', 'kim@corp.example'));
    process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64'); // another key
    const before = await all();

    await expect(up(db)).rejects.toThrow(/tenant tenant-c.*No identity was changed/);

    expect(await all()).toEqual(before);
  });

  describe('bulk rollback snapshots', () => {
    const snapshots = () => db.collection('rollback_snapshots');
    let key: string;
    const seal = async (state: unknown) =>
      (await encryptionFromEnv({ ENCRYPTION_KEY: key })).encrypt(JSON.stringify(state));
    const open = async (doc: Document) =>
      JSON.parse((await encryptionFromEnv({ ENCRYPTION_KEY: key })).decrypt(doc.ciphertext));
    const byKind = async (kind: string, tenantId = 'tenant-a') =>
      (await snapshots().findOne({ kind, tenantId }))!;
    const raw = { henkilotunnus: HETU, hetu: '010190-123A', site: 'HQ' };

    beforeEach(async () => {
      key = randomBytes(32).toString('base64');
      process.env.ENCRYPTION_KEY = key;
      process.env.CORRELATION_HMAC_SECRET = SECRET;
      await snapshots().deleteMany({});
      await snapshots().insertMany([
        {
          tenantId: 'tenant-a',
          kind: 'hub-identity',
          key: 'run-1/op-1',
          ciphertext: await seal({
            existed: true,
            state: {
              id: 'x1',
              profile: {
                email: 'ada@corp.example',
                customAttributes: raw,
                correlationId: fallbackHash(HETU),
              },
              sources: [
                {
                  sourceName: 'csv-hr',
                  externalId: 'E-1',
                  rawData: { email: 'ada@corp.example', hetu: HETU, customAttributes: raw },
                },
              ],
              metadata: {
                version: 2,
                conflictDetails: {
                  matchedBy: 'email',
                  incomingSource: {
                    sourceName: 'json-api-hr',
                    rawData: { customAttributes: { henkilotunnus: '020202-222B' } },
                  },
                },
              },
              deletedAt: null,
              deletedBy: null,
            },
          }),
        },
        {
          tenantId: 'tenant-a',
          kind: 'hub-conflict-flags',
          key: 'run-1/op-2/conflict',
          ciphertext: await seal({
            id: 'x2',
            requiresReview: true,
            conflictDetails: {
              incomingSource: { sourceName: 'csv-hr', rawData: { hetu: '030303-333C' } },
            },
          }),
        },
        // A tenant with no identity left (the rollback removed it), no canvas: hetu only
        {
          tenantId: 'tenant-z',
          kind: 'hub-identity',
          ciphertext: await seal({
            existed: true,
            state: { id: 'z1', profile: { customAttributes: { hetu: '040404-444D' } } },
          }),
        },
        { tenantId: 'tenant-a', kind: 'hub-identity', ciphertext: await seal({ existed: false }) },
        // Not a Golden Record: left as it is
        {
          tenantId: 'tenant-a',
          kind: 'entra-state',
          ciphertext: await seal({ attributes: { jobTitle: 'Analyst' } }),
        },
      ]);
    });

    afterEach(async () => {
      await snapshots().deleteMany({});
    });

    it('removes the raw values from hub snapshots and a fixed-key correlationId, and a second run changes nothing', async () => {
      const untouched = await snapshots()
        .find({ $or: [{ kind: 'entra-state' }, { key: { $exists: false }, tenantId: 'tenant-a' }] })
        .toArray();

      await up(db);

      const hub = await open(await byKind('hub-identity'));
      expect(hub.state.profile).toEqual({
        email: 'ada@corp.example',
        customAttributes: { site: 'HQ' },
      });
      expect(hub.state.sources[0].rawData).toEqual({
        email: 'ada@corp.example',
        customAttributes: { site: 'HQ' },
      });
      expect(hub.state.metadata.conflictDetails.incomingSource.rawData).toEqual({});
      expect(hub.state.metadata.version).toBe(2);
      const flags = await open(await byKind('hub-conflict-flags'));
      expect(flags.conflictDetails.incomingSource.rawData).toEqual({});
      expect(flags.requiresReview).toBe(true);
      const z = await open(await byKind('hub-identity', 'tenant-z'));
      expect(z.state.profile).toEqual({});
      for (const doc of untouched) {
        expect((await snapshots().findOne({ _id: doc._id }))!.ciphertext).toBe(doc.ciphertext);
      }
      const opened = await Promise.all((await snapshots().find({}).toArray()).map(open));
      const json = JSON.stringify(opened).toUpperCase();
      for (const value of RAW_VALUES) expect(json).not.toContain(value);
      expect(log.mock.calls.flat().join(' ')).toMatch(/3 rollback snapshots/);

      const afterFirst = await snapshots().find({}).toArray();
      await up(db);
      expect(await snapshots().find({}).toArray()).toEqual(afterFirst);
    });

    it('fails before any change when a snapshot cannot be decrypted', async () => {
      const other = await encryptionFromEnv({ ENCRYPTION_KEY: randomBytes(32).toString('base64') });
      const { insertedId } = await snapshots().insertOne({
        tenantId: 'tenant-a',
        kind: 'hub-conflict-flags',
        ciphertext: other.encrypt(JSON.stringify({ id: 'x3' })),
      });
      const before = { identities: await all(), snapshots: await snapshots().find({}).toArray() };

      await expect(up(db)).rejects.toThrow(
        new RegExp(`1 rollback snapshot.*${String(insertedId)}.*No identity was changed`),
      );

      expect(await all()).toEqual(before.identities);
      expect(await snapshots().find({}).toArray()).toEqual(before.snapshots);
    });
  });

  it('runs on a database without identities', async () => {
    await identities().drop();

    await expect(up(db)).resolves.toBeUndefined();
  });

  it('down changes nothing: the raw values cannot be restored', async () => {
    process.env.CORRELATION_HMAC_SECRET = SECRET;
    await up(db);
    const migrated = await all();

    await down();

    expect(await all()).toEqual(migrated);
  });
});
