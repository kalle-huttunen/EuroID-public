/**
 * HTTP contract of the webhook subscription routes (2.0dx). Before: list, get, create and update
 * answered `webhook.signingSecret` (the ciphertext) and `webhook.headers` with their values;
 * creating with a name in use answered 201 with the existing subscription unchanged; renaming onto
 * a used name was a 500; any header name was accepted. Real controller and service; the models,
 * encryption, delivery and URL check are stubs.
 */
import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  Injectable,
  NestMiddleware,
} from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, HttpAdapterHost } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import { mongo } from 'mongoose';
import * as request from 'supertest';
import { RolesGuard } from '@infrastructure/auth/roles.guard';
import { CorrelationMiddleware } from '@infrastructure/middleware/correlation.middleware';
import { TenantContextInterceptor } from '@infrastructure/multi-tenancy/tenant-context.interceptor';
import { EncryptionService } from '@infrastructure/secrets/encryption.service';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';
import { globalExceptionFilters } from '@shared/filters/global-exception-filters';
import { EventSubscriptionController } from './event-subscription.controller';
import { EventSubscriptionService } from './event-subscription.service';
import { EventDeliveryService } from './event-delivery.service';
import { EventSubscription } from './schemas/event-subscription.schema';
import { DeliveryAttempt } from './schemas/delivery-attempt.schema';

// The URL check resolves DNS; these tests are about the answers, not the guard.
jest.mock('@infrastructure/url-validation/ssrf-guard', () => ({
  ...jest.requireActual('@infrastructure/url-validation/ssrf-guard'),
  validateUrlForFetch: jest.fn().mockResolvedValue(undefined),
}));

/** Stand-in for JwtAuthGuard: a super-admin of tenant-a. */
@Injectable()
class TestAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    context.switchToHttp().getRequest().user = {
      sub: 'user-1',
      email: 'admin@tenant-a.example',
      roles: ['super-admin'],
      tenantId: 'tenant-a',
    };
    return true;
  }
}

const ID = '64b7f0c2a1b2c3d4e5f60730';
const CIPHERTEXT = 'euroid:v2:key-1:Zm9vYmFyYmF6cXV4';
const HEADER_VALUE = 'Bearer receiver-token-123';

/** As MongoDB stores it: the secret encrypted, header values in plain text. */
const stored = (overrides: Record<string, unknown> = {}) => ({
  _id: ID,
  tenantId: 'tenant-a',
  name: 'SIEM feed',
  type: 'WEBHOOK',
  status: 'ACTIVE',
  // The tenant plugin stores tenantId in the subdocuments too.
  filters: { eventTypes: ['identity.*'], tenantId: 'tenant-a' },
  webhook: {
    url: 'https://siem.example.com/hooks/euroid',
    headers: { Authorization: HEADER_VALUE },
    signingSecret: CIPHERTEXT,
    tenantId: 'tenant-a',
  },
  createdBy: 'admin@tenant-a.example',
  createdAt: '2026-11-20T09:00:00.000Z',
  updatedAt: '2026-11-20T09:00:00.000Z',
  __v: 0,
  ...overrides,
});

/** Every key of a JSON value, at any depth. */
const keysDeep = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.flatMap(keysDeep)
    : value && typeof value === 'object'
      ? Object.entries(value).flatMap(([key, child]) => [key, ...keysDeep(child)])
      : [];

const duplicateKey = () =>
  new mongo.MongoServerError({
    message:
      'E11000 duplicate key error collection: euroid.event_subscriptions index: tenantId_1_name_1 dup key',
    code: 11000,
  });

const chain = (result: unknown) => {
  const exec = jest.fn().mockResolvedValue(result);
  const lean = jest.fn().mockReturnValue({ exec });
  return { exec, lean, sort: jest.fn().mockReturnValue({ lean }) };
};

