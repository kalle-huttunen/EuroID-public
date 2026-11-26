import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { ZodError } from 'zod';
import { EventSubscriptionService, WEBHOOK_URL_REFUSED } from './event-subscription.service';
import { EventSubscription } from './schemas/event-subscription.schema';
import { EncryptionService } from '@infrastructure/secrets/encryption.service';
import { DomainEventEmitterService } from '@infrastructure/events/event-emitter.service';

// Mock tenant context
jest.mock('@infrastructure/multi-tenancy/tenant-context.helper', () => ({
  getCurrentTenantId: () => 'test-tenant',
}));

// Mock SSRF validation
jest.mock('@infrastructure/url-validation/ssrf-guard', () => ({
  validateUrlForFetch: jest.fn().mockResolvedValue(undefined),
}));

import { validateUrlForFetch } from '@infrastructure/url-validation/ssrf-guard';

const TEST_TENANT = 'test-tenant';

function createMockModel() {
  const mockModel: Record<string, jest.Mock> = {
    create: jest.fn(),
    countDocuments: jest.fn().mockResolvedValue(0),
    find: jest.fn().mockReturnValue({
      sort: jest.fn().mockReturnValue({
        lean: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue([]),
        }),
      }),
      lean: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue([]),
      }),
    }),
    findOne: jest.fn().mockReturnValue({
      lean: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue(null),
      }),
      exec: jest.fn().mockResolvedValue(null),
    }),
    findOneAndUpdate: jest.fn().mockReturnValue({
      lean: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue(null),
      }),
    }),
    findOneAndDelete: jest.fn().mockReturnValue({
      exec: jest.fn().mockResolvedValue(null),
    }),
  };
  return mockModel;
}

