/**
 * Migration 20261124000000: provisioning entries deprovisioned before the final sweep of
 * 2026-11-23 kept `writebackComplete: true`, so re-provisioning such a target wrote no new account
 * id back and Okta, SCIM, AD and Entra ID kept the removed account's id for the mover and
 * offboarding. A deprovision now undoes the writeback (IdentityProvisioningService); the
 * migration does the same for the entries deprovisioned before. In-memory MongoDB.
 */
import mongoose from 'mongoose';
import type { Db } from 'mongodb';
import { connectTestDb, closeTestDb } from '@testing';
import { up, down } from '../../../migrations/20261124000000-deprovisioned-writeback-incomplete';

const LAST_SYNC = new Date('2026-10-01T10:00:00Z');

function entry(targetSystem: string, status: string, writebackComplete?: boolean) {
  return {
    targetSystem,
    status,
    lastSync: LAST_SYNC,
    ...(writebackComplete !== undefined ? { writebackComplete } : {}),
  };
}

describe('migration: DEPROVISIONED provisioning entries have no completed writeback', () => {
  let db: Db;
  const identities = () => db.collection('identities');
  /** Each identity's entries as `targetSystem:status:writebackComplete`, by email. */
  const stored = async () =>
    Object.fromEntries(
      (await identities().find({}).sort({ 'profile.email': 1 }).toArray()).map((doc) => [
        doc.profile.email,
        (doc.provisioning as Array<Record<string, unknown>>).map(
          (p) => `${p.targetSystem}:${p.status}:${p.writebackComplete}`,
        ),
      ]),
    );

  beforeAll(async () => {
    await connectTestDb();
    db = mongoose.connection.db as unknown as Db;
  });

  beforeEach(async () => {
    await identities().deleteMany({});
    await identities().insertMany([
      {
        tenantId: 'tenant-a',
        profile: { email: 'ada@corp.example' },
        provisioning: [
          entry('okta', 'DEPROVISIONED', true),
          entry('entra-id', 'SYNCED', true),
          entry('scim', 'DEPROVISIONED', false),
        ],
      },
      {
        // Another tenant, and an identity offboarding deleted
        tenantId: 'tenant-b',
        profile: { email: 'bob@corp.example' },
        deletedAt: new Date('2026-11-01T10:00:00Z'),
        provisioning: [entry('ad', 'DEPROVISIONED', true), entry('entra-id', 'DEPROVISIONED')],
      },
      {
        tenantId: 'tenant-a',
        profile: { email: 'cy@corp.example' },
        provisioning: [entry('okta', 'ERROR', true), entry('github', 'PENDING')],
      },
    ]);
  });

  afterAll(async () => {
    await identities().deleteMany({});
    await closeTestDb();
  });

  it('undoes the writeback of every DEPROVISIONED entry and changes nothing else', async () => {
    await up(db);
    await up(db);

    expect(await stored()).toEqual({
      'ada@corp.example': [
        'okta:DEPROVISIONED:false',
        'entra-id:SYNCED:true',
        'scim:DEPROVISIONED:false',
      ],
      'bob@corp.example': ['ad:DEPROVISIONED:false', 'entra-id:DEPROVISIONED:undefined'],
      'cy@corp.example': ['okta:ERROR:true', 'github:PENDING:undefined'],
    });
    // The rest of an entry stays as it was
    const ada = await identities().findOne({ 'profile.email': 'ada@corp.example' });
    expect(ada?.provisioning[0]).toEqual(entry('okta', 'DEPROVISIONED', false));
  });

  it('runs on a database without identities', async () => {
    await identities().drop();

    await expect(up(db)).resolves.toBeUndefined();
  });

  it('down changes nothing: the earlier flags are not recorded', async () => {
    await up(db);
    const migrated = await stored();

    await down();

    expect(await stored()).toEqual(migrated);
  });
});
