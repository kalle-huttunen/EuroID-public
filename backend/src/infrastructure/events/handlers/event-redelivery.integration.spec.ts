/**
 * A domain event delivered again writes nothing again: one audit entry, one timeline entry and
 * one webhook delivery per event. On in-memory MongoDB with the real AuditService,
 * UserEventService and EventDeliveryService; the webhook POST is a spy.
 *
 * An event is delivered again when the outbox poller takes over a claim whose process stopped
 * before it published (OUTBOX_CLAIM_TIMEOUT_MS), or when a dead-letter replay re-emits it to every
 * handler. Before, each delivery added an audit entry and a timeline entry and sent the webhook
 * again.
 *
 * Proves: a second delivery of the same event, after the first or at the same time, adds no audit
 * entry (and the hash chain stays valid), no timeline entry and no webhook delivery or POST; a
 * different event still gets its own.
 */
import mongoose, { Model } from 'mongoose';
import type { AxiosInstance } from 'axios';
import type { ConfigService } from '@nestjs/config';
import { tenantPlugin } from '@infrastructure/multi-tenancy/tenant.plugin';
import type { EncryptionService } from '@infrastructure/secrets/encryption.service';
import { connectTestDb, clearTestDb, closeTestDb } from '@testing';
import { DomainEventType } from '../event-types';
import type { DomainEvent } from '../domain-event.interface';
import type { IdentityCreatedPayload } from '../event-payloads';
import { AuditEventHandler } from './audit-event.handler';
import { UserTimelineHandler } from './user-timeline.handler';
import { AuditService } from '../../../modules/audit/audit.service';
import {
  AuditEvent,
  AuditEventDocument,
  AuditEventSchema,
} from '../../../modules/audit/schemas/audit-event.schema';
import {
  AuditChainHead,
  AuditChainHeadDocument,
  AuditChainHeadSchema,
} from '../../../modules/audit/schemas/audit-chain-head.schema';
import { UserEventService } from '../../../modules/identity/user-event.service';
import {
  UserEvent,
  UserEventDocument,
  UserEventSchema,
} from '../../../modules/identity/schemas/user-event.schema';
import { EventDeliveryService } from '../../../modules/event-subscriptions/event-delivery.service';
import { TenantStatusService } from '../../multi-tenancy/tenant-status.service';
import type { EventSubscriptionService } from '../../../modules/event-subscriptions/event-subscription.service';
import {
  DeliveryAttempt,
  DeliveryAttemptDocument,
  DeliveryAttemptSchema,
} from '../../../modules/event-subscriptions/schemas/delivery-attempt.schema';
import type { DeadLetterService } from '../../../modules/dead-letter/dead-letter.service';

// Tenant scoping as at runtime (TenantModule registers the plugin at import time)
mongoose.plugin(tenantPlugin);

const TENANT = 'tenant-a';

/** identity.created as the outbox poller publishes it. */
const created = (eventId: string): DomainEvent<IdentityCreatedPayload> =>
  ({
    eventId,
    type: DomainEventType.IDENTITY_CREATED,
    aggregateId: 'identity-1',
    timestamp: '2026-11-24T10:00:00.000Z',
    payload: { identityId: 'identity-1', sourceSystem: 'manual-ui', status: 'ACTIVE' },
    metadata: {
      correlationId: `corr-${eventId}`,
      depth: 0,
      emittedBy: 'DomainEventEmitterService',
      actor: 'admin',
      tenantId: TENANT,
    },
  }) as DomainEvent<IdentityCreatedPayload>;

/** The same event as the wildcard handlers (audit, webhooks) take it. */
const anyEvent = (eventId: string) => created(eventId) as unknown as DomainEvent;

