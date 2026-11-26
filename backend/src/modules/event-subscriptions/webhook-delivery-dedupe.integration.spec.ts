/**
 * One webhook delivery per subscription and event (hunt 07 F12). In-memory MongoDB with the tenant
 * plugin, the real EventDeliveryService and EventSubscriptionService; the HTTP client is a spy.
 *
 * Before: deliverWebhook checked for an attempt and then inserted one, on a non-unique index, so
 * two processes handling one event at once (an outbox reclaim, a dead-letter replay) both
 * inserted an attempt and both posted the webhook. The index is unique now and the insert is the
 * claim. Migration 20261125000002 removes existing duplicates and replaces the index.
 */
import { ConfigService } from '@nestjs/config';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import type { AxiosInstance } from 'axios';
import { MongoClient, ObjectId } from 'mongodb';
import mongoose, { Model } from 'mongoose';
import { closeTestDb, testDbName, testDbUri } from '@testing/test-db';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { TenantStatusService } from '@infrastructure/multi-tenancy/tenant-status.service';
import { EncryptionService } from '@infrastructure/secrets/encryption.service';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import type { DomainEvent } from '@infrastructure/events/domain-event.interface';
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
import { up, down } from '../../../migrations/20261125000002-webhook-delivery-unique-per-event';

mongoose.plugin(tenantPlugin);

const A = 'tenant-a';
const INDEX = 'subscriptionId_1_eventId_1';

const event = (eventId: string): DomainEvent =>
  ({
    eventId,
    type: 'identity.created',
    aggregateId: 'id-1',
    timestamp: '2026-11-25T10:00:00.000Z',
    payload: { identityId: 'id-1' },
    metadata: { correlationId: 'c-1', depth: 0, emittedBy: 'test', actor: 'system', tenantId: A },
  }) as DomainEvent;

describe('Webhook delivery: one per subscription and event (MongoDB)', () => {
  afterAll(async () => {
    await closeTestDb();
  });

  describe('delivery', () => {
    let moduleRef: TestingModule;
    let delivery: EventDeliveryService;
    let attemptModel: Model<DeliveryAttemptDocument>;
    let subModel: Model<EventSubscriptionDocument>;
    let post: jest.SpyInstance;

    beforeAll(async () => {
      moduleRef = await Test.createTestingModule({
        imports: [
          MongooseModule.forRoot(testDbUri('delivery')),
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
          { provide: DeadLetterService, useValue: { capture: jest.fn() } },
          { provide: TenantStatusService, useValue: { isActive: async () => true } },
          { provide: ConfigService, useValue: { get: () => undefined } },
        ],
      }).compile();
      await moduleRef.init();
      delivery = moduleRef.get(EventDeliveryService);
      attemptModel = moduleRef.get(getModelToken(DeliveryAttempt.name));
      subModel = moduleRef.get(getModelToken(EventSubscription.name));
      await attemptModel.init(); // the schema's indexes are built
      post = jest.spyOn((delivery as unknown as { http: AxiosInstance }).http, 'post');
    });

    beforeEach(() => {
      post.mockReset();
      post.mockResolvedValue({ status: 200 });
    });

    afterAll(async () => {
      await moduleRef.close();
    });

    it('builds the { subscriptionId, eventId } index unique', async () => {
      const index = (await attemptModel.collection.indexes()).find((i) => i.name === INDEX);
      expect(index).toMatchObject({ key: { subscriptionId: 1, eventId: 1 }, unique: true });
    });

    it('posts an event once when two handlers deliver it at the same time', async () => {
      const sub = await withTenantContext(A, () =>
        subModel.create({
          tenantId: A,
          name: 'SIEM',
          status: 'ACTIVE',
          filters: { eventTypes: ['identity.*'] },
          webhook: { url: 'https://hooks.example/euroid', signingSecret: 'enc', headers: {} },
        }),
      );
      const deliver = () =>
        withTenantContext(A, () =>
          (
            delivery as unknown as {
              deliverWebhook: (s: unknown, e: DomainEvent) => Promise<void>;
            }
          ).deliverWebhook(sub.toObject(), event('evt-same')),
        );

      await Promise.all([deliver(), deliver()]);

      expect(post).toHaveBeenCalledTimes(1);
      const stored = await attemptModel.find({}).setOptions({ skipTenantScope: true }).lean();
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({ eventId: 'evt-same', status: 'DELIVERED', attempts: 1 });
    });
  });

  describe('migration', () => {
    let client: MongoClient;

    beforeAll(async () => {
      client = await MongoClient.connect(testDbUri());
    });

    afterAll(async () => {
      await client?.close();
    });

    const sub1 = 'sub-1';
    const sub2 = 'sub-2';
    const row = (subscriptionId: string, eventId: string, status: string, n: number) => ({
      _id: new ObjectId(n.toString(16).padStart(24, '0')),
      tenantId: A,
      subscriptionId,
      eventType: 'identity.created',
      eventId,
      status,
      attempts: n,
    });

    /** The previous schema's non-unique index, with the duplicates it let in. */
    async function legacyCollection(label: string) {
      const attempts = client.db(testDbName(label)).collection('webhook_delivery_attempts');
      await attempts.createIndex({ subscriptionId: 1, eventId: 1 }, { name: INDEX });
      await attempts.insertMany([
        row(sub1, 'e1', 'FAILED', 1),
        row(sub1, 'e1', 'DELIVERED', 2),
        row(sub1, 'e2', 'FAILED', 3),
        row(sub1, 'e2', 'FAILED', 4),
        row(sub2, 'e1', 'FAILED', 5),
        row(sub2, 'e1', 'PENDING', 6),
        row(sub2, 'e3', 'DELIVERED', 7),
      ]);
      return attempts;
    }

    it('keeps one attempt per subscription and event, delivered first, and makes the index unique', async () => {
      const attempts = await legacyCollection('migration-legacy');

      await up(client.db(testDbName('migration-legacy')));
      await up(client.db(testDbName('migration-legacy')));

      const kept = await attempts.find({}, { sort: { _id: 1 } }).toArray();
      expect(kept.map((a) => [a.subscriptionId, a.eventId, a.status, a.attempts])).toEqual([
        [sub1, 'e1', 'DELIVERED', 2], // the receiver has it: the failed copy would send it again
        [sub1, 'e2', 'FAILED', 3], // equals: the oldest stays
        [sub2, 'e1', 'PENDING', 6], // being sent
        [sub2, 'e3', 'DELIVERED', 7],
      ]);
      expect((await attempts.indexes()).find((i) => i.name === INDEX)).toMatchObject({
        unique: true,
      });
      await expect(attempts.insertOne(row(sub1, 'e1', 'PENDING', 8))).rejects.toMatchObject({
        code: 11000,
      });
    });

    it('does nothing harmful on a deployment without the collection', async () => {
      await expect(up(client.db(testDbName('migration-empty')))).resolves.toBeUndefined();
    });

    it('down restores the non-unique index', async () => {
      const attempts = await legacyCollection('migration-down');
      await up(client.db(testDbName('migration-down')));

      await down(client.db(testDbName('migration-down')));
      await down(client.db(testDbName('migration-down')));

      const index = (await attempts.indexes()).find((i) => i.name === INDEX);
      expect(index).toBeDefined();
      expect(index?.unique).toBeUndefined();
    });
  });
});
