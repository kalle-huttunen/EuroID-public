/**
 * The webhook retry poller (2.0dl). In-memory MongoDB with the tenant plugin, the real
 * EventDeliveryService and EventSubscriptionService; the HTTP client is a spy and the dead-letter
 * capture a mock.
 *
 * Before 2.0dl: the poller read due FAILED attempts with an unconditional find and posted each, so
 * two processes polling at once (every API replica and every worker boots it) posted the same
 * webhook twice, and a late answer overwrote what the other process recorded. Attempts of a
 * paused or deleted subscription were read and rewritten on every poll, and 50 of them (the
 * query had a limit and no order) starved the retries of active subscriptions. An attempt whose
 * send never finished stayed PENDING ("Sending") and was never retried.
 */
import { ConfigService } from '@nestjs/config';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import type { AxiosInstance } from 'axios';
import { closeTestDb, testDbUri } from '@testing/test-db';
import mongoose, { Model } from 'mongoose';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { EncryptionService } from '@infrastructure/secrets/encryption.service';
import { TenantStatusService } from '@infrastructure/multi-tenancy/tenant-status.service';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { DeadLetterService } from '../dead-letter/dead-letter.service';
import { EventDeliveryService } from './event-delivery.service';
import { EventSubscriptionService } from './event-subscription.service';
import {
  DeliveryAttempt,
  DeliveryAttemptDocument,
  DeliveryAttemptSchema,
} from './schemas/delivery-attempt.schema';
import {
  EventSubscription,
  EventSubscriptionDocument,
  EventSubscriptionSchema,
} from './schemas/event-subscription.schema';

mongoose.plugin(tenantPlugin);

const A = 'tenant-a';
const URL = 'https://hooks.example/euroid';
const BODY = {
  eventId: 'evt-1',
  eventType: 'identity.created',
  timestamp: '2026-11-23T10:00:00.000Z',
  aggregateId: 'id-1',
  payload: { identityId: 'id-1' },
};

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
const ago = (ms: number) => new Date(Date.now() - ms);

