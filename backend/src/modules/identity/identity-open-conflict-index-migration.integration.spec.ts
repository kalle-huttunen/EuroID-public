/**
 * Migration 20261126000003: the partial index over the identities with an open correlation
 * conflict, which correlation reads before a mint (identity-email-case-conflict.ts), with the key
 * and options the schema declares. In-memory MongoDB.
 */
import mongoose from 'mongoose';
import type { Db } from 'mongodb';
import { connectTestDb, closeTestDb } from '@testing';
import { up, down } from '../../../migrations/20261126000003-identity-open-conflict-index';
import {
  EMAIL_CONFLICT_INDEX,
  EMAIL_CONFLICT_INDEX_KEY,
  EMAIL_CONFLICT_INDEX_OPTIONS,
  emailCaseConflictFilter,
} from './identity-email-case-conflict';

describe('migration: the open-conflict index on identities', () => {
  let db: Db;
  const identities = () => db.collection('identities');
  const indexOf = async () =>
    (await identities().indexes()).find((i) => i.name === EMAIL_CONFLICT_INDEX);

  beforeAll(async () => {
    await connectTestDb();
    db = mongoose.connection.db as unknown as Db;
  });

  beforeEach(async () => {
    const exists = await db.listCollections({ name: 'identities' }).hasNext();
    if (exists) await identities().drop();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('builds the index the schema declares, and is safe to rerun', async () => {
    await identities().insertOne({ tenantId: 't-1', profile: { email: 'a@x.test' } });

    await up(db);
    await up(db);

    const index = await indexOf();
    expect(index?.key).toEqual(EMAIL_CONFLICT_INDEX_KEY);
    expect(index?.partialFilterExpression).toEqual(
      EMAIL_CONFLICT_INDEX_OPTIONS.partialFilterExpression,
    );
    // The lookup before a mint reads that index, not every identity of the tenant
    const plan = JSON.stringify(
      await identities().find(emailCaseConflictFilter('t-1', 'a@x.test')).explain('queryPlanner'),
    );
    expect(plan).toContain(EMAIL_CONFLICT_INDEX);
    expect(plan).not.toContain('COLLSCAN');
  });

  it('drops the index on down, and down without it changes nothing', async () => {
    await up(db);
    await down(db);
    expect(await indexOf()).toBeUndefined();
    await expect(down(db)).resolves.toBeUndefined();
  });
});
