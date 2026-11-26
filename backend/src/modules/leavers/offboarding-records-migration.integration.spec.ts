/**
 * Migration 20261122000002: the offboarding results leaver events kept move to
 * offboarding_records (one per workflow id), so the Failed offboardings tab and the removed
 * manually action, which now read only offboarding_records, still see offboardings that finished
 * before it. In-memory MongoDB.
 */
import { closeTestDb, testDbName, testDbUri } from '@testing/test-db';
import { MongoClient } from 'mongodb';
import {
  up,
  down,
} from '../../../migrations/20261122000002-offboarding-records-from-leaver-events';

const failedGithub = {
  status: 'partial-failure',
  hubStatus: 'suspended',
  systems: [
    { system: 'okta', outcome: 'deprovisioned', detail: 'deactivated' },
    { system: 'github', outcome: 'failed', reason: 'github: remove them in GitHub' },
  ],
  finishedAt: new Date('2026-11-22T10:00:00Z'),
};

function leaverEvent(tenantId: string, identityId: string, offboarding?: object, extra = {}) {
  return {
    tenantId,
    identityId,
    sourceName: 'csv-hr',
    reason: 'terminated',
    eventKey: `k-${identityId}-${Math.random()}`,
    status: 'started',
    open: false,
    detectedAt: new Date('2026-11-21T10:00:00Z'),
    workflowId: `t-${tenantId}-offboard-${identityId}`,
    ...(offboarding ? { offboarding } : {}),
    ...extra,
  };
}

describe('migration: offboarding records from leaver events', () => {
  let client: MongoClient;

  beforeAll(async () => {
    client = await MongoClient.connect(testDbUri());
  });

  afterAll(async () => {
    await client?.close();
    await closeTestDb();
  });

  it('copies each stored result to a record of its workflow and removes it from the event', async () => {
    const db = client.db(testDbName('copy'));
    await db
      .collection('leaver_events')
      .insertMany([
        leaverEvent('tenant-a', 'id-1', failedGithub),
        leaverEvent('tenant-b', 'id-2', { ...failedGithub, status: 'completed' }),
        leaverEvent('tenant-a', 'id-3'),
      ]);

    await up(db);
    await up(db);

    const records = await db.collection('offboarding_records').find({}).toArray();
    expect(records.map((r) => [r.tenantId, r.workflowId, r.identityId, r.status])).toEqual(
      expect.arrayContaining([
        ['tenant-a', 't-tenant-a-offboard-id-1', 'id-1', 'partial-failure'],
        ['tenant-b', 't-tenant-b-offboard-id-2', 'id-2', 'completed'],
      ]),
    );
    expect(records).toHaveLength(2);
    expect(records.find((r) => r.identityId === 'id-1')).toMatchObject({
      hubStatus: 'suspended',
      systems: failedGithub.systems,
      finishedAt: failedGithub.finishedAt,
    });
    expect(
      await db.collection('leaver_events').countDocuments({ offboarding: { $exists: true } }),
    ).toBe(0);
    // Finished for the HR mover; the event without a result still runs
    const finished = await db.collection('leaver_events').findOne({ identityId: 'id-1' });
    expect(finished?.offboardingFinishedAt).toEqual(failedGithub.finishedAt);
    const running = await db.collection('leaver_events').findOne({ identityId: 'id-3' });
    expect(running?.offboardingFinishedAt).toBeUndefined();
  });

  it('keeps the newest result when two leaver events share a workflow, and an existing record', async () => {
    const db = client.db(testDbName('newest'));
    const older = { ...failedGithub, finishedAt: new Date('2026-01-01T00:00:00Z') };
    await db
      .collection('leaver_events')
      .insertMany([
        leaverEvent('tenant-a', 'id-1', older),
        leaverEvent('tenant-a', 'id-1', { ...failedGithub, status: 'completed' }),
        leaverEvent('tenant-a', 'id-4', failedGithub),
      ]);
    await db.collection('offboarding_records').insertOne({
      tenantId: 'tenant-a',
      workflowId: 't-tenant-a-offboard-id-4',
      identityId: 'id-4',
      status: 'completed',
      hubStatus: 'deleted',
      systems: [],
      finishedAt: new Date('2026-11-23T00:00:00Z'),
    });

    await up(db);

    const byWorkflow = new Map(
      (await db.collection('offboarding_records').find({}).toArray()).map((r) => [
        r.workflowId,
        r.status,
      ]),
    );
    expect(byWorkflow.get('t-tenant-a-offboard-id-1')).toBe('completed');
    expect(byWorkflow.get('t-tenant-a-offboard-id-4')).toBe('completed');
  });

  it('down puts the results back on the started leaver events', async () => {
    const db = client.db(testDbName('down'));
    await db.collection('leaver_events').insertOne(leaverEvent('tenant-a', 'id-1', failedGithub));
    await up(db);

    await down(db);

    const event = await db.collection('leaver_events').findOne({ identityId: 'id-1' });
    expect(event?.offboarding).toEqual(failedGithub);
  });
});
