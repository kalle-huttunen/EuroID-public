/**
 * Migration 20261126000002: tenant settings stored with the wrong type before PATCH /tenants
 * validated them (`mfaRequired: "false"`) get their type. The console's edit form sends the stored
 * settings back, and the typed PATCH answered 400 for every edit of such a tenant. A value that
 * cannot be read as its type is removed (and logged), as a PATCH with null would.
 */
import { MongoClient } from 'mongodb';
import { closeTestDb, testDbName, testDbUri } from '@testing/test-db';
import { up, down } from '../../../migrations/20261126000002-tenant-settings-types';
import { UpdateTenantBodySchema } from './tenant.dtos';

describe('Migration: tenant settings get their types (MongoDB)', () => {
  let client: MongoClient;

  beforeAll(async () => {
    client = await MongoClient.connect(testDbUri());
  });

  afterAll(async () => {
    await client?.close();
    await closeTestDb();
  });

  async function legacyTenants(label: string) {
    const db = client.db(testDbName(label));
    await db.collection('tenants').insertMany([
      {
        tenantId: 'strings',
        name: 'Strings',
        settings: {
          mfaRequired: 'false',
          maxIdentities: '500',
          retentionDays: ' 90 ',
          allowedConnectors: 'entra-id, ad',
          features: { analytics: 'true', beta: 0 },
          custom: 'kept as it is',
        },
      },
      {
        tenantId: 'unreadable',
        name: 'Unreadable',
        settings: {
          mfaRequired: 'maybe',
          maxIdentities: 'lots',
          retentionDays: -5,
          allowedConnectors: [1, 'ad'],
          features: { analytics: 'perhaps', reports: true },
        },
      },
      {
        tenantId: 'typed',
        name: 'Typed',
        settings: { mfaRequired: true, maxIdentities: 100, allowedConnectors: ['scim'] },
      },
      { tenantId: 'none', name: 'No settings' },
    ]);
    return db;
  }

  const settingsOf = async (db: ReturnType<MongoClient['db']>, tenantId: string) =>
    (await db.collection('tenants').findOne({ tenantId }))?.settings;

  it('coerces readable values to their types and keeps unknown keys', async () => {
    const db = await legacyTenants('coerce');

    await up(db);

    expect(await settingsOf(db, 'strings')).toEqual({
      mfaRequired: false,
      maxIdentities: 500,
      retentionDays: 90,
      allowedConnectors: ['entra-id', 'ad'],
      features: { analytics: true, beta: false },
      custom: 'kept as it is',
    });
  });

  it('removes values that cannot be read as their type', async () => {
    const db = await legacyTenants('unset');

    await up(db);

    expect(await settingsOf(db, 'unreadable')).toEqual({ features: { reports: true } });
  });

  it('leaves typed settings and tenants without settings as they are; a rerun changes nothing', async () => {
    const db = await legacyTenants('rerun');
    await up(db);
    const after = await db.collection('tenants').find().sort({ tenantId: 1 }).toArray();

    await up(db);

    expect(await db.collection('tenants').find().sort({ tenantId: 1 }).toArray()).toEqual(after);
    expect(await settingsOf(db, 'typed')).toEqual({
      mfaRequired: true,
      maxIdentities: 100,
      allowedConnectors: ['scim'],
    });
    expect(await settingsOf(db, 'none')).toBeUndefined();
  });

  it('leaves settings the console can send back to PATCH /tenants/:id', async () => {
    const db = await legacyTenants('patch');

    await up(db);

    for (const tenant of await db.collection('tenants').find().toArray()) {
      const body = { name: tenant.name, settings: tenant.settings ?? {} };
      expect(UpdateTenantBodySchema.safeParse(body).success).toBe(true);
    }
  });

  it('down changes nothing (the old values are not kept)', async () => {
    const db = await legacyTenants('down');
    await up(db);
    const after = await db.collection('tenants').find().toArray();

    await down(db);

    expect(await db.collection('tenants').find().toArray()).toEqual(after);
  });
});
