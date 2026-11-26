/**
 * Migration 20261126000009 (final review CP3): ScimAuthGuard now requires the route's scope, and
 * before it read none. A stored token with no scope the guard knows gets the default four, so the
 * IdP's provisioning keeps working after the deploy; a token with a known scope keeps its own.
 */
import { MongoClient, ObjectId } from 'mongodb';
import { closeTestDb, testDbName, testDbUri } from '@testing/test-db';
import { SCIM_SCOPES } from './guards/scim-auth.guard';
import {
  up,
  DEFAULT_SCIM_SCOPES,
} from '../../../migrations/20261126000009-scim-token-default-scopes';

describe('Migration: default scopes for SCIM tokens with none the guard knows (MongoDB)', () => {
  let client: MongoClient;

  beforeAll(async () => {
    client = await MongoClient.connect(testDbUri());
  });

  afterAll(async () => {
    await client?.close();
    await closeTestDb();
  });

  it('uses the scopes the guard checks', () => {
    expect(DEFAULT_SCIM_SCOPES).toEqual([...SCIM_SCOPES]);
  });

  it('gives the default four to a token with none of them, keeps the others, also when run twice', async () => {
    const db = client.db(testDbName('scim-token-default-scopes'));
    const token = (key: string, tenantId: string, scopes?: unknown) => ({
      _id: new ObjectId(),
      key,
      tenantId,
      name: key,
      tokenHash: `hash-${key}`,
      ...(scopes === undefined ? {} : { scopes }),
    });
    await db
      .collection('scim_tokens')
      .insertMany([
        token('legacy-scim', 'a', ['scim']),
        token('legacy-lowercase', 'b', ['users:read', 'groups:write']),
        token('empty', 'a', []),
        token('missing', 'a'),
        token('null', 'a', null),
        token('read-only', 'a', ['Users:read']),
        token('mixed', 'a', ['Groups:write', 'scim']),
      ]);
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    await up(db);
    const firstLog = String(log.mock.calls[0][0]);
    await up(db);
    log.mockRestore();

    const scopes = Object.fromEntries(
      (await db.collection('scim_tokens').find({}).toArray()).map((t) => [t.key, t.scopes]),
    );
    const all = [...SCIM_SCOPES];
    expect(scopes).toEqual({
      'legacy-scim': all,
      'legacy-lowercase': all,
      empty: all,
      missing: all,
      null: all,
      'read-only': ['Users:read'],
      mixed: ['Groups:write', 'scim'],
    });
    expect(firstLog).toContain('5 token(s)');
  });
});
