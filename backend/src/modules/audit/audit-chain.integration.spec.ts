/**
 * The audit hash chain on in-memory MongoDB with the real AuditService (tenant plugin as at
 * runtime). Each AuditService instance stands for one process (the API, the worker).
 *
 * Before: each process cached its own last hash per tenant, so two processes, or two writes at the
 * same moment, linked events to the same predecessor and the link check reported tampering that
 * never happened; and the hash covered no payload (the key allow-list emptied nested objects).
 *
 * Proves: one chain per tenant whatever the writers (seq 1, 2, 3 ... each linked to the one
 * before); the chain continues from the events already in the log (no second genesis), also when
 * the first writes come at the same moment; a redelivered event leaves no gap; hash version 2
 * covers the payload and eventId; a removed event, or one at the end, is reported as missing;
 * events written before (hash version 1, forked links) still verify, are counted, and a link to an
 * event that is nowhere is still a broken link.
 */
import mongoose, { Model } from 'mongoose';
import { createHash } from 'crypto';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import { connectTestDb, clearTestDb, closeTestDb } from '@testing';
import { AuditService, type LogAuditEvent } from './audit.service';
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
import { GENESIS_HASH } from './audit-hash';

mongoose.plugin(tenantPlugin);

const TENANT = 'tenant-a';

const event = (n: number, extra: Partial<LogAuditEvent> = {}): LogAuditEvent => ({
  action: 'CONFIG_CHANGED',
  actor: 'admin@corp.example',
  resourceType: 'config',
  resourceId: `cfg-${n}`,
  resourceName: `Config ${n}`,
  description: `Change ${n}`,
  tenantId: TENANT,
  ...extra,
});

/** The hash rule events were written with before hash version 2 (audit.service.ts until now). */
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

