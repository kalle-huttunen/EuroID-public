/**
 * OutboxPollerService claims on in-memory MongoDB (event_outbox): an event claimed by a process
 * that stopped before it published is published by a later poll.
 *
 * The claim took only `pending` events and set `processing` with a claimedAt the schema did not
 * declare, so Mongoose dropped it from the update, and nothing returned a `processing` event to
 * the queue: an API or worker that died between the claim and the publish lost that domain event
 * for good.
 *
 * Proves: a claim stores claimedAt; an event whose claim is older than OUTBOX_CLAIM_TIMEOUT_MS is
 * claimed again and published, and so is one claimed without claimedAt (before this fix) once
 * its claim (updatedAt) is that old; an event claimed within the timeout, or already published,
 * is left alone.
 */
import mongoose, { Model } from 'mongoose';
import type { ConfigService } from '@nestjs/config';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import { connectTestDb, clearTestDb, closeTestDb } from '@testing';
import type { DeadLetterService } from '../../modules/dead-letter/dead-letter.service';
import { OutboxEvent, OutboxEventDocument, OutboxEventSchema } from './schemas/outbox-event.schema';
import { OutboxPollerService } from './outbox-poller.service';

// Tenant scoping as at runtime (TenantModule registers the plugin at import time)
mongoose.plugin(tenantPlugin);

const CLAIM_TIMEOUT_MS = 300_000;
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

/** Resolves once `check` holds, letting timers and I/O run in between; fails after 3 s. */
async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('The condition was not reached within 3 s');
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** An identity.created outbox row as MongoDB holds it, with `fields` set on top. */
const row = (eventId: string, fields: Record<string, unknown>) => ({
  eventId,
  type: 'identity.created',
  aggregateId: `identity-${eventId}`,
  payload: { identityId: `identity-${eventId}`, sourceSystem: 'manual-ui', status: 'ACTIVE' },
  metadata: {
    correlationId: `corr-${eventId}`,
    depth: 0,
    emittedBy: 'DomainEventEmitterService',
    actor: 'admin',
    tenantId: 'tenant-a',
  },
  tenantId: 'tenant-a',
  retryCount: 0,
  createdAt: minutesAgo(30),
  updatedAt: minutesAgo(30),
  ...fields,
});