describe('Webhook subscription HTTP API', () => {
  let app: INestApplication;
  const model = {
    countDocuments: jest.fn(),
    create: jest.fn(),
    find: jest.fn(),
    findOne: jest.fn(),
    findOneAndUpdate: jest.fn(),
    findOneAndDelete: jest.fn(),
  };
  /** GET /:id/deliveries reads find().sort().skip().limit().lean().exec(). */
  const page = {
    sort: jest.fn(),
    skip: jest.fn(),
    limit: jest.fn(),
    lean: jest.fn(),
    exec: jest.fn(),
  };
  const deliveries = { find: jest.fn() };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [EventSubscriptionController],
      providers: [
        EventSubscriptionService,
        { provide: getModelToken(EventSubscription.name), useValue: model },
        { provide: getModelToken(DeliveryAttempt.name), useValue: deliveries },
        { provide: EventDeliveryService, useValue: { sendTestDelivery: jest.fn() } },
        { provide: EncryptionService, useValue: { encrypt: async () => CIPHERTEXT } },
        { provide: ConfigService, useValue: { get: () => undefined } },
        { provide: DomainEventEmitterService, useValue: { emit: jest.fn() } },
        { provide: APP_GUARD, useClass: TestAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
        { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    const correlation = new CorrelationMiddleware();
    app.use((req: Request, res: Response, next: NextFunction) =>
      (correlation as NestMiddleware).use(req, res, next),
    );
    app.useGlobalFilters(...globalExceptionFilters(app.get(HttpAdapterHost)));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    model.countDocuments.mockResolvedValue(1);
    model.find.mockReturnValue(chain([stored()]));
    model.findOne.mockReturnValue(chain(stored()));
    model.findOneAndUpdate.mockReturnValue(chain(stored({ name: 'SIEM feed v2' })));
    // A created document is hydrated: its headers are a Map.
    model.create.mockImplementation(async (doc: { webhook: Record<string, unknown> }) =>
      stored({
        ...doc,
        _id: ID,
        webhook: { ...doc.webhook, headers: new Map(Object.entries(doc.webhook.headers ?? {})) },
      }),
    );
  });

  describe('GET /event-subscriptions/:id/deliveries paging (hunt 07 F14)', () => {
    beforeEach(() => {
      for (const step of ['sort', 'skip', 'limit', 'lean'] as const) {
        page[step].mockReturnValue(page);
      }
      page.exec.mockResolvedValue([]);
      deliveries.find.mockReturnValue(page);
    });

    const list = (query: string) =>
      request(app.getHttpServer()).get(`/event-subscriptions/${ID}/deliveries${query}`);

    // A negative offset went to MongoDB as a negative skip (a 500); text fell back silently.
    it.each([
      '?offset=-1',
      '?offset=abc',
      '?offset=1.5',
      '?limit=0',
      '?limit=-5',
      '?limit=abc',
      '?limit=101',
    ])('%s answers 400 without reading any delivery', async (query) => {
      const res = await list(query);

      expect(res.status).toBe(400);
      expect(deliveries.find).not.toHaveBeenCalled();
    });

    it('pages newest first with the limit and offset given', async () => {
      const res = await list('?limit=21&offset=40');

      expect(res.status).toBe(200);
      expect(deliveries.find).toHaveBeenCalledWith({ subscriptionId: ID });
      expect(page.sort).toHaveBeenCalledWith({ createdAt: -1 });
      expect(page.skip).toHaveBeenCalledWith(40);
      expect(page.limit).toHaveBeenCalledWith(21);
    });

    it('defaults to the first 50', async () => {
      const res = await list('');

      expect(res.status).toBe(200);
      expect(page.skip).toHaveBeenCalledWith(0);
      expect(page.limit).toHaveBeenCalledWith(50);
    });
  });

  const NEW = {
    name: 'Ticketing',
    filters: { eventTypes: ['provisioning.failed'] },
    webhook: {
      url: 'https://tickets.example.com/in',
      headers: { Authorization: HEADER_VALUE },
      signingSecret: 'a-long-enough-secret-123',
    },
  };

  /** The answer has the subscription without any secret: no such key, no such text. */
  const expectNoSecrets = (body: unknown) => {
    expect(keysDeep(body)).not.toContain('signingSecret');
    expect(keysDeep(body)).not.toContain('headers');
    const text = JSON.stringify(body);
    expect(text).not.toContain(CIPHERTEXT);
    expect(text).not.toContain(HEADER_VALUE);
    expect(text).not.toContain('a-long-enough-secret-123');
  };

  it.each([
    ['GET /event-subscriptions', () => request(app.getHttpServer()).get('/event-subscriptions')],
    [
      'GET /event-subscriptions/:id',
      () => request(app.getHttpServer()).get(`/event-subscriptions/${ID}`),
    ],
    [
      'POST /event-subscriptions',
      () => request(app.getHttpServer()).post('/event-subscriptions').send(NEW),
    ],
    [
      'PATCH /event-subscriptions/:id',
      () =>
        request(app.getHttpServer())
          .patch(`/event-subscriptions/${ID}`)
          .send({ name: 'SIEM feed v2', webhook: { headers: { Authorization: null } } }),
    ],
  ])('%s answers no signing secret and no header value', async (_route, send) => {
    const res = await send();

    expect(res.status).toBeLessThan(300);
    expectNoSecrets(res.body);
    const subs = Array.isArray(res.body) ? res.body : [res.body];
    for (const sub of subs) {
      // Only the subscription's own tenantId: none from the subdocuments.
      expect(keysDeep(sub).filter((key) => key === 'tenantId')).toHaveLength(1);
      expect(sub.filters).toEqual({ eventTypes: expect.any(Array) });
      expect(sub.webhook).toEqual({
        url: expect.stringMatching(/^https:\/\//),
        headerNames: ['Authorization'],
        hasSigningSecret: true,
      });
    }
  });

  it('answers 409 to a create with a name in use and stores nothing new', async () => {
    model.create.mockRejectedValue(duplicateKey());

    const res = await request(app.getHttpServer())
      .post('/event-subscriptions')
      .send({ ...NEW, name: 'SIEM feed' });

    expect(res.status).toBe(409);
    expect(res.body.message).toBe('A webhook subscription named "SIEM feed" already exists.');
    expectNoSecrets(res.body);
  });

  it('answers 409 to a rename onto a name in use', async () => {
    model.findOneAndUpdate.mockReturnValue({
      lean: () => ({ exec: () => Promise.reject(duplicateKey()) }),
    });

    const res = await request(app.getHttpServer())
      .patch(`/event-subscriptions/${ID}`)
      .send({ name: 'Ticketing' });

    expect(res.status).toBe(409);
    expect(res.body.message).toBe('A webhook subscription named "Ticketing" already exists.');
  });

  it.each(['X-EuroID-Signature', 'Host', 'Content-Type', 'a.b', '$where', 'X Team'])(
    'answers 400 to a custom header named %p and stores nothing',
    async (name) => {
      const res = await request(app.getHttpServer())
        .post('/event-subscriptions')
        .send({ ...NEW, webhook: { ...NEW.webhook, headers: { [name]: 'value' } } });

      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body.message)).toContain(`webhook.headers.${name}`);
      expect(model.create).not.toHaveBeenCalled();
    },
  );
});