describe('EventSubscriptionService', () => {
  let service: EventSubscriptionService;
  let model: ReturnType<typeof createMockModel>;
  let encryptionService: { encrypt: jest.Mock; decrypt: jest.Mock };
  let eventEmitter: { emit: jest.Mock };
  let configService: { get: jest.Mock };

  beforeEach(async () => {
    model = createMockModel();
    encryptionService = {
      encrypt: jest.fn().mockResolvedValue('euroid:v2:key-1:encrypted'),
      decrypt: jest.fn().mockResolvedValue('plain-secret'),
    };
    eventEmitter = { emit: jest.fn() };
    configService = {
      get: jest.fn().mockImplementation((key: string) => {
        if (key === 'eventSubscriptions.WEBHOOK_MAX_SUBSCRIPTIONS_PER_TENANT') return 10;
        return undefined;
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EventSubscriptionService,
        { provide: getModelToken(EventSubscription.name), useValue: model },
        { provide: EncryptionService, useValue: encryptionService },
        { provide: DomainEventEmitterService, useValue: eventEmitter },
        { provide: ConfigService, useValue: configService },
      ],
    }).compile();

    service = module.get(EventSubscriptionService);
  });

  const validDto = {
    name: 'My Webhook',
    filters: { eventTypes: ['identity.*'] },
    webhook: {
      url: 'https://example.com/webhook',
      headers: {},
      signingSecret: 'my-super-secret-key-16',
    },
  };

  /** A subscription as MongoDB stores it: the secret encrypted, header values in plain text. */
  const storedSub = (overrides: Record<string, unknown> = {}) => ({
    _id: 'sub-1',
    tenantId: TEST_TENANT,
    name: 'My Webhook',
    type: 'WEBHOOK',
    status: 'ACTIVE',
    filters: { eventTypes: ['identity.*'] },
    webhook: {
      url: 'https://example.com/webhook',
      headers: new Map([['X-Api-Key', 'receiver-key-123']]),
      signingSecret: 'euroid:v2:key-1:encrypted',
    },
    createdBy: 'admin@test.com',
    createdAt: new Date('2026-11-20T09:00:00.000Z'),
    updatedAt: new Date('2026-11-20T09:00:00.000Z'),
    ...overrides,
  });

  /** What every answer carries for the stored subscription: names, no values, no secret. */
  const VIEW_WEBHOOK = {
    url: 'https://example.com/webhook',
    headerNames: ['X-Api-Key'],
    hasSigningSecret: true,
  };

  const duplicateKey = () =>
    Object.assign(new Error('E11000 duplicate key error'), { code: 11000 });

  describe('create', () => {
    it('creates a subscription with SSRF validation and encryption', async () => {
      model.create.mockResolvedValue(storedSub());

      const result = await service.create(validDto, 'admin@test.com');

      expect(validateUrlForFetch).toHaveBeenCalledWith('https://example.com/webhook');
      expect(encryptionService.encrypt).toHaveBeenCalledWith('my-super-secret-key-16');
      expect(model.create).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: TEST_TENANT,
          name: 'My Webhook',
          webhook: expect.objectContaining({
            signingSecret: 'euroid:v2:key-1:encrypted',
          }),
        }),
      );
      expect(result._id).toBe('sub-1');
    });

    it('rejects when max subscriptions per tenant exceeded', async () => {
      model.countDocuments.mockResolvedValue(10);

      await expect(service.create(validDto, 'admin@test.com')).rejects.toThrow(BadRequestException);
    });

    // 2.0dx: it answered the existing subscription unchanged (201), dropping the new URL and
    // secret without a word.
    it('refuses a name in use with 409 and answers nothing of the existing subscription', async () => {
      model.create.mockRejectedValue(duplicateKey());

      const refusal = service.create(validDto, 'admin@test.com');

      await expect(refusal).rejects.toThrow(ConflictException);
      await expect(refusal).rejects.toThrow(
        'A webhook subscription named "My Webhook" already exists.',
      );
      expect(model.findOne).not.toHaveBeenCalled();
    });

    it('answers the subscription without its signing secret or header values', async () => {
      model.create.mockResolvedValue(storedSub());

      const result = await service.create(validDto, 'admin@test.com');

      expect(result).toEqual({
        _id: 'sub-1',
        tenantId: TEST_TENANT,
        name: 'My Webhook',
        type: 'WEBHOOK',
        status: 'ACTIVE',
        filters: { eventTypes: ['identity.*'] },
        webhook: VIEW_WEBHOOK,
        createdBy: 'admin@test.com',
        createdAt: new Date('2026-11-20T09:00:00.000Z'),
        updatedAt: new Date('2026-11-20T09:00:00.000Z'),
      });
    });

    it('records the creation without the secret or header values', async () => {
      model.create.mockResolvedValue(storedSub());

      await service.create(
        {
          ...validDto,
          webhook: { ...validDto.webhook, headers: { 'X-Api-Key': 'receiver-key-123' } },
        },
        'admin@test.com',
      );

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'webhook.subscription_created',
        'sub-1',
        { subscriptionId: 'sub-1', name: 'My Webhook', webhookHost: 'example.com' },
        { actor: 'admin@test.com', tenantId: TEST_TENANT },
      );
    });

    // The event goes to every socket of the tenant (viewers too) and into the audit log; a
    // receiver's URL can carry its token in the path, the query or the user info.
    it('records only the host of the webhook URL, never a token in it', async () => {
      model.create.mockResolvedValue(storedSub());
      const url =
        'https://bot:pw-123@hooks.example.com:8443/services/T000/B000/SECRETTOKEN?key=abc';

      await service.create(
        { ...validDto, webhook: { ...validDto.webhook, url } },
        'admin@test.com',
      );

      const payload = eventEmitter.emit.mock.calls[0][2];
      expect(payload).toEqual({
        subscriptionId: 'sub-1',
        name: 'My Webhook',
        webhookHost: 'hooks.example.com:8443',
      });
      for (const secret of ['SECRETTOKEN', 'key=abc', 'pw-123', 'bot']) {
        expect(JSON.stringify(payload)).not.toContain(secret);
      }
    });

    // Custom headers go on every delivery: they must not replace what EuroID sets or break the
    // stored map (a key with "." or a leading "$" was a 500).
    it.each([
      ['Host', 'internal.example'],
      ['host', 'internal.example'],
      ['Content-Type', 'text/plain'],
      ['Content-Length', '0'],
      ['X-EuroID-Signature', 'sha256=forged'],
      ['x-euroid-delivery', 'replayed'],
      ['X-EuroID-Anything', 'v'],
      ['a.b', 'v'],
      ['$where', 'v'],
      ['X Team', 'v'],
      ['X-Team:', 'v'],
      ['Ä-Header', 'v'],
      ['', 'v'],
    ])('refuses the custom header name %p before storing anything', async (name, value) => {
      const refusal = service.create(
        { ...validDto, webhook: { ...validDto.webhook, headers: { [name]: value } } },
        'admin@test.com',
      );

      await expect(refusal).rejects.toThrow(ZodError);
      expect(model.create).not.toHaveBeenCalled();
    });

    it.each([
      ['a line break', { 'X-Team': 'security\r\nX-Injected: 1' }],
      ['a value over 2000 characters', { 'X-Team': 'x'.repeat(2001) }],
      ['one header named twice in different case', { 'X-Team': 'a', 'x-team': 'b' }],
    ])('refuses custom headers with %s', async (_label, headers) => {
      await expect(
        service.create(
          { ...validDto, webhook: { ...validDto.webhook, headers } },
          'admin@test.com',
        ),
      ).rejects.toThrow(ZodError);
      expect(model.create).not.toHaveBeenCalled();
    });

    it("accepts token names such as Authorization, X-Team and RFC 9110's other characters", async () => {
      model.create.mockResolvedValue(storedSub());
      const headers = { Authorization: 'Bearer t', 'X-Team': 'security', "X_a!#%&'*+^`|~1": 'v' };

      await service.create(
        { ...validDto, webhook: { ...validDto.webhook, headers } },
        'admin@test.com',
      );

      expect(model.create).toHaveBeenCalledWith(
        expect.objectContaining({ webhook: expect.objectContaining({ headers }) }),
      );
    });

    it('validates DTO with Zod (rejects invalid input): an empty name, named in the error', async () => {
      const refusal = service.create({ ...validDto, name: '' }, 'admin@test.com');

      await expect(refusal).rejects.toThrow(ZodError);
      await expect(refusal).rejects.toMatchObject({
        issues: [expect.objectContaining({ path: ['name'] })],
      });
      expect(model.create).not.toHaveBeenCalled();
    });

    // The SSRF guard throws a plain Error, which the global filter answered as a 500 "Internal
    // server error", so the page could not say why. Its own text names the address the host
    // resolves to, which a tenant admin must not learn about the platform's network.
    it('answers a URL the SSRF guard refuses with 400 that names no resolved address', async () => {
      (validateUrlForFetch as jest.Mock).mockRejectedValueOnce(
        new Error('URL resolves to blocked IP 10.0.0.5 (intranet.example)'),
      );

      const refusal = service.create(
        { ...validDto, webhook: { ...validDto.webhook, url: 'https://intranet.example/hook' } },
        'admin@test.com',
      );

      await expect(refusal).rejects.toThrow(BadRequestException);
      await expect(refusal).rejects.toThrow(WEBHOOK_URL_REFUSED);
      await expect(refusal).rejects.not.toThrow(/10\.0\.0\.5/);
      expect(model.create).not.toHaveBeenCalled();
      expect(encryptionService.encrypt).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('answers a new URL the SSRF guard refuses with 400 and changes nothing', async () => {
      model.findOne.mockReturnValue({
        lean: jest.fn(),
        exec: jest.fn().mockResolvedValue({ _id: 'sub-1', tenantId: TEST_TENANT }),
      });
      (validateUrlForFetch as jest.Mock).mockRejectedValueOnce(
        new Error('Only HTTPS URLs are allowed for remote fetches. Got: http:'),
      );

      const refusal = service.update(
        'sub-1',
        { webhook: { url: 'http://hooks.example/euroid' } },
        'admin@test.com',
      );

      await expect(refusal).rejects.toThrow(BadRequestException);
      await expect(refusal).rejects.toThrow(WEBHOOK_URL_REFUSED);
      expect(model.findOneAndUpdate).not.toHaveBeenCalled();
    });

    // Redirecting deliveries to another receiver left no audit entry: create and delete emit,
    // the PATCH did not. The event names what changed and the new host only, never the URL (its
    // path or query can carry the receiver's token), a header value or the secret.
    it('emits WEBHOOK_SUBSCRIPTION_UPDATED naming the changed fields and the new host', async () => {
      model.findOne.mockReturnValue({
        lean: jest.fn(),
        exec: jest.fn().mockResolvedValue(storedSub()),
      });
      model.findOneAndUpdate.mockReturnValue({
        lean: () => ({ exec: () => Promise.resolve(storedSub({ name: 'Renamed' })) }),
      });

      await service.update(
        'sub-1',
        {
          name: 'Renamed',
          webhook: {
            url: 'https://attacker.example:8443/hook?token=secret-token',
            signingSecret: 'a-new-signing-secret-of-32-chars-min',
          },
        },
        'admin@test.com',
      );

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'webhook.subscription_updated',
        'sub-1',
        {
          subscriptionId: 'sub-1',
          name: 'Renamed',
          changed: ['name', 'webhook.url', 'webhook.signingSecret'],
          webhookHost: 'attacker.example:8443',
        },
        { actor: 'admin@test.com', tenantId: TEST_TENANT },
      );
      expect(JSON.stringify((eventEmitter.emit as jest.Mock).mock.calls)).not.toContain(
        'secret-token',
      );
    });

    it('emits no host when the URL did not change', async () => {
      model.findOne.mockReturnValue({
        lean: jest.fn(),
        exec: jest.fn().mockResolvedValue(storedSub()),
      });
      model.findOneAndUpdate.mockReturnValue({
        lean: () => ({ exec: () => Promise.resolve(storedSub()) }),
      });

      await service.update('sub-1', { status: 'PAUSED' }, 'admin@test.com');

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'webhook.subscription_updated',
        'sub-1',
        expect.not.objectContaining({ webhookHost: expect.anything() }),
        expect.anything(),
      );
      expect((eventEmitter.emit as jest.Mock).mock.calls[0][2].changed).toEqual(['status']);
    });

    // 2.0dx: a rename onto a used name hit the unique index and answered 500.
    it('refuses a rename onto a name in use with 409', async () => {
      model.findOne.mockReturnValue({
        lean: jest.fn(),
        exec: jest.fn().mockResolvedValue(storedSub()),
      });
      model.findOneAndUpdate.mockReturnValue({
        lean: () => ({ exec: () => Promise.reject(duplicateKey()) }),
      });

      const refusal = service.update('sub-1', { name: 'Ticketing' }, 'admin@test.com');

      await expect(refusal).rejects.toThrow(ConflictException);
      await expect(refusal).rejects.toThrow(
        'A webhook subscription named "Ticketing" already exists.',
      );
    });

    describe('custom headers', () => {
      beforeEach(() => {
        model.findOne.mockReturnValue({
          lean: jest.fn(),
          exec: jest.fn().mockResolvedValue(
            storedSub({
              webhook: {
                url: 'https://example.com/webhook',
                headers: new Map([
                  ['X-Api-Key', 'receiver-key-123'],
                  ['X-Old', 'old-value'],
                ]),
                signingSecret: 'euroid:v2:key-1:encrypted',
              },
            }),
          ),
        });
        model.findOneAndUpdate.mockReturnValue({
          lean: () => ({ exec: () => Promise.resolve(storedSub()) }),
        });
      });
      const setOf = () =>
        (model.findOneAndUpdate.mock.calls[0] as [unknown, { $set: Record<string, unknown> }])[1]
          .$set;

      // The page cannot resend values it is never answered: null keeps the stored one.
      it('replaces the set of headers, keeping the stored value of each one sent as null', async () => {
        const result = await service.update(
          'sub-1',
          { webhook: { headers: { 'X-Api-Key': null, 'X-New': 'new-value' } } },
          'admin@test.com',
        );

        expect(setOf()).toEqual({
          'webhook.headers': { 'X-Api-Key': 'receiver-key-123', 'X-New': 'new-value' },
        });
        expect(result.webhook).toEqual(VIEW_WEBHOOK);
      });

      it('leaves the headers alone when the edit does not name them', async () => {
        await service.update('sub-1', { name: 'Renamed' }, 'admin@test.com');

        expect(setOf()).toEqual({ name: 'Renamed' });
      });

      it('refuses to keep a header that is not stored, naming it', async () => {
        const refusal = service.update(
          'sub-1',
          { webhook: { headers: { 'X-Missing': null } } },
          'admin@test.com',
        );

        await expect(refusal).rejects.toThrow(BadRequestException);
        await expect(refusal).rejects.toThrow('X-Missing');
        expect(model.findOneAndUpdate).not.toHaveBeenCalled();
      });

      it('applies the header rules to an edit too', async () => {
        await expect(
          service.update(
            'sub-1',
            { webhook: { headers: { 'X-EuroID-Signature': 'sha256=forged' } } },
            'admin@test.com',
          ),
        ).rejects.toThrow(ZodError);
        expect(model.findOneAndUpdate).not.toHaveBeenCalled();
      });
    });
  });

  describe('findAll and findOne', () => {
    it('answer no signing secret and no header value', async () => {
      model.find.mockReturnValue({
        sort: () => ({ lean: () => ({ exec: () => Promise.resolve([storedSub()]) }) }),
      });
      model.findOne.mockReturnValue({
        lean: () => ({ exec: () => Promise.resolve(storedSub({ __v: 0 })) }),
      });

      const [listed] = await service.findAll();
      const one = await service.findOne('sub-1');

      for (const sub of [listed, one]) {
        expect(sub!.webhook).toEqual(VIEW_WEBHOOK);
        expect(JSON.stringify(sub)).not.toMatch(/signingSecret|encrypted|receiver-key-123|__v/);
      }
    });

    it('findOne throws NotFoundException when not found', async () => {
      await expect(service.findOne('nonexistent-id')).rejects.toThrow(NotFoundException);
    });

    // The test route signs with the stored secret and sends the stored headers.
    it('findStored answers the stored subscription for sending, secret and headers included', async () => {
      model.findOne.mockReturnValue({
        lean: () => ({ exec: () => Promise.resolve(storedSub()) }),
      });

      await expect(service.findStored('sub-1')).resolves.toEqual(storedSub());
      expect(model.findOne).toHaveBeenCalledWith({ _id: 'sub-1', tenantId: TEST_TENANT });
    });
  });

  describe('remove', () => {
    it('deletes and emits WEBHOOK_SUBSCRIPTION_DELETED', async () => {
      model.findOneAndDelete.mockReturnValue({
        exec: jest.fn().mockResolvedValue({ _id: 'sub-1', name: 'Test Sub' }),
      });

      await service.remove('sub-1', 'admin@test.com');

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'webhook.subscription_deleted',
        'sub-1',
        expect.objectContaining({ subscriptionId: 'sub-1' }),
        expect.objectContaining({ actor: 'admin@test.com' }),
      );
    });

    it('throws NotFoundException when not found', async () => {
      model.findOneAndDelete.mockReturnValue({
        exec: jest.fn().mockResolvedValue(null),
      });

      await expect(service.remove('nonexistent', 'admin@test.com')).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
