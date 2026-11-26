/**
 * Migration 20261126000000: reconciliation compared hub fields with account fields no lookup
 * returns, and the hub status with the literals ACTIVE and DISABLED (hunt 05 F1, r2-05 N1), so
 * every run left open FIELD_MISMATCH drifts on firstName, jobTitle and the like, and a CRITICAL
 * STATUS_MISMATCH for every leaver whose account was correctly disabled. The migration closes
 * those the new comparison would not raise, as a run closes a drift it no longer finds; real
 * drifts stay open for the next run to update. In-memory MongoDB.
 */
import mongoose from 'mongoose';
import type { Db } from 'mongodb';
import { connectTestDb, closeTestDb } from '@testing';
import { up, down } from '../../../migrations/20261126000000-close-false-positive-drifts';

const DETECTED = new Date('2026-11-20T02:00:00Z');

function drift(
  key: string,
  type: string,
  field: string | null,
  hubValue: string | null,
  targetValue: string | null,
  status = 'open',
) {
  return {
    tenantId: key.startsWith('b-') ? 'tenant-b' : 'tenant-a',
    userId: key,
    targetSystem: 'entra-id',
    type,
    field,
    hubValue,
    targetValue,
    severity: type === 'STATUS_MISMATCH' ? 'critical' : 'medium',
    status,
    detectedAt: DETECTED,
  };
}

describe('migration: close the drifts the old comparison raised falsely', () => {
  let db: Db;
  const drifts = () => db.collection('drift_records');
  /** Each drift's status, by userId. */
  const statuses = async () =>
    Object.fromEntries(
      (await drifts().find({}).toArray()).map((d) => [d.userId as string, d.status as string]),
    );

  beforeAll(async () => {
    await connectTestDb();
    db = mongoose.connection.db as unknown as Db;
  });

  beforeEach(async () => {
    await drifts().deleteMany({});
    await drifts().insertMany([
      // Fields no account lookup returns: never a real difference
      drift('first-name', 'FIELD_MISMATCH', 'firstName', 'Ada', ''),
      drift('b-job-title', 'FIELD_MISMATCH', 'jobTitle', 'Engineer', ''),
      drift('email', 'FIELD_MISMATCH', 'email', 'ada@corp.example', ''),
      drift('phone', 'FIELD_MISMATCH', 'mobilePhone', '+358 •• ••• 4567', ''),
      // A leaver, suspended or guest identity whose account is disabled, as expected
      drift('terminated', 'STATUS_MISMATCH', 'status', 'TERMINATED', 'DISABLED'),
      drift('b-suspended', 'STATUS_MISMATCH', 'status', 'SUSPENDED', 'DISABLED'),
      drift('inactive', 'STATUS_MISMATCH', 'status', 'INACTIVE', 'DISABLED'),
      drift('guest', 'STATUS_MISMATCH', 'status', 'GUEST', 'DISABLED'),
      // Real drifts: kept open for the next run
      drift('leaver-enabled', 'STATUS_MISMATCH', 'status', 'TERMINATED', 'ACTIVE'),
      drift('active-disabled', 'STATUS_MISMATCH', 'status', 'ACTIVE', 'DISABLED'),
      drift('pending-enabled', 'STATUS_MISMATCH', 'status', 'PENDING', 'ACTIVE'),
      drift('new-format', 'STATUS_MISMATCH', 'status', 'DISABLED', 'ENABLED'),
      drift('display-name', 'FIELD_MISMATCH', 'displayName', 'Ada L', 'Ada'),
      drift('missing', 'MISSING_USER', null, null, null),
      // Decided already: left as decided
      drift('ignored', 'FIELD_MISMATCH', 'jobTitle', 'Engineer', '', 'ignored'),
    ]);
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('closes the false positives as corrected, in every tenant, and nothing else', async () => {
    await up(db);

    expect(await statuses()).toEqual({
      'first-name': 'corrected',
      'b-job-title': 'corrected',
      email: 'corrected',
      phone: 'corrected',
      terminated: 'corrected',
      'b-suspended': 'corrected',
      inactive: 'corrected',
      guest: 'corrected',
      'leaver-enabled': 'open',
      'active-disabled': 'open',
      'pending-enabled': 'open',
      'new-format': 'open',
      'display-name': 'open',
      missing: 'open',
      ignored: 'ignored',
    });
    const closed = await drifts().findOne({ userId: 'terminated' });
    expect(closed?.correctedAt).toBeInstanceOf(Date);
  });

  it('is safe to run again', async () => {
    await up(db);
    const first = await drifts().findOne({ userId: 'first-name' });
    await up(db);

    expect(await drifts().findOne({ userId: 'first-name' })).toEqual(first);
  });

  it('down changes nothing', async () => {
    await up(db);
    const before = await statuses();
    await down();

    expect(await statuses()).toEqual(before);
  });
});
