/**
 * Legacy Merkle checkpoints on in-memory MongoDB with the real AuditService, AuditMerkleService
 * and AuditArchiveService.
 *
 * Before: checkpoints covered chained events only (`seq`), so the audit events written before
 * hash version 2 were in no checkpoint, and the daily audit archive, which exports checkpointed
 * events to WORM storage, never exported them.
 *
 * Proves: the daily run checkpoints a tenant's events without a chain position once, by their
 * stored hashes in (timestamp, _id) order, marked legacy, and a second run makes no second one;
 * more events than a checkpoint holds go into numbered parts, whole milliseconds each, and a run
 * that stopped continues after the last part; two runs at once make one part; the checkpoint
 * check and the event proof handle a legacy checkpoint and say what it proves; the daily run's
 * activities export its events, outside any request as in the worker (the export ran without a
 * tenant context and the tenant plugin refused its first read).
 */
import mongoose, { Model } from 'mongoose';
import { gunzipSync } from 'zlib';
import { createHash } from 'crypto';
import { BadRequestException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import type { StorageAdapter } from '@infrastructure/retention/storage/storage.interface';
import type { TenantService } from '@infrastructure/multi-tenancy/tenant.service';
import { AuditArchiveActivities } from '../../activities/audit-archive.activities';
import { connectTestDb, clearTestDb, closeTestDb } from '@testing';
import { AuditService, type LogAuditEvent } from './audit.service';
import { AuditMerkleService } from './audit-merkle.service';
import { AuditAnchorService } from './audit-anchor.service';
import { AuditArchiveService } from './audit-archive.service';
import {
  AuditEvent,
  AuditEventSchema,
  type AuditEventDocument,
} from './schemas/audit-event.schema';
import {
  AuditChainHead,
  AuditChainHeadSchema,
  type AuditChainHeadDocument,
} from './schemas/audit-chain-head.schema';
import {
  AuditMerkleRoot,
  AuditMerkleRootSchema,
  type AuditMerkleRootDocument,
} from './schemas/audit-merkle-root.schema';

mongoose.plugin(tenantPlugin);

const TENANT = 'tenant-a';
const OTHER = 'tenant-b';

const event = (n: number, tenantId = TENANT): LogAuditEvent => ({
  action: 'CONFIG_CHANGED',
  actor: 'admin@corp.example',
  resourceType: 'config',
  resourceId: `cfg-${n}`,
  resourceName: `Config ${n}`,
  description: `Change ${n}`,
  payload: { metadata: { n } },
  tenantId,
});

/** The hash rule events were written with before hash version 2 (version 1 of audit-hash.ts). */
function oldHash(stored: Record<string, unknown>): string {
  const exclude = new Set([
    '_id',
    '__v',
    'integrityHash',
    'previousHash',
    'createdAt',
    'updatedAt',
  ]);
  const canonical: Record<string, unknown> = {};
  for (const key of Object.keys(stored).sort()) {
    if (!exclude.has(key)) canonical[key] = stored[key];
  }
  return createHash('sha256')
    .update(stored.previousHash + JSON.stringify(canonical, Object.keys(canonical).sort()))
    .digest('hex');
}

describe('Legacy audit Merkle checkpoints (in-memory MongoDB)', () => {
  let events: Model<AuditEventDocument>;
  let roots: Model<AuditMerkleRootDocument>;
  let audit: AuditService;
  let merkle: AuditMerkleService;

  /** Events as the writers before hash version 2 stored them (no seq, no hashVersion). */
  async function insertOldEvents(
    rows: Array<{ n: number; at: string; tenantId?: string }>,
  ): Promise<Array<{ id: string; hash: string }>> {
    const stored: Array<{ id: string; hash: string }> = [];
    for (const row of rows) {
      const timestamp = new Date(row.at);
      const doc: Record<string, unknown> = {
        ...event(row.n, row.tenantId),
        severity: 'info',
        timestamp,
        previousHash: 'f'.repeat(64),
      };
      doc.integrityHash = oldHash(doc);
      const { insertedId } = await events.collection.insertOne({
        ...doc,
        createdAt: timestamp,
        updatedAt: timestamp,
        __v: 0,
      });
      stored.push({ id: String(insertedId), hash: doc.integrityHash as string });
    }
    return stored;
  }

  const legacyParts = () =>
    roots.find({ tenantId: TENANT, legacy: true }).sort({ legacyPart: 1 }).lean().exec();

  const write = async (from: number, to: number) => {
    for (let n = from; n <= to; n++) await audit.log(event(n));
  };

  beforeAll(async () => {
    await connectTestDb();
    events = mongoose.model(
      AuditEvent.name,
      AuditEventSchema,
    ) as unknown as Model<AuditEventDocument>;
    const heads = mongoose.model(
      AuditChainHead.name,
      AuditChainHeadSchema,
    ) as unknown as Model<AuditChainHeadDocument>;
    roots = mongoose.model(
      AuditMerkleRoot.name,
      AuditMerkleRootSchema,
    ) as unknown as Model<AuditMerkleRootDocument>;
    await Promise.all([events.init(), heads.init(), roots.init()]);
    audit = new AuditService(events, heads);
    // No anchor key: checkpoints are not signed
    const anchor = new AuditAnchorService({ get: () => undefined } as unknown as ConfigService);
    merkle = new AuditMerkleService(roots, events, anchor);
  });
  afterEach(clearTestDb);
  afterAll(closeTestDb);

  it('checkpoints the events without a chain position once, by stored hash in time order', async () => {
    // Inserted out of order; two in the same millisecond are ordered by _id
    const [b, a, c, d] = await insertOldEvents([
      { n: 2, at: '2026-06-02T10:00:00.000Z' },
      { n: 1, at: '2026-06-01T10:00:00.000Z' },
      { n: 3, at: '2026-06-03T10:00:00.000Z' },
      { n: 4, at: '2026-06-03T10:00:00.000Z' },
    ]);
    await insertOldEvents([{ n: 9, at: '2026-06-01T11:00:00.000Z', tenantId: OTHER }]);
    await write(5, 6);

    await expect(merkle.createPendingCheckpoints(TENANT)).resolves.toBe(2);

    const [legacy] = await legacyParts();
    expect(legacy).toMatchObject({
      legacy: true,
      legacyPart: 1,
      eventCount: 4,
      eventHashes: [a.hash, b.hash, c.hash, d.hash],
      firstEventTimestamp: new Date('2026-06-01T10:00:00.000Z'),
      lastEventTimestamp: new Date('2026-06-03T10:00:00.000Z'),
    });
    expect(legacy.firstSeq).toBeUndefined();
    expect(legacy.lastSeq).toBeUndefined();
    // The chained events are in their own checkpoint, as before
    const chained = await roots.findOne({ tenantId: TENANT, firstSeq: 1 }).lean().exec();
    expect(chained).toMatchObject({ lastSeq: 2, eventCount: 2 });
    expect(chained?.legacy).toBeUndefined();

    // Once: a second run makes no second legacy checkpoint
    await expect(merkle.createPendingCheckpoints(TENANT)).resolves.toBe(0);
    expect(await legacyParts()).toHaveLength(1);
  });

  it('leaves the legacy events to the daily run: Create checkpoint covers chained events only', async () => {
    await insertOldEvents([{ n: 1, at: '2026-06-01T10:00:00.000Z' }]);

    await expect(merkle.createCheckpoint(TENANT)).rejects.toThrow(BadRequestException);
    expect(await roots.countDocuments({ tenantId: TENANT })).toBe(0);
  });

  it('two runs at the same moment make one legacy checkpoint', async () => {
    await insertOldEvents([
      { n: 1, at: '2026-06-01T10:00:00.000Z' },
      { n: 2, at: '2026-06-02T10:00:00.000Z' },
    ]);

    await Promise.allSettled([
      merkle.createPendingCheckpoints(TENANT),
      merkle.createPendingCheckpoints(TENANT),
    ]);

    expect((await legacyParts()).map((p) => [p.legacyPart, p.eventCount])).toEqual([[1, 2]]);
  });

  it('checks a legacy checkpoint against its events and says what it proves', async () => {
    const old = await insertOldEvents([
      { n: 1, at: '2026-06-01T10:00:00.000Z' },
      { n: 2, at: '2026-06-02T10:00:00.000Z' },
    ]);
    await write(3, 3);
    await merkle.createPendingCheckpoints(TENANT);

    const intact = await merkle.verifyRange(TENANT);
    expect(intact).toMatchObject({
      valid: true,
      checkpointsVerified: 2,
      eventsVerified: 3,
      eventsMissing: 0,
      legacyCheckpointsChecked: 1,
    });
    expect(intact.legacyNote).toMatch(/have not changed since it was made/);
    expect(intact.legacyNote).toMatch(/does not cover the payload/);

    // What the legacy hash cannot see: a changed payload
    await events.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(old[1].id) },
      { $set: { 'payload.metadata.n': 99 } },
    );
    await expect(merkle.verifyRange(TENANT)).resolves.toMatchObject({ valid: true });

    // What it can: a field the legacy hash covers
    await events.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(old[1].id) },
      { $set: { description: 'Nothing happened' } },
    );
    const legacy = (await legacyParts())[0];
    await expect(merkle.verifyRange(TENANT)).resolves.toMatchObject({
      valid: false,
      firstInvalidCheckpoint: legacy.checkpointId,
      reason: 'event_changed',
      invalidEventId: old[1].id,
      legacyCheckpointsChecked: 1,
    });
  });

  it('proves an old event through the legacy checkpoint and says so; a chained one is not legacy', async () => {
    const [old] = await insertOldEvents([{ n: 1, at: '2026-06-01T10:00:00.000Z' }]);
    await write(2, 2);
    await merkle.createPendingCheckpoints(TENANT);
    const legacy = (await legacyParts())[0];
    const chainedEvent = await events.findOne({ tenantId: TENANT, seq: 1 }).lean().exec();

    // As the route runs it: in the caller's request context
    const verify = (id: string) => withTenantContext(TENANT, () => merkle.verifyEvent(TENANT, id));
    const proof = await verify(old.id);
    expect(proof).toMatchObject({
      valid: true,
      checkpointId: legacy.checkpointId,
      rootHash: legacy.rootHash,
      legacy: true,
    });
    expect(proof.legacyNote).toMatch(/does not cover the payload/);

    const chainedProof = await verify(String(chainedEvent!._id));
    expect(chainedProof).toMatchObject({ valid: true, legacy: false });
    expect(chainedProof.legacyNote).toBeUndefined();
  });

  it('the daily run exports the events of a legacy checkpoint, marked legacy', async () => {
    const old = await insertOldEvents([
      { n: 1, at: '2026-06-01T10:00:00.000Z' },
      { n: 2, at: '2026-06-02T10:00:00.000Z' },
    ]);
    const uploads: Buffer[] = [];
    const storage: StorageAdapter = {
      upload: async (buffer, path) => {
        uploads.push(buffer);
        return `mem://${path}`;
      },
    };
    const archive = new AuditArchiveService(roots, events, storage);
    const tenants = { findAll: async () => [{ tenantId: TENANT }] } as unknown as TenantService;
    const activities = new AuditArchiveActivities(archive, tenants, merkle);

    // The first run makes the checkpoint; a later one archives it once it is 24 hours old
    await expect(activities.getUnarchivedCheckpoints('')).resolves.toEqual([]);
    const [legacy] = await legacyParts();
    await roots.collection.updateOne(
      { _id: legacy._id },
      { $set: { createdAt: new Date(Date.now() - 25 * 3600_000) } },
    );
    const due = await activities.getUnarchivedCheckpoints('');
    expect(due).toEqual([
      { _id: String(legacy._id), checkpointId: legacy.checkpointId, tenantId: TENANT },
    ]);
    const exported = await activities.exportCheckpoint(due[0].tenantId, due[0]._id);

    expect(exported.eventCount).toBe(2);
    expect(await legacyParts()).toHaveLength(1);
    const body = JSON.parse(gunzipSync(uploads[0]).toString('utf8'));
    expect(body).toMatchObject({ checkpointId: legacy.checkpointId, legacy: true, legacyPart: 1 });
    expect(body.events.map((e: { integrityHash: string }) => e.integrityHash)).toEqual(
      old.map((e) => e.hash),
    );
    expect(
      (await roots.findOne({ tenantId: TENANT, _id: legacy._id }).lean().exec())?.archived,
    ).toBe(true);
  });

  describe('with more legacy events than a checkpoint holds (AUDIT_CHECKPOINT_MAX_EVENTS=2)', () => {
    let small: AuditMerkleService;

    beforeAll(() => {
      // The limits are read when the module loads: load a copy under small limits, one
      // checkpoint per run, so a run stops after each part
      const limits = { AUDIT_CHECKPOINT_MAX_EVENTS: '2', AUDIT_CHECKPOINT_MAX_PER_RUN: '1' };
      const saved = Object.keys(limits).map((key) => [key, process.env[key]] as const);
      Object.assign(process.env, limits);
      jest.isolateModules(() => {
        const { AuditMerkleService: Isolated } =
          jest.requireActual<typeof import('./audit-merkle.service')>('./audit-merkle.service');
        const anchor = new AuditAnchorService({ get: () => undefined } as unknown as ConfigService);
        small = new Isolated(roots, events, anchor);
      });
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });

    it('makes numbered parts of whole milliseconds, each run continuing after the last part', async () => {
      const old = await insertOldEvents([
        { n: 1, at: '2026-06-01T10:00:00.000Z' },
        { n: 2, at: '2026-06-02T10:00:00.000Z' },
        // Three in one millisecond: the part they would be cut in ends before them
        { n: 3, at: '2026-06-03T10:00:00.000Z' },
        { n: 4, at: '2026-06-03T10:00:00.000Z' },
        { n: 5, at: '2026-06-03T10:00:00.000Z' },
        { n: 6, at: '2026-06-04T10:00:00.000Z' },
      ]);

      for (let run = 0; run < 5; run++) await small.createPendingCheckpoints(TENANT);

      const parts = await legacyParts();
      expect(parts.map((p) => [p.legacyPart, p.eventCount])).toEqual([
        [1, 2],
        // More events in one millisecond than a part holds: they stay together
        [2, 3],
        [3, 1],
      ]);
      expect(parts.flatMap((p) => p.eventHashes)).toEqual(old.map((e) => e.hash));
      expect(parts[1].previousRootHash).toBe(parts[0].rootHash);
      await expect(small.createPendingCheckpoints(TENANT)).resolves.toBe(0);
    });
  });
});