describe('Audit hash chain (in-memory MongoDB)', () => {
  let events: Model<AuditEventDocument>;
  let heads: Model<AuditChainHeadDocument>;
  const process = () => new AuditService(events, heads);

  /** Events written before the chain head, as the old writers stored them: returns their hashes. */
  async function insertOldEvents(
    rows: Array<{ n: number; at: string; linksTo: string }>,
  ): Promise<string[]> {
    const hashes: string[] = [];
    for (const row of rows) {
      const timestamp = new Date(row.at);
      const stored: Record<string, unknown> = {
        ...event(row.n),
        severity: 'info',
        timestamp,
        payload: { metadata: { step: row.n } },
        previousHash: row.linksTo,
      };
      stored.integrityHash = oldHash(stored);
      await events.collection.insertOne({
        ...stored,
        createdAt: timestamp,
        updatedAt: timestamp,
        __v: 0,
      });
      hashes.push(stored.integrityHash as string);
    }
    return hashes;
  }

  const chained = () =>
    events.collection
      .find({ seq: { $exists: true } })
      .sort({ seq: 1 })
      .toArray();

  beforeAll(async () => {
    await connectTestDb();
    events = mongoose.model(
      AuditEvent.name,
      AuditEventSchema,
    ) as unknown as Model<AuditEventDocument>;
    heads = mongoose.model(
      AuditChainHead.name,
      AuditChainHeadSchema,
    ) as unknown as Model<AuditChainHeadDocument>;
    // The unique indexes are what keeps two writers apart: built before the tests run
    await Promise.all([events.init(), heads.init()]);
  });
  afterEach(clearTestDb);
  afterAll(closeTestDb);

  describe('one chain per tenant', () => {
    it('two processes writing in turn leave one chain the check accepts', async () => {
      const api = process();
      const worker = process();

      await api.log(event(1));
      await worker.log(event(2));
      await api.log(event(3));

      const stored = await chained();
      expect(stored.map((e) => e.seq)).toEqual([1, 2, 3]);
      expect(stored[0].previousHash).toBe(GENESIS_HASH);
      expect(stored[1].previousHash).toBe(stored[0].integrityHash);
      expect(stored[2].previousHash).toBe(stored[1].integrityHash);
      await expect(api.verifyIntegrity(TENANT)).resolves.toEqual({
        valid: true,
        eventsChecked: 3,
        legacyEventsChecked: 0,
        erasureGaps: [],
      });
    });

    it('writes at the same moment, in one process and in two, take one position each', async () => {
      const api = process();
      const worker = process();
      await api.log(event(0));

      await Promise.all(
        Array.from({ length: 12 }, (_, i) => (i % 2 ? api : worker).log(event(i + 1))),
      );

      expect((await chained()).map((e) => e.seq)).toEqual(
        Array.from({ length: 13 }, (_, i) => i + 1),
      );
      await expect(api.verifyIntegrity(TENANT)).resolves.toMatchObject({
        valid: true,
        eventsChecked: 13,
      });
      expect(await heads.collection.findOne({ tenantId: TENANT })).toMatchObject({ seq: 13 });
    });

    // A bulk operation or the outbox poller can hand one process many audit writes at once: they
    // queue per tenant inside the process, so they do not all race for the head and run out of
    // attempts (each round of a race stores one event).
    it('a burst of writes in one process stores every event, one position each', async () => {
      const api = process();

      await Promise.all(Array.from({ length: 120 }, (_, i) => api.log(event(i + 1))));

      expect((await chained()).map((e) => e.seq)).toEqual(
        Array.from({ length: 120 }, (_, i) => i + 1),
      );
      await expect(api.verifyIntegrity(TENANT)).resolves.toMatchObject({ valid: true });
    });

    it('continues from the events already in the log, also when the first writes come together', async () => {
      const [first] = await insertOldEvents([
        { n: 1, at: '2026-11-01T10:00:00.000Z', linksTo: GENESIS_HASH },
      ]);
      const [last] = await insertOldEvents([
        { n: 2, at: '2026-11-02T10:00:00.000Z', linksTo: first },
      ]);

      await Promise.all([
        process().log(event(3)),
        process().log(event(4)),
        process().log(event(5)),
      ]);

      const stored = await chained();
      expect(stored.map((e) => e.seq)).toEqual([1, 2, 3]);
      // No second genesis: position 1 links to the newest event already in the log
      expect(stored[0].previousHash).toBe(last);
      expect(await heads.collection.countDocuments({ tenantId: TENANT })).toBe(1);
      await expect(process().verifyIntegrity(TENANT)).resolves.toMatchObject({
        valid: true,
        eventsChecked: 5,
        legacyEventsChecked: 2,
      });
    });

    it('a redelivered event stores nothing and leaves no gap', async () => {
      const api = process();
      const first = await api.log(event(1, { eventId: 'evt-1' }));
      const again = await api.log(event(1, { eventId: 'evt-1' }));
      await api.log(event(2));

      expect(String(again._id)).toBe(String(first._id));
      expect((await chained()).map((e) => e.seq)).toEqual([1, 2]);
      await expect(api.verifyIntegrity(TENANT)).resolves.toMatchObject({ valid: true });
    });

    it('a write the database refuses throws, stores nothing and leaves no gap', async () => {
      const api = process();
      await expect(api.log({ ...event(1), actor: undefined as unknown as string })).rejects.toThrow(
        /actor/,
      );
      await api.log(event(2));

      const stored = await chained();
      expect(stored.map((e) => [e.seq, e.resourceId])).toEqual([[1, 'cfg-2']]);
      expect(stored[0].previousHash).toBe(GENESIS_HASH);
    });

    it('a writer that stopped after storing its event leaves the head behind; the next one catches up', async () => {
      const api = process();
      await api.log(event(1));
      await api.log(event(2));
      // As if the writer of position 2 stopped before it moved the head
      const [one] = await chained();
      await heads.collection.updateOne(
        { tenantId: TENANT },
        { $set: { seq: 1, lastHash: one.integrityHash } },
      );

      await process().log(event(3));

      expect((await chained()).map((e) => e.seq)).toEqual([1, 2, 3]);
      await expect(api.verifyIntegrity(TENANT)).resolves.toMatchObject({ valid: true });
    });
  });

  describe('hash version 2', () => {
    it('covers the payload and eventId, and survives what MongoDB does to a payload', async () => {
      const api = process();
      await api.log(
        event(1, {
          eventId: 'evt-9',
          payload: {
            before: { role: 'reader', since: new Date('2026-01-01T00:00:00.000Z') },
            after: { role: 'writer', tags: ['a', undefined, { x: 1 }], empty: {}, gone: undefined },
            metadata: { nested: { deeper: { n: 1.5, nil: null } }, '10': 'ten', '9': 'nine' },
          },
        }),
      );
      await expect(api.verifyIntegrity(TENANT)).resolves.toMatchObject({ valid: true });
      const [stored] = await chained();
      expect(stored.hashVersion).toBe(2);

      await events.collection.updateOne(
        { _id: stored._id },
        { $set: { 'payload.after.role': 'admin' } },
      );
      await expect(api.verifyIntegrity(TENANT)).resolves.toMatchObject({
        valid: false,
        firstInvalid: String(stored._id),
        firstInvalidSeq: 1,
        reason: 'hash_mismatch',
      });

      await events.collection.updateOne(
        { _id: stored._id },
        { $set: { 'payload.after.role': 'writer', eventId: 'evt-10' } },
      );
      await expect(api.verifyIntegrity(TENANT)).resolves.toMatchObject({ reason: 'hash_mismatch' });
    });
  });

  describe('missing events', () => {
    it('reports a removed middle event at the event after it, with how many are missing', async () => {
      const api = process();
      for (let n = 1; n <= 4; n++) await api.log(event(n));
      const [, two, three, four] = await chained();
      await events.collection.deleteMany({ _id: { $in: [two._id, three._id] } });

      await expect(api.verifyIntegrity(TENANT)).resolves.toEqual({
        valid: false,
        eventsChecked: 2,
        firstInvalid: String(four._id),
        firstInvalidAt: (four.timestamp as Date).toISOString(),
        firstInvalidSeq: 4,
        reason: 'missing_events',
        missingEvents: 2,
        legacyEventsChecked: 0,
        erasureGaps: [],
      });
    });

    it('reports events removed at the end of the chain when the window reaches now', async () => {
      const api = process();
      for (let n = 1; n <= 3; n++) await api.log(event(n));
      const [, two, three] = await chained();
      await events.collection.deleteOne({ _id: three._id });

      await expect(api.verifyIntegrity(TENANT)).resolves.toMatchObject({
        valid: false,
        eventsChecked: 2,
        firstInvalidSeq: 3,
        reason: 'missing_events',
        missingEvents: 1,
      });
      expect((await api.verifyIntegrity(TENANT)).firstInvalid).toBeUndefined();
      // So does a window that ends later than now; one that ends before the removed event does not
      await expect(
        api.verifyIntegrity(TENANT, undefined, new Date(Date.now() + 60_000).toISOString()),
      ).resolves.toMatchObject({ valid: false, reason: 'missing_events' });
      await expect(
        api.verifyIntegrity(TENANT, undefined, (two.timestamp as Date).toISOString()),
      ).resolves.toMatchObject({ valid: true, eventsChecked: 2 });
    });

    it('does not check the link of the first event in the window', async () => {
      const api = process();
      await api.log(event(1));
      const cut = new Date(Date.now() + 5);
      await new Promise((resolve) => setTimeout(resolve, 10));
      await api.log(event(2));
      await api.log(event(3));

      await expect(api.verifyIntegrity(TENANT, cut.toISOString())).resolves.toMatchObject({
        valid: true,
        eventsChecked: 2,
      });
    });
  });

  describe('events written before hash version 2', () => {
    // As the old writers left them: the API's cache still pointed at its own last event
    const forked = async () => {
      const [a1] = await insertOldEvents([
        { n: 1, at: '2026-11-01T10:00:00.000Z', linksTo: GENESIS_HASH },
      ]);
      const [w1] = await insertOldEvents([{ n: 2, at: '2026-11-01T10:01:00.000Z', linksTo: a1 }]);
      const [w2] = await insertOldEvents([{ n: 3, at: '2026-11-01T10:02:00.000Z', linksTo: w1 }]);
      const [a2] = await insertOldEvents([{ n: 4, at: '2026-11-01T10:03:00.000Z', linksTo: a1 }]);
      return [a1, w1, w2, a2];
    };

    it('verify with their own hash rule, accept forked links and are counted', async () => {
      await forked();

      const result = await process().verifyIntegrity(TENANT);

      expect(result).toMatchObject({ valid: true, eventsChecked: 4, legacyEventsChecked: 4 });
      expect(result.legacyNote).toMatch(/does not cover the payload/);
    });

    it('accept a link to an earlier event outside the window', async () => {
      await forked();
      // The window starts after the API's event the last one links to
      await expect(
        process().verifyIntegrity(TENANT, '2026-11-01T10:00:30.000Z'),
      ).resolves.toMatchObject({ valid: true, eventsChecked: 3, legacyEventsChecked: 3 });
    });

    it('still report a link to an event that is nowhere in the log', async () => {
      const [, w1] = await forked();
      await events.collection.deleteOne({ integrityHash: w1 });

      await expect(process().verifyIntegrity(TENANT)).resolves.toMatchObject({
        valid: false,
        eventsChecked: 2,
        reason: 'broken_link',
        legacyEventsChecked: 2,
      });
    });

    it('report a changed event as a hash mismatch', async () => {
      const [, w1] = await forked();
      await events.collection.updateOne(
        { integrityHash: w1 },
        { $set: { description: 'Rewritten' } },
      );

      await expect(process().verifyIntegrity(TENANT)).resolves.toMatchObject({
        valid: false,
        eventsChecked: 2,
        reason: 'hash_mismatch',
      });
    });
  });
});