describe('OutboxPollerService claims (in-memory MongoDB)', () => {
  let model: Model<OutboxEventDocument>;
  let poller: OutboxPollerService;
  const emitAsync = jest.fn();

  const stored = (eventId: string) => model.collection.findOne({ eventId });
  const published = () => emitAsync.mock.calls.map(([, event]) => event.eventId);

  beforeAll(async () => {
    await connectTestDb();
    model = mongoose.model(
      OutboxEvent.name,
      OutboxEventSchema,
    ) as unknown as Model<OutboxEventDocument>;
    const settings: Record<string, number> = {
      'events.OUTBOX_POLLER_BATCH_SIZE': 100,
      'events.OUTBOX_CLAIM_TIMEOUT_MS': CLAIM_TIMEOUT_MS,
    };
    poller = new OutboxPollerService(
      model,
      { emitAsync } as unknown as EventEmitter2,
      { capture: jest.fn() } as unknown as DeadLetterService,
      { get: (key: string) => settings[key] } as unknown as ConfigService,
    );
  });

  beforeEach(() => {
    emitAsync.mockReset().mockResolvedValue([]);
  });

  afterEach(async () => {
    await clearTestDb();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('stores when it claimed an event', async () => {
    await model.collection.insertOne(row('evt-pending', { status: 'pending' }));
    const before = Date.now();

    await poller.processPending();

    const doc = await stored('evt-pending');
    expect(doc?.status).toBe('published');
    expect(doc?.claimedAt).toBeInstanceOf(Date);
    expect(doc?.claimedAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  // The process that claimed it stopped between the claim and the publish
  it('publishes an event whose claim is older than the timeout', async () => {
    await model.collection.insertOne(
      row('evt-stale', { status: 'processing', claimedAt: minutesAgo(10) }),
    );

    await poller.processPending();

    expect(published()).toEqual(['evt-stale']);
    expect((await stored('evt-stale'))?.status).toBe('published');
  });

  // Claims made before this fix have no claimedAt: the claim's updatedAt is when it was taken
  it('publishes an event claimed without claimedAt once that claim is older than the timeout', async () => {
    await model.collection.insertOne(
      row('evt-legacy', { status: 'processing', updatedAt: minutesAgo(10) }),
    );

    await poller.processPending();

    expect(published()).toEqual(['evt-legacy']);
    expect((await stored('evt-legacy'))?.status).toBe('published');
  });

  it('leaves an event claimed within the timeout to the process holding it', async () => {
    const oneMinuteAgo = minutesAgo(1);
    await model.collection.insertMany([
      row('evt-fresh', { status: 'processing', claimedAt: oneMinuteAgo, updatedAt: oneMinuteAgo }),
      row('evt-fresh-legacy', { status: 'processing', updatedAt: oneMinuteAgo }),
      row('evt-done', { status: 'published', claimedAt: minutesAgo(10) }),
    ]);

    await poller.processPending();

    expect(emitAsync).not.toHaveBeenCalled();
    expect((await stored('evt-fresh'))?.status).toBe('processing');
    expect((await stored('evt-fresh-legacy'))?.status).toBe('processing');
    expect((await stored('evt-done'))?.status).toBe('published');
  });

  // A failed publish went back to pending and the same loop claimed it again at once: five
  // failures in a row within milliseconds, then the dead letter queue.
  it('waits for the backoff before it publishes a failed event again', async () => {
    await model.collection.insertOne(row('evt-failing', { status: 'pending' }));
    emitAsync.mockRejectedValue(new Error('handler down'));
    const before = Date.now();

    await poller.processPending();
    await poller.processPending();

    expect(emitAsync).toHaveBeenCalledTimes(1);
    const doc = await stored('evt-failing');
    expect(doc?.status).toBe('pending');
    expect(doc?.retryCount).toBe(1);
    expect(doc?.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before + 5_000);

    // Once the retry is due it is claimed and published
    emitAsync.mockReset().mockResolvedValue([]);
    await model.collection.updateOne(
      { eventId: 'evt-failing' },
      { $set: { nextAttemptAt: minutesAgo(1) } },
    );
    await poller.processPending();
    expect(published()).toEqual(['evt-failing']);
    expect((await stored('evt-failing'))?.status).toBe('published');
  });

  // A handler slower than OUTBOX_CLAIM_TIMEOUT_MS let another process take the claim and publish
  // the event a second time while the first was still publishing it.
  it('keeps its claim while a slow publish runs, so no other process publishes it again', async () => {
    const settings: Record<string, number> = {
      'events.OUTBOX_POLLER_BATCH_SIZE': 100,
      'events.OUTBOX_CLAIM_TIMEOUT_MS': 300, // renewed every 100 ms
    };
    let finish: (value: unknown) => void = () => undefined;
    const slowEmit = jest.fn(() => new Promise((resolve) => (finish = resolve)));
    const otherEmit = jest.fn().mockResolvedValue([]);
    const make = (emit: jest.Mock) =>
      new OutboxPollerService(
        model,
        { emitAsync: emit } as unknown as EventEmitter2,
        { capture: jest.fn() } as unknown as DeadLetterService,
        { get: (key: string) => settings[key] } as unknown as ConfigService,
      );
    await model.collection.insertOne(row('evt-slow', { status: 'pending' }));

    const first = make(slowEmit).processPending();
    await until(() => slowEmit.mock.calls.length === 1);
    // As if the handlers had run longer than the claim timeout
    await model.collection.updateOne(
      { eventId: 'evt-slow' },
      { $set: { claimedAt: minutesAgo(10) } },
    );
    // The process still publishing renews its claim, so another process leaves the event alone
    await until(async () => (await stored('evt-slow'))!.claimedAt > minutesAgo(1));
    await make(otherEmit).processPending();
    finish([]);
    await first;

    expect(slowEmit).toHaveBeenCalledTimes(1);
    expect(otherEmit).not.toHaveBeenCalled();
    expect((await stored('evt-slow'))?.status).toBe('published');
  });
});
