/**
 * Merkle checkpoints on in-memory MongoDB with the real AuditService and AuditMerkleService.
 *
 * Before: nothing created a checkpoint (createCheckpoint had no caller and would have put every
 * event of the log in one document), and POST /audit/verify answered valid after comparing each
 * checkpoint's stored root with its own stored leaves, without reading a single event.
 *
 * Proves: a checkpoint covers the chained events after the previous one, in chain order, and the
 * next one starts where it ended; two made at the same moment cannot cover the same events; the
 * range check re-hashes the covered events, names a changed event or a changed checkpoint, and
 * counts the events that left the log without judging them.
 */
import mongoose, { Model } from 'mongoose';
import { BadRequestException, ConflictException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import { connectTestDb, clearTestDb, closeTestDb } from '@testing';
import { AuditService, type LogAuditEvent } from './audit.service';
import { AuditMerkleService } from './audit-merkle.service';
import { AuditAnchorService } from './audit-anchor.service';
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

const event = (n: number): LogAuditEvent => ({
  action: 'CONFIG_CHANGED',
  actor: 'admin@corp.example',
  resourceType: 'config',
  resourceId: `cfg-${n}`,
  resourceName: `Config ${n}`,
  description: `Change ${n}`,
  payload: { metadata: { n } },
  tenantId: TENANT,
});

describe('Audit Merkle checkpoints (in-memory MongoDB)', () => {
  let events: Model<AuditEventDocument>;
  let roots: Model<AuditMerkleRootDocument>;
  let audit: AuditService;
  let merkle: AuditMerkleService;

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

  describe('createCheckpoint', () => {
    it('covers the chained events after the previous checkpoint, in chain order', async () => {
      await write(1, 3);
      const first = await merkle.createCheckpoint(TENANT);
      await write(4, 5);
      const second = await merkle.createCheckpoint(TENANT);

      const stored = await events.find({ tenantId: TENANT }).sort({ seq: 1 }).lean().exec();
      expect(first).toMatchObject({ firstSeq: 1, lastSeq: 3, eventCount: 3 });
      expect(first.eventHashes).toEqual(stored.slice(0, 3).map((e) => e.integrityHash));
      expect(second).toMatchObject({
        firstSeq: 4,
        lastSeq: 5,
        eventCount: 2,
        previousRootHash: first.rootHash,
      });
      expect(second.lastEventTimestamp).toEqual(stored[4].timestamp);
    });

    it('answers 400 when no event follows the last checkpoint', async () => {
      await write(1, 2);
      await merkle.createCheckpoint(TENANT);

      await expect(merkle.createCheckpoint(TENANT)).rejects.toThrow(BadRequestException);
    });

    it('two made at the same moment cannot cover the same events', async () => {
      await write(1, 3);

      const outcomes = await Promise.allSettled([
        merkle.createCheckpoint(TENANT),
        merkle.createCheckpoint(TENANT),
      ]);

      const made = outcomes.filter((o) => o.status === 'fulfilled');
      const refused = outcomes.filter((o) => o.status === 'rejected') as PromiseRejectedResult[];
      expect(made).toHaveLength(1);
      // Overlapping: 409 from the unique index; or the second came after the first: 400
      expect(refused[0].reason).toBeInstanceOf(
        refused[0].reason instanceof ConflictException ? ConflictException : BadRequestException,
      );
      expect(await roots.countDocuments({ tenantId: TENANT })).toBe(1);
    });

    it('the daily run makes checkpoints until every chained event is in one', async () => {
      await write(1, 4);

      await expect(merkle.createPendingCheckpoints(TENANT)).resolves.toBe(1);
      await expect(merkle.createPendingCheckpoints(TENANT)).resolves.toBe(0);
      await write(5, 5);
      await expect(merkle.createPendingCheckpoints(TENANT)).resolves.toBe(1);
      expect(
        (await roots.find({ tenantId: TENANT }).sort({ firstSeq: 1 }).lean()).map((r) => [
          r.firstSeq,
          r.lastSeq,
        ]),
      ).toEqual([
        [1, 4],
        [5, 5],
      ]);
    });
  });

  describe('verifyRange', () => {
    it('re-hashes every covered event against its checkpoint leaf', async () => {
      await write(1, 3);
      await merkle.createCheckpoint(TENANT);
      await write(4, 5);
      await merkle.createCheckpoint(TENANT);

      await expect(merkle.verifyRange(TENANT)).resolves.toEqual({
        valid: true,
        checkpointsVerified: 2,
        eventsVerified: 5,
        eventsMissing: 0,
        legacyCheckpointsChecked: 0,
      });
    });

    it('names a covered event that was changed after the checkpoint', async () => {
      await write(1, 3);
      const checkpoint = await merkle.createCheckpoint(TENANT);
      const two = await events.findOne({ tenantId: TENANT, seq: 2 }).lean().exec();
      await events.collection.updateOne({ _id: two!._id }, { $set: { 'payload.metadata.n': 99 } });

      await expect(merkle.verifyRange(TENANT)).resolves.toMatchObject({
        valid: false,
        checkpointsVerified: 1,
        firstInvalidCheckpoint: checkpoint.checkpointId,
        reason: 'event_changed',
        invalidEventId: String(two!._id),
      });
    });

    it('names a covered event rewritten with a matching hash of its own', async () => {
      await write(1, 3);
      await merkle.createCheckpoint(TENANT);
      const two = await events.findOne({ tenantId: TENANT, seq: 2 }).lean().exec();
      // The hash is no longer a leaf of the checkpoint over its position
      await events.collection.updateOne(
        { _id: two!._id },
        { $set: { integrityHash: 'f'.repeat(64) } },
      );

      await expect(merkle.verifyRange(TENANT)).resolves.toMatchObject({
        valid: false,
        reason: 'event_changed',
        invalidEventId: String(two!._id),
      });
    });

    it('names a checkpoint whose stored root no longer matches its leaves', async () => {
      await write(1, 2);
      const checkpoint = await merkle.createCheckpoint(TENANT);
      await roots.collection.updateOne(
        { _id: checkpoint._id },
        { $set: { rootHash: 'a'.repeat(64) } },
      );

      await expect(merkle.verifyRange(TENANT)).resolves.toMatchObject({
        valid: false,
        firstInvalidCheckpoint: checkpoint.checkpointId,
        reason: 'root_mismatch',
        eventsVerified: 0,
      });
    });

    it('counts covered events that left the log without judging them', async () => {
      await write(1, 3);
      await merkle.createCheckpoint(TENANT);
      await events.collection.deleteOne({ tenantId: TENANT, seq: 3 });

      await expect(merkle.verifyRange(TENANT)).resolves.toEqual({
        valid: true,
        checkpointsVerified: 1,
        eventsVerified: 2,
        eventsMissing: 1,
        legacyCheckpointsChecked: 0,
      });
    });

    it('checks only the checkpoints created in the range', async () => {
      await write(1, 2);
      await merkle.createCheckpoint(TENANT);

      await expect(
        merkle.verifyRange(TENANT, new Date(Date.now() + 60_000)),
      ).resolves.toMatchObject({ valid: true, checkpointsVerified: 0, eventsVerified: 0 });
    });
  });
});