/** A promise the test settles itself: a POST still waiting for the receiver. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('Webhook retry poller: claims, order and interrupted sends (MongoDB)', () => {
  let moduleRef: TestingModule;
  let delivery: EventDeliveryService;
  let attemptModel: Model<DeliveryAttemptDocument>;
  let subModel: Model<EventSubscriptionDocument>;
  let post: jest.SpyInstance;
  const deadLetter = { capture: jest.fn() };
  /** Tenants a platform admin suspended (TenantStatusService answers not active). */
  const suspended = new Set<string>();

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(testDbUri()),
        MongooseModule.forFeature([
          { name: DeliveryAttempt.name, schema: DeliveryAttemptSchema },
          { name: EventSubscription.name, schema: EventSubscriptionSchema },
        ]),
      ],
      providers: [
        EventDeliveryService,
        EventSubscriptionService,
        { provide: EncryptionService, useValue: { decrypt: async () => 'signing-secret' } },
        { provide: DomainEventEmitterService, useValue: { emit: jest.fn() } },
        { provide: DeadLetterService, useValue: deadLetter },
        {
          provide: TenantStatusService,
          useValue: { isActive: async (tenantId: string) => !suspended.has(tenantId) },
        },
        // Defaults: 5 attempts, a one-minute lease (the test runs the polls itself).
        { provide: ConfigService, useValue: { get: () => undefined } },
      ],
    }).compile();
    await moduleRef.init();

    delivery = moduleRef.get(EventDeliveryService);
    attemptModel = moduleRef.get(getModelToken(DeliveryAttempt.name));
    subModel = moduleRef.get(getModelToken(EventSubscription.name));
    post = jest.spyOn((delivery as unknown as { http: AxiosInstance }).http, 'post');
  });

  beforeEach(() => {
    suspended.clear();
    post.mockReset();
    post.mockResolvedValue({ status: 200 });
    deadLetter.capture.mockReset();
  });

  afterEach(async () => {
    await attemptModel.deleteMany({}).setOptions({ skipTenantScope: true });
    await subModel.deleteMany({}).setOptions({ skipTenantScope: true });
  });

  afterAll(async () => {
    await moduleRef.close();
    await closeTestDb();
  });

  /** One poll of one process: the poller runs outside any request. */
  const poll = () =>
    (delivery as unknown as { processRetries: () => Promise<void> }).processRetries();

  async function subscription(status: 'ACTIVE' | 'PAUSED', name = 'SIEM'): Promise<string> {
    const doc = await withTenantContext(A, () =>
      subModel.create({
        tenantId: A,
        name,
        status,
        filters: { eventTypes: ['identity.*'] },
        webhook: { url: URL, signingSecret: 'enc', headers: {} },
      }),
    );
    return String(doc._id);
  }

  const setStatus = (id: string, status: 'ACTIVE' | 'PAUSED') =>
    subModel.updateOne({ _id: id }, { $set: { status } }).setOptions({ skipTenantScope: true });

  /** A delivery whose last attempt failed and whose retry is due (by default). */
  const failed = (subscriptionId: string, overrides: Record<string, unknown> = {}) => ({
    tenantId: A,
    subscriptionId,
    eventType: 'identity.created',
    eventId: 'evt-1',
    body: BODY,
    status: 'FAILED',
    attempts: 1,
    httpStatus: 503,
    lastError: 'Request failed with status code 503',
    nextRetryAt: ago(1000),
    ...overrides,
  });

  const attempts = () =>
    attemptModel.find({}).setOptions({ skipTenantScope: true }).sort({ _id: 1 }).lean().exec();
  const attemptById = async (id: unknown) =>
    (await attempts()).find((a) => String(a._id) === String(id));
  /** The delivery ids (X-EuroID-Delivery) of the POSTs, in the order they were made. */
  const postedDeliveries = () =>
    post.mock.calls.map(
      ([, , config]) =>
        (config as { headers: Record<string, string> }).headers['X-EuroID-Delivery'],
    );
  /** Time passes: the retry, or the lease of a send in progress, is due. */
  const makeDue = () =>
    attemptModel
      .updateMany({}, { $set: { nextRetryAt: ago(1000) } })
      .setOptions({ skipTenantScope: true })
      .exec();

  it('posts a due retry once when two processes poll at the same time', async () => {
    const sub = await subscription('ACTIVE');
    const due = await attemptModel.create(failed(sub));
    post.mockImplementation(async () => {
      await tick(20); // the receiver takes a moment: both polls are under way
      return { status: 200 };
    });

    await Promise.all([poll(), poll()]);

    expect(postedDeliveries()).toEqual([String(due._id)]);
    expect(await attemptById(due._id)).toMatchObject({ status: 'DELIVERED', attempts: 2 });
  });

  it('posts the due retries of active subscriptions, oldest first, whatever waits for paused or deleted ones', async () => {
    const active = await subscription('ACTIVE');
    const paused = await subscription('PAUSED', 'Paused feed');
    const deleted = '64b7f0c2a1b2c3d4e5f60999';
    // Sixty waiting deliveries stored first, then two due ones of the active subscription. Each
    // is another event: a subscription has one delivery per event (unique index).
    await attemptModel.insertMany(
      Array.from({ length: 60 }, (_, i) =>
        failed(i % 2 ? paused : deleted, { eventId: `evt-w${i}`, nextRetryAt: ago(600_000 - i) }),
      ),
    );
    const newer = await attemptModel.create(
      failed(active, { eventId: 'evt-newer', nextRetryAt: ago(2_000) }),
    );
    const older = await attemptModel.create(
      failed(active, { eventId: 'evt-older', nextRetryAt: ago(5_000) }),
    );

    await poll();

    expect(postedDeliveries()).toEqual([String(older._id), String(newer._id)]);
    const waiting = (await attempts()).filter((a) => a.subscriptionId !== active);
    expect(waiting).toHaveLength(60);
    for (const w of waiting) {
      // Not read, so not rewritten: the receiver's error, the attempts and the retry time stay.
      expect(w).toMatchObject({
        status: 'FAILED',
        attempts: 1,
        lastError: 'Request failed with status code 503',
      });
    }
  });

  it('sends a retry that fell due during a pause after the resume, its attempts unchanged meanwhile', async () => {
    const sub = await subscription('PAUSED');
    const due = await attemptModel.create(failed(sub, { attempts: 2 }));

    await poll();
    expect(post).not.toHaveBeenCalled();
    expect(await attemptById(due._id)).toMatchObject({
      status: 'FAILED',
      attempts: 2,
      lastError: 'Request failed with status code 503',
    });

    await setStatus(sub, 'ACTIVE');
    await poll();
    expect(postedDeliveries()).toEqual([String(due._id)]);
    expect(await attemptById(due._id)).toMatchObject({ status: 'DELIVERED', attempts: 3 });
  });

  // Hunt 07 F1: a suspended tenant gets no webhooks. Its due retries wait with their attempts
  // unchanged, so a reactivated tenant's receiver still gets the events from before the suspension.
  it('leaves the due retries of a suspended tenant waiting, and sends them after a reactivation', async () => {
    const sub = await subscription('ACTIVE');
    const due = await attemptModel.create(failed(sub, { attempts: 2 }));
    suspended.add(A);

    await poll();

    expect(post).not.toHaveBeenCalled();
    expect(await attemptById(due._id)).toMatchObject({
      status: 'FAILED',
      attempts: 2,
      nextRetryAt: due.nextRetryAt,
    });

    suspended.delete(A);
    await poll();
    expect(postedDeliveries()).toEqual([String(due._id)]);
    expect(await attemptById(due._id)).toMatchObject({ status: 'DELIVERED', attempts: 3 });
  });

  it('sends a delivery again once the send that held it stopped, counting the stopped send', async () => {
    await subscription('ACTIVE');
    // The process sending the first attempt stops before the receiver answers.
    post.mockImplementationOnce(() => new Promise(() => undefined));
    await delivery.handleDomainEvent({
      eventId: 'evt-9',
      type: 'identity.created' as never,
      aggregateId: 'id-9',
      timestamp: '2026-11-23T11:00:00.000Z',
      payload: { identityId: 'id-9' },
      metadata: { correlationId: 'c-9', depth: 0, emittedBy: 'test', actor: 'system', tenantId: A },
    });
    for (let i = 0; i < 50 && post.mock.calls.length === 0; i++) await tick();
    const [sending] = await attempts();
    expect(sending).toMatchObject({ status: 'PENDING', attempts: 0 });

    // While its lease runs, the attempt belongs to the process sending it.
    await poll();
    expect(post).toHaveBeenCalledTimes(1);

    await makeDue();
    await poll();

    expect(postedDeliveries()).toEqual([String(sending._id), String(sending._id)]);
    expect(post.mock.calls[1][1]).toBe(post.mock.calls[0][1]); // the same signed body
    expect(await attemptById(sending._id)).toMatchObject({ status: 'DELIVERED', attempts: 2 });
  });

  it('dead-letters a delivery whose last allowed send stopped, without sending it again', async () => {
    const sub = await subscription('ACTIVE');
    const stopped = await attemptModel.create(
      failed(sub, { status: 'PENDING', attempts: 4, lastError: undefined }),
    );

    await poll();

    expect(post).not.toHaveBeenCalled();
    const after = await attemptById(stopped._id);
    expect(after).toMatchObject({ status: 'FAILED', attempts: 5 });
    expect(after?.lastError).toMatch(/interrupted/);
    expect(after?.nextRetryAt).toBeUndefined();
    expect(deadLetter.capture).toHaveBeenCalledTimes(1);
    expect(deadLetter.capture.mock.calls[0][0]).toMatchObject({
      tenantId: A,
      source: `webhook:${sub}:identity.created`,
      handler: 'EventDeliveryService.handleDeliveryRetry',
    });
  });

  it('records the outcome of the process that holds the claim, not the late answer of one that lost it', async () => {
    const sub = await subscription('ACTIVE');
    const due = await attemptModel.create(failed(sub));
    const late = deferred<{ status: number }>();
    post.mockImplementationOnce(() => late.promise);

    // Process 1 posts and waits; its lease runs out before the receiver answers.
    const first = poll();
    for (let i = 0; i < 50 && post.mock.calls.length === 0; i++) await tick();
    await makeDue();

    // Process 2 takes the delivery over and gets it delivered.
    await poll();
    expect(await attemptById(due._id)).toMatchObject({ status: 'DELIVERED' });

    // Process 1's receiver finally fails: that answer no longer belongs to anyone.
    late.reject(new Error('socket hang up'));
    await first;

    expect(postedDeliveries()).toEqual([String(due._id), String(due._id)]);
    expect(await attemptById(due._id)).toMatchObject({ status: 'DELIVERED', httpStatus: 200 });
  });
});