const subscription = {
  _id: 'sub-1',
  tenantId: TENANT,
  name: 'SIEM',
  status: 'ACTIVE',
  filters: { eventTypes: ['identity.*'] },
  webhook: { url: 'https://hooks.example/euroid', signingSecret: 'enc', headers: {} },
};

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('A domain event delivered again (in-memory MongoDB)', () => {
  let audits: Model<AuditEventDocument>;
  let chainHeads: Model<AuditChainHeadDocument>;
  let timeline: Model<UserEventDocument>;
  let deliveries: Model<DeliveryAttemptDocument>;
  let auditService: AuditService;
  let auditHandler: AuditEventHandler;
  let timelineHandler: UserTimelineHandler;
  let webhooks: EventDeliveryService;
  let post: jest.SpyInstance;

  beforeAll(async () => {
    await connectTestDb();
    audits = mongoose.model(
      AuditEvent.name,
      AuditEventSchema,
    ) as unknown as Model<AuditEventDocument>;
    timeline = mongoose.model(
      UserEvent.name,
      UserEventSchema,
    ) as unknown as Model<UserEventDocument>;
    chainHeads = mongoose.model(
      AuditChainHead.name,
      AuditChainHeadSchema,
    ) as unknown as Model<AuditChainHeadDocument>;
    deliveries = mongoose.model(
      DeliveryAttempt.name,
      DeliveryAttemptSchema,
    ) as unknown as Model<DeliveryAttemptDocument>;
    // The unique indexes guard two deliveries at the same moment: built before the tests run
    await Promise.all([audits.init(), chainHeads.init(), timeline.init(), deliveries.init()]);

    auditService = new AuditService(audits, chainHeads);
    auditHandler = new AuditEventHandler(auditService);
    timelineHandler = new UserTimelineHandler(new UserEventService(timeline));
    webhooks = new EventDeliveryService(
      deliveries,
      {
        getActiveSubscriptionsForEvent: async () => [subscription],
      } as unknown as EventSubscriptionService,
      { decrypt: async () => 'signing-secret' } as unknown as EncryptionService,
      { capture: jest.fn() } as unknown as DeadLetterService,
      { get: () => undefined } as unknown as ConfigService,
      { isActive: async () => true } as unknown as TenantStatusService,
    );
    post = jest.spyOn((webhooks as unknown as { http: AxiosInstance }).http, 'post');
  });

  beforeEach(() => {
    post.mockReset().mockResolvedValue({ status: 200 });
  });

  afterEach(async () => {
    await clearTestDb();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('audits an event once and keeps the hash chain valid', async () => {
    await auditHandler.handleAll(anyEvent('evt-1'));
    await auditHandler.handleAll(anyEvent('evt-1'));
    // Two processes at the same moment: the unique index lets one entry in
    await Promise.all([
      auditHandler.handleAll(anyEvent('evt-2')),
      auditHandler.handleAll(anyEvent('evt-2')),
    ]);

    const stored = await audits.collection.find({}).sort({ _id: 1 }).toArray();
    expect(stored.map((entry) => entry.eventId)).toEqual(['evt-1', 'evt-2']);
    expect((await auditService.verifyIntegrity(TENANT)).valid).toBe(true);
  });

  it('puts an event on the identity timeline once', async () => {
    await timelineHandler.handleIdentityCreated(created('evt-1'));
    await timelineHandler.handleIdentityCreated(created('evt-1'));
    await Promise.all([
      timelineHandler.handleIdentityCreated(created('evt-2')),
      timelineHandler.handleIdentityCreated(created('evt-2')),
    ]);

    const stored = await timeline.collection.find({}).sort({ _id: 1 }).toArray();
    expect(stored.map((entry) => [entry.eventId, entry.type])).toEqual([
      ['evt-1', 'USER_CREATED'],
      ['evt-2', 'USER_CREATED'],
    ]);
  });

  it('sends an event to a webhook subscription once', async () => {
    await webhooks.handleDomainEvent(anyEvent('evt-1'));
    // deliverWebhook runs detached from handleDomainEvent
    for (let i = 0; i < 50; i++) {
      const sent = await deliveries.collection.findOne({ eventId: 'evt-1' });
      if (sent?.status === 'DELIVERED') break;
      await pause(10);
    }

    await webhooks.handleDomainEvent(anyEvent('evt-1'));
    await pause(200);

    expect(post).toHaveBeenCalledTimes(1);
    expect(await deliveries.collection.countDocuments({ eventId: 'evt-1' })).toBe(1);

    await webhooks.handleDomainEvent(anyEvent('evt-2'));
    for (let i = 0; i < 50 && post.mock.calls.length < 2; i++) await pause(10);
    expect(post).toHaveBeenCalledTimes(2);
  });
});
