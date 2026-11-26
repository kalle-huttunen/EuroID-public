/**
 * A webhook delivery that ran out of attempts reaches the dead-letter queue and is re-delivered by
 * its retry (2.0cu). In-memory MongoDB with the tenant plugin, the real DeadLetterService,
 * EventDeliveryService, handler registry and Nest event emitter; the HTTP client is a spy.
 *
 * Before 2.0cu: the entry stored neither the event nor the body, so a retry delivered nothing and
 * still closed it as replayed; the retry poller ran without a tenant context, so its attempt
 * updates and the capture (the tenant plugin also validated the entry's nested `error`) failed.
 */
import { createHmac } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { DiscoveryModule } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { MongooseModule, getModelToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import type { AxiosInstance } from 'axios';
import { closeTestDb, testDbUri } from '@testing/test-db';
import mongoose, { Model } from 'mongoose';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import { requestContext } from '@infrastructure/middleware/correlation.middleware';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { EncryptionService } from '@infrastructure/secrets/encryption.service';
import { TenantStatusService } from '@infrastructure/multi-tenancy/tenant-status.service';
import { HandlerFailureCaptureService } from '@infrastructure/events/handler-failure-capture.service';
import { DeadLetterService } from '../dead-letter/dead-letter.service';
import { DeadLetterHandlerRegistry } from '../dead-letter/dead-letter-handler.registry';
import {
  DeadLetterEntry,
  DeadLetterEntryDocument,
  DeadLetterEntrySchema,
} from '../dead-letter/schemas/dead-letter.schema';
import { PluginRegistryService } from '../connectors/plugin/plugin-registry.service';
import { EventDeliveryService } from './event-delivery.service';
import { EventSubscriptionService } from './event-subscription.service';
import {
  DeliveryAttempt,
  DeliveryAttemptDocument,
  DeliveryAttemptSchema,
} from './schemas/delivery-attempt.schema';

mongoose.plugin(tenantPlugin);

const A = 'tenant-a';
const B = 'tenant-b';
const SECRET = 'signing-secret';
const SUB = {
  _id: 'sub-1',
  tenantId: A,
  status: 'ACTIVE',
  filters: { eventTypes: ['identity.created'] },
  webhook: { url: 'https://hooks.example/euroid/token-123', signingSecret: 'enc', headers: {} },
};
/** What the first attempt built and sent: ids only. */
const BODY = {
  eventId: 'evt-1',
  eventType: 'identity.created',
  timestamp: '2026-11-22T10:00:00.000Z',
  aggregateId: 'id-1',
  payload: { identityId: 'id-1' },
};

describe('Webhook deliveries: dead-letter capture and retry (MongoDB)', () => {
  let moduleRef: TestingModule;
  let dlq: DeadLetterService;
  let delivery: EventDeliveryService;
  let dlqModel: Model<DeadLetterEntryDocument>;
  let attemptModel: Model<DeliveryAttemptDocument>;
  let post: jest.SpyInstance;
  const subscriptions = {
    getActiveSubscriptionsForEvent: jest.fn(),
    // What the retry poller reads (2.0dl): per tenant, that tenant's active subscriptions.
    tenantsWithActiveSubscriptions: jest.fn(),
    getActiveSubscriptions: jest.fn(),
  };

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(testDbUri()),
        MongooseModule.forFeature([
          { name: DeadLetterEntry.name, schema: DeadLetterEntrySchema },
          { name: DeliveryAttempt.name, schema: DeliveryAttemptSchema },
        ]),
        EventEmitterModule.forRoot({ wildcard: true, delimiter: '.' }),
        DiscoveryModule,
      ],
      providers: [
        DeadLetterService,
        DeadLetterHandlerRegistry,
        HandlerFailureCaptureService,
        EventDeliveryService,
        { provide: EventSubscriptionService, useValue: subscriptions },
        { provide: EncryptionService, useValue: { decrypt: async () => SECRET } },
        // The tenant is active (suspension: webhook-retry-poller.integration.spec.ts).
        { provide: TenantStatusService, useValue: { isActive: async () => true } },
        // Defaults: 5 delivery attempts, DLQ_MAX_RETRIES 3 (the test runs the polls itself).
        { provide: ConfigService, useValue: { get: () => undefined } },
        { provide: PluginRegistryService, useValue: { getSecretConfigKeys: () => null } },
      ],
    }).compile();
    await moduleRef.init(); // registers handleDeliveryRetry for the DLQ retry

    dlq = moduleRef.get(DeadLetterService);
    delivery = moduleRef.get(EventDeliveryService);
    dlqModel = moduleRef.get(getModelToken(DeadLetterEntry.name));
    attemptModel = moduleRef.get(getModelToken(DeliveryAttempt.name));
    post = jest.spyOn((delivery as unknown as { http: AxiosInstance }).http, 'post');
  });

  beforeEach(() => {
    subscriptions.getActiveSubscriptionsForEvent.mockResolvedValue([SUB]);
    subscriptions.tenantsWithActiveSubscriptions.mockResolvedValue([A]);
    subscriptions.getActiveSubscriptions.mockResolvedValue([SUB]);
    post.mockReset();
  });

  afterEach(async () => {
    await dlqModel.deleteMany({}).setOptions({ skipTenantScope: true });
    await attemptModel.deleteMany({}).setOptions({ skipTenantScope: true });
  });

  afterAll(async () => {
    await moduleRef.close();
    await closeTestDb();
  });

  const entries = () => dlqModel.find({}).setOptions({ skipTenantScope: true }).lean().exec();
  const attempts = () => attemptModel.find({}).setOptions({ skipTenantScope: true }).lean().exec();
  const makeDue = (model: Model<DeadLetterEntryDocument> | Model<DeliveryAttemptDocument>) =>
    (model as Model<DeadLetterEntryDocument>)
      .updateMany({}, { $set: { nextRetryAt: new Date(Date.now() - 1000) } })
      .setOptions({ skipTenantScope: true })
      .exec();
  const runWebhookRetries = () =>
    (delivery as unknown as { processRetries: () => Promise<void> }).processRetries();

  /** The last of five attempts fails in the retry poller, outside any request. */
  async function exhaustDelivery(): Promise<string> {
    const attempt = await attemptModel.create({
      tenantId: A,
      subscriptionId: SUB._id,
      eventType: 'identity.created',
      eventId: 'evt-1',
      body: BODY,
      status: 'FAILED',
      attempts: 4,
      nextRetryAt: new Date(Date.now() - 1000),
    });
    post.mockRejectedValueOnce(new Error('connect ECONNREFUSED 203.0.113.7:443'));

    expect(requestContext.getStore()).toBeUndefined();
    await runWebhookRetries();
    return String(attempt._id);
  }

  it('dead-letters an exhausted delivery from the retry poller with what a retry needs', async () => {
    const deliveryId = await exhaustDelivery();

    const json = JSON.stringify(BODY);
    expect(post).toHaveBeenCalledWith(SUB.webhook.url, json, {
      headers: expect.objectContaining({
        'X-EuroID-Delivery': deliveryId,
        'X-EuroID-Event': 'identity.created',
        'X-EuroID-Signature': `sha256=${createHmac('sha256', SECRET).update(json).digest('hex')}`,
      }),
    });
    expect(await attempts()).toMatchObject([{ status: 'FAILED', attempts: 5 }]);

    const [entry] = await entries();
    expect(entry).toMatchObject({
      tenantId: A,
      type: 'event_handler_failure',
      source: `webhook:${SUB._id}:identity.created`,
      handler: 'EventDeliveryService.handleDeliveryRetry',
      status: 'pending',
      retryCount: 0,
      originalPayload: {
        type: 'webhook.delivery_retry',
        payload: {
          subscriptionId: SUB._id,
          deliveryId,
          eventType: 'identity.created',
          eventId: 'evt-1',
          body: BODY,
        },
        metadata: expect.objectContaining({ tenantId: A }),
      },
    });
    expect(entry.error.message).toBe(
      'connect ECONNREFUSED 203.0.113.7:443 (after 5 delivery attempts)',
    );
    // The URL embeds the receiver's token; the retry reads it from the subscription instead.
    expect(JSON.stringify(entry)).not.toContain('token-123');
  });

  it("re-delivers the stored body on the DLQ's automatic retry and closes the entry", async () => {
    const deliveryId = await exhaustDelivery();
    post.mockResolvedValue({ status: 202 });
    await makeDue(dlqModel);

    await dlq.processAutoRetries();

    expect(post).toHaveBeenLastCalledWith(SUB.webhook.url, JSON.stringify(BODY), {
      headers: expect.objectContaining({ 'X-EuroID-Delivery': deliveryId }),
    });
    expect(await entries()).toMatchObject([
      { status: 'replayed', resolvedBy: 'auto-retry-poller' },
    ]);
    expect(await attempts()).toMatchObject([{ status: 'DELIVERED', httpStatus: 202, attempts: 6 }]);
  });

  it('keeps the entry pending with the reason while the receiver or the subscription is gone', async () => {
    await exhaustDelivery();
    post.mockRejectedValue(new Error('Request failed with status code 503'));
    await makeDue(dlqModel);

    await dlq.processAutoRetries();
    const [afterOutage] = await entries();
    expect(afterOutage).toMatchObject({ status: 'pending', retryCount: 1 });
    expect(afterOutage.lastRetryError).toContain('status code 503');

    subscriptions.getActiveSubscriptionsForEvent.mockResolvedValue([]);
    await makeDue(dlqModel);
    await dlq.processAutoRetries();
    const [afterRemoval] = await entries();
    expect(afterRemoval).toMatchObject({ status: 'pending', retryCount: 2 });
    expect(afterRemoval.lastRetryError).toContain('no longer active');
    expect(await attempts()).toMatchObject([{ status: 'FAILED' }]);
  });

  it("answers an admin's retry with the outcome, in the admin's tenant", async () => {
    await exhaustDelivery();
    post.mockResolvedValue({ status: 200 });
    const [entry] = await entries();

    const outcome = await withTenantContext(A, () =>
      dlq.retryEntry(String(entry._id), 'admin@a.example'),
    );

    expect(outcome).toMatchObject({ status: 'replayed', retryCount: 0 });
    await expect(
      withTenantContext(B, () => dlq.retryEntry(String(entry._id), 'admin@b.example')),
    ).rejects.toThrow(/not found/);
  });

  it('captures outside any tenant context, under the entry tenant, without a tenant in its error', async () => {
    expect(requestContext.getStore()).toBeUndefined();

    await dlq.capture({
      type: 'event_handler_failure',
      source: 'identity.created',
      originalPayload: { type: 'identity.created', metadata: { tenantId: B } },
      error: { message: 'outbox publish failed', stack: 'Error: outbox publish failed' },
      tenantId: B,
    });
    // A request in another tenant does not move an entry that names its own.
    await withTenantContext(A, () =>
      dlq.capture({
        type: 'event_handler_failure',
        source: 'identity.created',
        originalPayload: { type: 'identity.created', metadata: { tenantId: B } },
        error: { message: 'second' },
        tenantId: B,
      }),
    );

    const stored = await entries();
    expect(stored).toHaveLength(2);
    expect(stored.map((e) => e.tenantId)).toEqual([B, B]);
    expect(stored[0].error).toEqual({
      message: 'outbox publish failed',
      stack: 'Error: outbox publish failed',
    });
  });

  it('stores the body on the first attempt and re-sends that body on a later one', async () => {
    post.mockRejectedValueOnce(new Error('timeout'));

    await delivery.handleDomainEvent({
      eventId: 'evt-2',
      type: 'identity.created' as never,
      aggregateId: 'id-2',
      timestamp: '2026-11-22T11:00:00.000Z',
      payload: { identityId: 'id-2', email: 'matti@corp.example' },
      metadata: {
        correlationId: 'c-2',
        depth: 0,
        emittedBy: 'test',
        actor: 'system',
        tenantId: A,
      },
    });
    // deliverWebhook runs detached from handleDomainEvent.
    for (let i = 0; i < 20 && post.mock.calls.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    for (let i = 0; i < 20 && (await attempts())[0]?.attempts !== 1; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const [first] = await attempts();
    expect(first.body).toEqual({
      eventId: 'evt-2',
      eventType: 'identity.created',
      timestamp: '2026-11-22T11:00:00.000Z',
      aggregateId: 'id-2',
      payload: { identityId: 'id-2' },
    });

    post.mockResolvedValue({ status: 200 });
    await makeDue(attemptModel);
    await runWebhookRetries();

    expect(post).toHaveBeenLastCalledWith(
      SUB.webhook.url,
      JSON.stringify(first.body),
      expect.anything(),
    );
    expect(JSON.stringify(post.mock.calls)).not.toContain('matti@corp.example');
  });
});
