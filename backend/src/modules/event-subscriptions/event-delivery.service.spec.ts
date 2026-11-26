import { createHmac } from 'crypto';
import * as dns from 'dns';
import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { AxiosError, type AxiosInstance, type AxiosResponse } from 'axios';
import { EventDeliveryService } from './event-delivery.service';
import { EventSubscriptionService, WEBHOOK_URL_REFUSED } from './event-subscription.service';
import { DeliveryAttempt } from './schemas/delivery-attempt.schema';
import { EventSubscriptionDocument } from './schemas/event-subscription.schema';
import { EncryptionService } from '@infrastructure/secrets/encryption.service';
import { DeadLetterService } from '../dead-letter/dead-letter.service';
import { DomainEvent } from '@infrastructure/events/domain-event.interface';
import { DomainEventType } from '@infrastructure/events/event-types';
import { TenantStatusService } from '@infrastructure/multi-tenancy/tenant-status.service';
import {
  STOPPED_BEFORE_CONNECT,
  stubOutboundConnections,
  v4,
  type OutboundConnect,
} from '@testing/stub-outbound-connect';

describe('EventDeliveryService', () => {
  let service: EventDeliveryService;
  let subscriptionService: { getActiveSubscriptionsForEvent: jest.Mock };
  let encryptionService: { decrypt: jest.Mock };
  let deadLetterService: { capture: jest.Mock };
  let tenantStatus: { isActive: jest.Mock };
  let deliveryModel: Record<string, jest.Mock>;

  beforeEach(async () => {
    subscriptionService = {
      getActiveSubscriptionsForEvent: jest.fn().mockResolvedValue([]),
    };
    encryptionService = {
      decrypt: jest.fn().mockResolvedValue('test-signing-secret'),
    };
    deadLetterService = { capture: jest.fn().mockResolvedValue(undefined) };
    tenantStatus = { isActive: jest.fn().mockResolvedValue(true) };
    deliveryModel = {
      // The insert claims the delivery: no delivery of the event to the subscription yet
      create: jest.fn().mockResolvedValue({
        _id: 'attempt-1',
        attempts: 0,
        tenantId: 'test-tenant',
        eventType: 'identity.created',
        eventId: 'evt-1',
      }),
      // The outcome of a send, written while the sending process holds the attempt (2.0dl).
      updateOne: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue({ matchedCount: 1 }),
      }),
    };

    const configService = {
      get: jest.fn().mockImplementation((key: string) => {
        if (key === 'eventSubscriptions.WEBHOOK_DELIVERY_TIMEOUT_MS') return 5000;
        if (key === 'eventSubscriptions.WEBHOOK_MAX_RETRY_ATTEMPTS') return 5;
        return undefined;
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EventDeliveryService,
        {
          provide: getModelToken(DeliveryAttempt.name),
          useValue: deliveryModel,
        },
        {
          provide: EventSubscriptionService,
          useValue: subscriptionService,
        },
        { provide: EncryptionService, useValue: encryptionService },
        { provide: DeadLetterService, useValue: deadLetterService },
        { provide: ConfigService, useValue: configService },
        { provide: TenantStatusService, useValue: tenantStatus },
      ],
    }).compile();

    service = module.get(EventDeliveryService);
    // Don't start the retry poller in tests
    service.onModuleDestroy();
  });

  afterEach(() => {
    service.onModuleDestroy();
  });

  const makeEvent = (
    type: string = 'identity.created',
    overrides: Partial<DomainEvent> = {},
  ): DomainEvent => ({
    eventId: 'evt-1',
    type: type as DomainEventType,
    aggregateId: 'id-123',
    timestamp: new Date().toISOString(),
    payload: { identityId: 'id-123', email: 'should-be-filtered@test.com' },
    metadata: {
      correlationId: 'corr-1',
      depth: 0,
      emittedBy: 'IdentityService',
      actor: 'system',
      tenantId: 'test-tenant',
    },
    ...overrides,
  });

  describe('handleDomainEvent', () => {
    it('skips webhook.* events to prevent loops', async () => {
      await service.handleDomainEvent(makeEvent('webhook.delivery_failed'));
      expect(subscriptionService.getActiveSubscriptionsForEvent).not.toHaveBeenCalled();
    });

    it('skips dlq.* events to prevent loops', async () => {
      await service.handleDomainEvent(makeEvent('dlq.entry_retried'));
      expect(subscriptionService.getActiveSubscriptionsForEvent).not.toHaveBeenCalled();
    });

    it('skips events without tenantId', async () => {
      const event = makeEvent();
      event.metadata.tenantId = '';
      await service.handleDomainEvent(event);
      expect(subscriptionService.getActiveSubscriptionsForEvent).not.toHaveBeenCalled();
    });

    // A suspended or deprovisioned tenant gets no webhooks (hunt 07 F1): its events are not
    // delivered and no attempt is stored, so nothing is sent after a reactivation either.
    it('delivers nothing and stores no attempt for a tenant that is not active', async () => {
      tenantStatus.isActive.mockResolvedValue(false);

      await service.handleDomainEvent(makeEvent('identity.created'));
      await new Promise((resolve) => setImmediate(resolve));

      expect(tenantStatus.isActive).toHaveBeenCalledWith('test-tenant');
      expect(subscriptionService.getActiveSubscriptionsForEvent).not.toHaveBeenCalled();
      expect(deliveryModel.create).not.toHaveBeenCalled();
    });

    it('looks up active subscriptions for matching events', async () => {
      await service.handleDomainEvent(makeEvent('identity.created'));
      expect(subscriptionService.getActiveSubscriptionsForEvent).toHaveBeenCalledWith(
        'identity.created',
        'test-tenant',
      );
    });

    /**
     * 2.0dl: filters.severityMin was stored and answered but no delivery read it. drift.detected
     * carries LOW..CRITICAL, anomaly.detected the same levels in lower case.
     */
    describe('filters.severityMin', () => {
      const withMinimum = (severityMin?: string) => ({
        _id: 'sub-1',
        tenantId: 'test-tenant',
        status: 'ACTIVE',
        filters: { eventTypes: ['*'], ...(severityMin ? { severityMin } : {}) },
        webhook: { url: 'https://hooks.example/euroid', signingSecret: 'enc', headers: {} },
      });
      const delivered = async (severityMin: string | undefined, event: DomainEvent) => {
        jest
          .spyOn((service as unknown as { http: AxiosInstance }).http, 'post')
          .mockResolvedValue({ status: 200 });
        subscriptionService.getActiveSubscriptionsForEvent.mockResolvedValue([
          withMinimum(severityMin),
        ]);
        await service.handleDomainEvent(event);
        await new Promise((resolve) => setImmediate(resolve)); // the delivery runs detached
        return deliveryModel.create.mock.calls.length > 0;
      };
      const severe = (type: string, severity: string) =>
        makeEvent(type, { payload: { identityId: 'id-123', severity } });

      // The levels themselves: meetsSeverityMin in subscription-filters.spec.ts
      it.each([
        { minimum: 'HIGH', severity: 'MEDIUM', expected: false },
        { minimum: 'HIGH', severity: 'HIGH', expected: true },
      ])(
        'severityMin $minimum, drift.detected of severity $severity: delivered $expected',
        async ({ minimum, severity, expected }) => {
          await expect(delivered(minimum, severe('drift.detected', severity))).resolves.toBe(
            expected,
          );
        },
      );

      it('always delivers an event type that carries no severity', async () => {
        await expect(delivered('CRITICAL', makeEvent('identity.created'))).resolves.toBe(true);
      });
    });

    // The unique { subscriptionId, eventId } index refuses a second attempt: a redelivered event,
    // or one another process handles at the same time, is not posted again (hunt 07 F12).
    it('posts nothing and logs no error when the delivery of the event already exists', async () => {
      const post = jest
        .spyOn((service as unknown as { http: AxiosInstance }).http, 'post')
        .mockResolvedValue({ status: 200 });
      const error = jest.spyOn((service as unknown as { logger: Logger }).logger, 'error');
      deliveryModel.create.mockRejectedValue(
        Object.assign(new Error('E11000 duplicate key error'), { code: 11000 }),
      );
      subscriptionService.getActiveSubscriptionsForEvent.mockResolvedValue([
        {
          _id: 'sub-1',
          tenantId: 'test-tenant',
          status: 'ACTIVE',
          filters: { eventTypes: ['*'] },
          webhook: { url: 'https://hooks.example/euroid', signingSecret: 'enc', headers: {} },
        },
      ]);

      await service.handleDomainEvent(makeEvent('identity.created'));
      await new Promise((resolve) => setImmediate(resolve)); // the delivery runs detached

      expect(deliveryModel.create).toHaveBeenCalledTimes(1);
      expect(post).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    });
  });

  describe('handleDeliveryRetry (dead-letter retry of an exhausted delivery)', () => {
    const retryEvent = (payload: Record<string, unknown>) =>
      ({
        ...makeEvent('webhook.delivery_retry'),
        payload,
      }) as unknown as Parameters<EventDeliveryService['handleDeliveryRetry']>[0];
    const RETRY = {
      subscriptionId: 'sub-1',
      deliveryId: 'attempt-1',
      eventType: 'identity.created',
      eventId: 'evt-1',
      body: { eventId: 'evt-1', eventType: 'identity.created', payload: { identityId: 'id-123' } },
    };

    it('fails, so the DLQ counts the attempt, when the stored event has nothing to deliver', async () => {
      await expect(
        service.handleDeliveryRetry(retryEvent({ subscriptionId: 'sub-1' })),
      ).rejects.toThrow(/nothing to re-deliver/);
      expect(subscriptionService.getActiveSubscriptionsForEvent).not.toHaveBeenCalled();
    });

    it('fails without posting while the tenant is not active, so the DLQ counts the attempt', async () => {
      tenantStatus.isActive.mockResolvedValue(false);

      await expect(service.handleDeliveryRetry(retryEvent(RETRY))).rejects.toThrow(
        /tenant test-tenant is not active/,
      );
      expect(subscriptionService.getActiveSubscriptionsForEvent).not.toHaveBeenCalled();
      expect(encryptionService.decrypt).not.toHaveBeenCalled();
    });

    it('fails when the subscription is no longer active for the event, without posting', async () => {
      subscriptionService.getActiveSubscriptionsForEvent.mockResolvedValue([{ _id: 'sub-2' }]);

      await expect(service.handleDeliveryRetry(retryEvent(RETRY))).rejects.toThrow(
        /sub-1 is no longer active/,
      );
      expect(subscriptionService.getActiveSubscriptionsForEvent).toHaveBeenCalledWith(
        'identity.created',
        'test-tenant',
      );
      expect(encryptionService.decrypt).not.toHaveBeenCalled();
    });
  });

  describe('sendTestDelivery (POST /event-subscriptions/:id/test)', () => {
    // A paused subscription can be tested before it is resumed.
    const SUB = {
      _id: 'sub-1',
      name: 'SIEM',
      status: 'PAUSED',
      filters: { eventTypes: ['identity.created'] },
      webhook: {
        url: 'https://hooks.example/euroid',
        signingSecret: 'enc',
        headers: { 'X-Team': 'security' },
      },
    } as unknown as EventSubscriptionDocument;
    const answered = (status: number) =>
      new AxiosError(
        `Request failed with status code ${status}`,
        'ERR_BAD_RESPONSE',
        undefined,
        {},
        {
          status,
        } as AxiosResponse,
      );
    let post: jest.SpyInstance;

    beforeEach(() => {
      post = jest.spyOn((service as unknown as { http: AxiosInstance }).http, 'post');
    });

    it('posts a signed webhook.test body with ids only and answers the status the receiver gave', async () => {
      post.mockResolvedValue({ status: 204 });

      const result = await service.sendTestDelivery(SUB);

      expect(post).toHaveBeenCalledTimes(1);
      const [url, json, config] = post.mock.calls[0] as [
        string,
        string,
        { headers: Record<string, string>; maxRedirects?: number },
      ];
      expect(url).toBe('https://hooks.example/euroid');
      expect(JSON.parse(json)).toEqual({
        eventId: expect.any(String),
        eventType: 'webhook.test',
        timestamp: expect.any(String),
        aggregateId: 'sub-1',
        payload: {},
      });
      const signature = createHmac('sha256', 'test-signing-secret').update(json).digest('hex');
      expect(config.headers).toEqual(
        expect.objectContaining({
          'X-EuroID-Signature': `sha256=${signature}`,
          'X-EuroID-Event': 'webhook.test',
          'X-EuroID-Delivery': result.deliveryId,
          'X-Team': 'security',
        }),
      );
      expect(result).toEqual({
        success: true,
        subscriptionId: 'sub-1',
        deliveryId: expect.any(String),
        eventType: 'webhook.test',
        httpStatus: 204,
        message: 'Delivered: the receiver answered 204.',
      });
      // A test is not a delivery: no attempt is stored, so nothing is retried or dead-lettered.
      expect(deliveryModel.create).not.toHaveBeenCalled();
      expect(deliveryModel.updateOne).not.toHaveBeenCalled();
      expect(deadLetterService.capture).not.toHaveBeenCalled();
    });

    it('answers a refused delivery with the status and error instead of failing the request', async () => {
      post.mockRejectedValue(answered(500));

      await expect(service.sendTestDelivery(SUB)).resolves.toEqual(
        expect.objectContaining({
          success: false,
          httpStatus: 500,
          error: 'Request failed with status code 500',
          message: 'Not delivered: Request failed with status code 500',
        }),
      );
      expect(deadLetterService.capture).not.toHaveBeenCalled();
    });

    it('answers an unreachable receiver with the error and no status', async () => {
      post.mockRejectedValue(new Error('connect ECONNREFUSED 203.0.113.7:443'));

      const result = await service.sendTestDelivery(SUB);

      expect(result).toEqual(
        expect.objectContaining({ success: false, error: 'connect ECONNREFUSED 203.0.113.7:443' }),
      );
      expect(result).not.toHaveProperty('httpStatus');
    });

    // The test answers the receiver's status on demand: following a redirect would let it probe a
    // host the URL check on save never saw.
    it('does not follow a redirect and says the test stopped there', async () => {
      post.mockRejectedValue(answered(302));

      const result = await service.sendTestDelivery(SUB);

      // Set on the client every delivery uses (2.0dx), not only on the test's request.
      expect((service as unknown as { http: AxiosInstance }).http.defaults.maxRedirects).toBe(0);
      expect(result).toEqual(
        expect.objectContaining({
          success: false,
          httpStatus: 302,
          error:
            'The receiver answered with a redirect (302). The test does not follow redirects: use the URL it redirects to.',
        }),
      );
    });
  });

  const deliver = (sub: EventSubscriptionDocument, event: DomainEvent) =>
    (
      service as unknown as {
        deliverWebhook: (s: EventSubscriptionDocument, e: DomainEvent) => Promise<void>;
      }
    ).deliverWebhook(sub, event);
  /** The fields the last outcome written to the attempt sets. */
  const lastAttemptUpdate = () => {
    const { calls } = deliveryModel.updateOne.mock;
    const update = calls[calls.length - 1]?.[1] as { $set?: Record<string, unknown> } | undefined;
    return update?.$set;
  };
  const subscription = (webhook: Record<string, unknown>) =>
    ({
      _id: 'sub-1',
      tenantId: 'test-tenant',
      name: 'SIEM',
      status: 'ACTIVE',
      filters: { eventTypes: ['identity.created'] },
      webhook: {
        url: 'https://hooks.example/euroid',
        signingSecret: 'enc',
        headers: {},
        ...webhook,
      },
    }) as unknown as EventSubscriptionDocument;

  /**
   * 2.0dx: deliveries followed redirects and resolved the host again at send time, so a URL that
   * was public when saved could reach a private or metadata address. Real axios and the service's
   * real HTTPS agent; DNS answers are stubbed and the TLS connect is stopped right after the
   * agent's lookup, so nothing reaches the network.
   */
  describe('where a delivery connects', () => {
    let connects: OutboundConnect[];
    let answerDns: ReturnType<typeof stubOutboundConnections>['answerDns'];

    beforeEach(() => {
      ({ connects, answerDns } = stubOutboundConnections());
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('connects to the address its lookup checked, with TLS verified for the URL host', async () => {
      answerDns([v4('93.184.215.14')]);

      await deliver(subscription({}), makeEvent());

      expect(connects).toEqual([
        expect.objectContaining({
          host: 'hooks.example',
          servername: 'hooks.example',
          addresses: [v4('93.184.215.14')],
        }),
      ]);
      expect(connects[0]!.rejectUnauthorized).not.toBe(false);
      // One resolution: the answer the guard checked is the one the socket connects to.
      expect(dns.lookup).toHaveBeenCalledTimes(1);
      expect(lastAttemptUpdate()).toEqual(
        expect.objectContaining({ status: 'FAILED', lastError: STOPPED_BEFORE_CONNECT }),
      );
    });

    it('refuses a host that answered a public address before and a private one at send time', async () => {
      answerDns([v4('93.184.215.14')], [v4('10.0.0.5')]);
      const sub = subscription({});

      await deliver(sub, makeEvent());
      await deliver(sub, makeEvent());

      expect(connects[0]!.addresses).toEqual([v4('93.184.215.14')]);
      expect(connects[1]!.addresses).toBeUndefined();
      const update = lastAttemptUpdate()!;
      expect(update).toEqual(expect.objectContaining({ status: 'FAILED', attempts: 1 }));
      expect(update.lastError).toMatch(/Refused to connect to hooks\.example/);
      expect(update.lastError).not.toContain('10.0.0.5');
      expect(update.nextRetryAt).toBeInstanceOf(Date);
    });

    it('refuses a host with several addresses when one of them is the metadata address', async () => {
      answerDns([v4('93.184.215.14'), v4('169.254.169.254')]);

      await deliver(subscription({}), makeEvent());

      expect(connects).toHaveLength(1);
      expect(connects[0]!.addresses).toBeUndefined();
      expect(lastAttemptUpdate()?.lastError).toMatch(/Refused to connect to hooks\.example/);
    });

    // A URL saved before the guard knew the hex IPv4-mapped form; net never looks an IP up.
    it.each(['https://[::ffff:7f00:1]/hook', 'https://[::]/hook', 'http://hooks.example/hook'])(
      'sends nothing to a stored URL the guard now refuses (%s)',
      async (url) => {
        await deliver(subscription({ url }), makeEvent());

        expect(connects).toEqual([]);
        expect(dns.lookup).not.toHaveBeenCalled();
        expect(lastAttemptUpdate()).toEqual(
          expect.objectContaining({
            status: 'FAILED',
            lastError: `Not sent: ${WEBHOOK_URL_REFUSED}`,
          }),
        );
      },
    );

    it('answers a test delivery to a host that resolves to a private address as not delivered', async () => {
      answerDns([v4('192.168.1.10')]);

      const result = await service.sendTestDelivery(subscription({}));

      expect(result).toEqual(
        expect.objectContaining({
          success: false,
          error: expect.stringMatching(/^Refused to connect/),
        }),
      );
      expect(result).not.toHaveProperty('httpStatus');
    });

    it('fails a dead-letter retry to a host that resolves to a private address', async () => {
      answerDns([v4('127.0.0.1')]);
      subscriptionService.getActiveSubscriptionsForEvent.mockResolvedValue([subscription({})]);

      await expect(
        service.handleDeliveryRetry({
          ...makeEvent('webhook.delivery_retry'),
          payload: {
            subscriptionId: 'sub-1',
            deliveryId: 'attempt-1',
            eventType: 'identity.created',
            eventId: 'evt-1',
            body: { eventId: 'evt-1' },
          },
        } as unknown as Parameters<EventDeliveryService['handleDeliveryRetry']>[0]),
      ).rejects.toThrow(/Refused to connect to hooks\.example/);
    });

    it('follows no redirect and uses no proxy from the environment', () => {
      const { defaults } = (service as unknown as { http: AxiosInstance }).http;

      expect(defaults.maxRedirects).toBe(0);
      expect(defaults.proxy).toBe(false);
    });
  });

  describe('a delivery the receiver answers with a redirect', () => {
    it('fails with an error saying redirects are not followed, and retries later', async () => {
      const post = jest.spyOn((service as unknown as { http: AxiosInstance }).http, 'post');
      post.mockRejectedValue(
        new AxiosError('Request failed with status code 301', 'ERR_BAD_RESPONSE', undefined, {}, {
          status: 301,
        } as AxiosResponse),
      );

      await deliver(subscription({}), makeEvent());

      expect(post).toHaveBeenCalledTimes(1);
      expect(lastAttemptUpdate()).toEqual(
        expect.objectContaining({
          status: 'FAILED',
          httpStatus: 301,
          lastError:
            'The receiver answered with a redirect (301). Deliveries do not follow redirects: use the URL it redirects to.',
          nextRetryAt: expect.any(Date),
        }),
      );
    });
  });

  /**
   * 2.0dx: custom header names were not validated and were applied after the signature, so a
   * stored header could replace X-EuroID-Signature, Content-Type or Host. Names are validated on
   * save now; a subscription stored earlier with a header EuroID refuses is not delivered (the
   * delivery fails with the reason, is retried and dead-lettered like any failure).
   */
  describe('custom headers of a stored subscription', () => {
    let post: jest.SpyInstance;

    beforeEach(() => {
      post = jest.spyOn((service as unknown as { http: AxiosInstance }).http, 'post');
      post.mockResolvedValue({ status: 200 });
    });

    it('sends valid custom headers and EuroID signs the body', async () => {
      await deliver(
        subscription({ headers: new Map([['Authorization', 'Bearer receiver-token']]) }),
        makeEvent(),
      );

      const [, json, config] = post.mock.calls[0] as [
        string,
        string,
        { headers: Record<string, string> },
      ];
      expect(config.headers).toEqual({
        Authorization: 'Bearer receiver-token',
        'Content-Type': 'application/json',
        'X-EuroID-Signature': `sha256=${createHmac('sha256', 'test-signing-secret').update(json).digest('hex')}`,
        'X-EuroID-Event': 'identity.created',
        'X-EuroID-Delivery': 'attempt-1',
      });
      expect(lastAttemptUpdate()).toEqual(expect.objectContaining({ status: 'DELIVERED' }));
    });

    it.each([
      ['X-EuroID-Signature', 'sha256=forged'],
      ['x-euroid-delivery', 'replayed'],
      ['Content-Type', 'text/plain'],
      ['Host', 'internal.example'],
      ['Content-Length', '0'],
      ['X Team', 'security'],
      ['X-Team:', 'security'],
    ])('does not send a delivery with the stored header %p, and says why', async (name, value) => {
      await expect(
        deliver(subscription({ headers: new Map([[name, value]]) }), makeEvent()),
      ).resolves.toBeUndefined();

      expect(post).not.toHaveBeenCalled();
      const update = lastAttemptUpdate()!;
      expect(update).toEqual(
        expect.objectContaining({ status: 'FAILED', attempts: 1, nextRetryAt: expect.any(Date) }),
      );
      expect(update.lastError).toContain(`custom header "${name}"`);
      expect(update.lastError).toContain('Edit the subscription');
      expect(update.lastError).not.toContain(value);
    });

    it('does not send a header value with a line break, without echoing it', async () => {
      await deliver(
        subscription({ headers: { 'X-Team': 'security\r\nX-Injected: 1' } }),
        makeEvent(),
      );

      expect(post).not.toHaveBeenCalled();
      expect(lastAttemptUpdate()?.lastError).toContain('custom header "X-Team"');
      expect(lastAttemptUpdate()?.lastError).not.toContain('X-Injected');
    });

    it('answers a test delivery with such a header as not delivered, with the reason', async () => {
      const result = await service.sendTestDelivery(
        subscription({ headers: { 'X-EuroID-Signature': 'sha256=forged' } }),
      );

      expect(post).not.toHaveBeenCalled();
      expect(result).toEqual(
        expect.objectContaining({
          success: false,
          error: expect.stringContaining('custom header "X-EuroID-Signature"'),
        }),
      );
    });
  });

  describe('getRetryDelayMs', () => {
    it('computes exponential backoff: 1s, 5s, 25s, 125s, 625s', () => {
      expect(service.getRetryDelayMs(1)).toBe(1000);
      expect(service.getRetryDelayMs(2)).toBe(5000);
      expect(service.getRetryDelayMs(3)).toBe(25000);
      expect(service.getRetryDelayMs(4)).toBe(125000);
      expect(service.getRetryDelayMs(5)).toBe(625000);
    });
  });
});
