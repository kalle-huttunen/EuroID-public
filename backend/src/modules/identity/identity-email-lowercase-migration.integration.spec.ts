/**
 * Migration 20261125000003 (hunt 2026-11-25 r2-02 N1): stored identity emails are lower-cased,
 * except where two live identities of a tenant hold one address in different cases; those are
 * left as they are and raised as a correlation conflict for a merge. In-memory MongoDB.
 */
import mongoose from 'mongoose';
import type { Db, ObjectId } from 'mongodb';
import { connectTestDb, closeTestDb } from '@testing';
import { up, down } from '../../../migrations/20261125000003-identity-email-lowercase';

const DELETED_AT = new Date('2026-11-01T10:00:00Z');

function identity(
  tenantId: string,
  email: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    tenantId,
    profile: { email, firstName: 'Test', lastName: email.split('@')[0], sourceSystem: 'csv-hr' },
    sources: [{ sourceName: 'csv-hr', externalId: email }],
    metadata: { version: 1, correlationStatus: 'correlated' },
    ...extra,
  };
}

describe('migration: identity emails are lower-cased', () => {
  let db: Db;
  const identities = () => db.collection('identities');
  const emailOf = async (id: ObjectId) => (await identities().findOne({ _id: id }))?.profile.email;
  const metadataOf = async (id: ObjectId) => (await identities().findOne({ _id: id }))?.metadata;
  let logs: jest.SpyInstance;

  beforeAll(async () => {
    await connectTestDb();
    db = mongoose.connection.db as unknown as Db;
  });

  beforeEach(async () => {
    await identities().deleteMany({});
    logs = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => logs.mockRestore());

  afterAll(async () => {
    await identities().deleteMany({});
    await closeTestDb();
  });

  it('lower-cases a live email no other live identity has in another case, per tenant', async () => {
    const { insertedIds } = await identities().insertMany([
      identity('tenant-a', ' Ada@Corp.Example'),
      identity('tenant-a', 'bob@corp.example'),
      // The same address in another tenant is another person
      identity('tenant-b', 'ADA@corp.example'),
    ]);

    await up(db);

    expect(await emailOf(insertedIds[0])).toBe('ada@corp.example');
    expect(await emailOf(insertedIds[1])).toBe('bob@corp.example');
    expect(await emailOf(insertedIds[2])).toBe('ada@corp.example');
    expect(await metadataOf(insertedIds[0])).not.toHaveProperty('requiresReview');
  });

  it('lower-cases a deleted identity even when a live one has the address', async () => {
    const { insertedIds } = await identities().insertMany([
      identity('tenant-a', 'ada@corp.example'),
      identity('tenant-a', 'Ada@Corp.Example', { deletedAt: DELETED_AT }),
    ]);

    await up(db);

    expect(await emailOf(insertedIds[1])).toBe('ada@corp.example');
    expect(await metadataOf(insertedIds[0])).not.toHaveProperty('requiresReview');
  });

  it('changes no email of two live identities with one address and raises them for a merge', async () => {
    const { insertedIds } = await identities().insertMany([
      identity('tenant-a', 'Ada@corp.example'),
      identity('tenant-a', 'ADA@corp.example'),
    ]);

    await up(db);

    expect(await emailOf(insertedIds[0])).toBe('Ada@corp.example');
    expect(await emailOf(insertedIds[1])).toBe('ADA@corp.example');
    expect(await metadataOf(insertedIds[0])).toMatchObject({
      correlationConflict: true,
      requiresReview: true,
      conflictDetails: {
        matchedBy: 'email',
        confidence: 0,
        incomingIdentityId: String(insertedIds[1]),
        existingSnapshot: { email: 'Ada@corp.example' },
        incomingSnapshot: { email: 'ADA@corp.example' },
      },
    });
    expect(await metadataOf(insertedIds[1])).not.toHaveProperty('requiresReview');
    const logged = logs.mock.calls.map(([line]) => String(line)).join('\n');
    expect(logged).toContain(String(insertedIds[0]));
    expect(logged).toContain(String(insertedIds[1]));
    expect(logged).not.toMatch(/ada@corp/i); // ids only, no address in the log
  });

  it('keeps an open conflict and raises the pair on the other identity', async () => {
    const openConflict = {
      correlationConflict: true,
      requiresReview: true,
      conflictDetails: { matchedBy: 'employeeNumber', confidence: 0.9, incomingIdentityId: 'x' },
    };
    const { insertedIds } = await identities().insertMany([
      identity('tenant-a', 'ada@corp.example', { metadata: { version: 1, ...openConflict } }),
      identity('tenant-a', 'Ada@corp.example'),
    ]);

    await up(db);

    expect((await metadataOf(insertedIds[0]))?.conflictDetails).toEqual(
      openConflict.conflictDetails,
    );
    expect((await metadataOf(insertedIds[1]))?.conflictDetails).toMatchObject({
      matchedBy: 'email',
      incomingIdentityId: String(insertedIds[0]),
    });
  });

  it('raises no group again on a rerun and changes nothing more', async () => {
    const { insertedIds } = await identities().insertMany([
      identity('tenant-a', 'Ada@corp.example'),
      identity('tenant-a', 'ADA@corp.example'),
      identity('tenant-a', 'Bob@corp.example'),
    ]);

    await up(db);
    const after = await identities().find({}).sort({ _id: 1 }).toArray();
    await up(db);

    expect(await identities().find({}).sort({ _id: 1 }).toArray()).toEqual(after);
    expect(await metadataOf(insertedIds[1])).not.toHaveProperty('requiresReview');
  });

  it('down changes nothing', async () => {
    await identities().insertOne(identity('tenant-a', 'ada@corp.example'));
    const before = await identities().find({}).toArray();

    await down();

    expect(await identities().find({}).toArray()).toEqual(before);
  });
});
