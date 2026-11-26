import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DeadLetterService } from './dead-letter.service';
import { DeadLetterHandlerRegistry } from './dead-letter-handler.registry';
import { withTenantContext } from '@infrastructure/multi-tenancy/tenant-context.helper';
import { DeadLetterEntry } from './schemas/dead-letter.schema';
import type { ModuleRef } from '@nestjs/core';
import { PluginRegistryService } from '../connectors/plugin/plugin-registry.service';
import { registerBuiltInConnectors } from '../connectors/plugin/register-connectors';

describe('DeadLetterService', () => {
  let service: DeadLetterService;
  let model: Record<string, jest.Mock>;
  let eventEmitter: { emitAsync: jest.Mock };
  let handlers: DeadLetterHandlerRegistry;

  const registry = new PluginRegistryService({} as ModuleRef);
  registerBuiltInConnectors(registry);

  beforeEach(async () => {
    model = {
      create: jest.fn().mockResolvedValue({}),
      find: jest.fn().mockReturnValue({
        sort: jest.fn().mockReturnValue({
          skip: jest.fn().mockReturnValue({
            limit: jest.fn().mockReturnValue({
              lean: jest.fn().mockReturnValue({
                exec: jest.fn().mockResolvedValue([]),
              }),
            }),
          }),
        }),
        limit: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue([]),
        }),
      }),
      findById: jest.fn().mockReturnValue({
        lean: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue(null),
        }),
        exec: jest.fn().mockResolvedValue(null),
      }),
      findByIdAndUpdate: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue(null),
      }),
      // The claim before a re-run (2.0dl): an entry answered means this process got it.
      findOneAndUpdate: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue({}),
      }),
      // The re-run's outcome, written while the claim holds.
      updateOne: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue({ matchedCount: 1 }),
      }),
      aggregate: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue([
          { _id: 'pending', count: 5 },
          { _id: 'replayed', count: 3 },
        ]),
      }),
    };

    eventEmitter = {
      emitAsync: jest.fn().mockResolvedValue([]),
    };

    const configService = {
      get: jest.fn().mockImplementation((key: string) => {
        if (key === 'deadLetter.DLQ_MAX_RETRIES') return 3;
        if (key === 'deadLetter.DLQ_RETRY_POLL_INTERVAL_MS') return 60000;
        return undefined;
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DeadLetterService,
        { provide: getModelToken(DeadLetterEntry.name), useValue: model },
        { provide: EventEmitter2, useValue: eventEmitter },
        { provide: ConfigService, useValue: configService },
        { provide: PluginRegistryService, useValue: registry },
        DeadLetterHandlerRegistry,
      ],
    }).compile();

    service = module.get(DeadLetterService);
    handlers = module.get(DeadLetterHandlerRegistry);
    // Stop poller in tests
    service.onModuleDestroy();
  });

  afterEach(() => {
    service.onModuleDestroy();
  });

  describe('capture', () => {
    it('creates entry with maxRetries and nextRetryAt from config', async () => {
      await service.capture({
        type: 'event_handler_failure',
        source: 'test.handler',
        originalPayload: { type: 'identity.created' },
        error: { message: 'handler failed' },
        tenantId: 'test-tenant',
      });

      expect(model.create).toHaveBeenCalledWith(
        expect.objectContaining({
          maxRetries: 3,
          nextRetryAt: expect.any(Date),
          status: 'pending',
        }),
      );
    });

    it('stores the failed handler and falls back from an empty tenant to the event tenant', async () => {
      await service.capture({
        type: 'event_handler_failure',
        source: 'identity.created',
        handler: 'UserTimelineHandler.handleIdentityCreated',
        originalPayload: { type: 'identity.created', metadata: { tenantId: 'tenant-a' } },
        error: { message: 'handler failed' },
        tenantId: '',
      });

      expect(model.create).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant-a',
          handler: 'UserTimelineHandler.handleIdentityCreated',
        }),
      );
    });

    it('uses the request tenant when neither the caller nor the event names one', async () => {
      await withTenantContext('tenant-ctx', () =>
        service.capture({
          type: 'event_validation_failure',
          source: 'identity.created',
          originalPayload: { aggregateId: 'id-1', payload: {} },
          error: { message: 'invalid' },
          tenantId: '',
        }),
      );

      expect(model.create).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'tenant-ctx' }),
      );
      expect(model.create.mock.calls[0][0]).not.toHaveProperty('handler');
    });

    it('never throws on capture failure', async () => {
      model.create.mockRejectedValue(new Error('DB error'));
      await expect(
        service.capture({
          type: 'event_handler_failure',
          source: 'test',
          originalPayload: {},
          error: { message: 'error' },
        }),
      ).resolves.toBeUndefined();
    });
  });

  /** The claim's filter is the state the entry was read in; the outcome needs the claim. */
  const CLAIMED = { _id: 'entry-1', status: 'retrying', nextRetryAt: expect.any(Date) };
  const outcomeSet = (fields: Record<string, unknown>) =>
    expect.objectContaining({ $set: expect.objectContaining(fields) });

  describe('retryEntry', () => {
    it('throws NotFoundException when not found', async () => {
      await expect(service.retryEntry('nonexistent', 'admin')).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException for terminal statuses', async () => {
      model.findById.mockReturnValue({
        exec: jest.fn().mockResolvedValue({
          _id: 'entry-1',
          status: 'replayed',
          type: 'event_handler_failure',
        }),
      });

      await expect(service.retryEntry('entry-1', 'admin')).rejects.toThrow(BadRequestException);
    });

    it('re-emits event and marks as replayed on success', async () => {
      const doc = {
        _id: 'entry-1',
        status: 'pending',
        type: 'event_handler_failure',
        source: 'identity.handler',
        originalPayload: {
          type: 'identity.created',
          metadata: { tenantId: 'test-tenant' },
        },
        retryCount: 0,
        maxRetries: 3,
        tenantId: 'test-tenant',
        correlationId: 'corr-1',
      };
      model.findById.mockReturnValue({
        exec: jest.fn().mockResolvedValue(doc),
      });
      model.findByIdAndUpdate.mockReturnValue({
        exec: jest.fn().mockResolvedValue(doc),
      });

      await service.retryEntry('entry-1', 'admin@test.com');

      // Claimed as 'retrying' from the state it was read in, then closed as 'replayed'
      expect(model.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: 'entry-1', status: 'pending', retryCount: 0 },
        { $set: { status: 'retrying', nextRetryAt: expect.any(Date) } },
      );
      expect(model.updateOne).toHaveBeenCalledWith(
        CLAIMED,
        outcomeSet({ status: 'replayed', resolvedBy: 'admin@test.com' }),
      );
    });

    it('increments retryCount and sets backoff on failure', async () => {
      const doc = {
        _id: 'entry-1',
        status: 'pending',
        type: 'event_handler_failure',
        source: 'test',
        originalPayload: {
          type: 'identity.created',
          metadata: { tenantId: 'test' },
        },
        retryCount: 0,
        maxRetries: 3,
        tenantId: 'test',
      };
      model.findById.mockReturnValue({
        exec: jest.fn().mockResolvedValue(doc),
      });
      model.findByIdAndUpdate.mockReturnValue({
        exec: jest.fn().mockResolvedValue(doc),
      });
      eventEmitter.emitAsync.mockRejectedValue(new Error('handler error'));

      await service.retryEntry('entry-1', 'admin');

      expect(model.updateOne).toHaveBeenCalledWith(
        CLAIMED,
        outcomeSet({
          status: 'pending',
          retryCount: 1,
          nextRetryAt: expect.any(Date),
          lastRetryError: 'handler error',
        }),
      );
    });

    it('marks as failed_permanently after maxRetries', async () => {
      const doc = {
        _id: 'entry-1',
        status: 'pending',
        type: 'event_handler_failure',
        source: 'test',
        originalPayload: {
          type: 'identity.created',
          metadata: { tenantId: 'test' },
        },
        retryCount: 2, // next failure will be 3 = maxRetries
        maxRetries: 3,
        tenantId: 'test',
      };
      model.findById.mockReturnValue({
        exec: jest.fn().mockResolvedValue(doc),
      });
      model.findByIdAndUpdate.mockReturnValue({
        exec: jest.fn().mockResolvedValue(doc),
      });
      eventEmitter.emitAsync.mockRejectedValue(new Error('final failure'));

      await service.retryEntry('entry-1', 'admin');

      expect(model.updateOne).toHaveBeenCalledWith(
        CLAIMED,
        outcomeSet({ status: 'failed_permanently', retryCount: 3 }),
      );
    });

    it('refuses with 409 and runs nothing when another process claimed the entry first', async () => {
      model.findById.mockReturnValue({
        exec: jest.fn().mockResolvedValue({
          _id: 'entry-1',
          status: 'pending',
          type: 'event_handler_failure',
          originalPayload: { type: 'identity.created', metadata: { tenantId: 'test' } },
          retryCount: 0,
          maxRetries: 3,
          tenantId: 'test',
        }),
      });
      model.findOneAndUpdate.mockReturnValue({ exec: jest.fn().mockResolvedValue(null) });

      await expect(service.retryEntry('entry-1', 'admin')).rejects.toThrow(ConflictException);
      expect(eventEmitter.emitAsync).not.toHaveBeenCalled();
      expect(model.updateOne).not.toHaveBeenCalled();
    });
  });

  describe('honest outcomes (2.0cu)', () => {
    const eventDoc = (overrides: Record<string, unknown> = {}) => ({
      _id: 'entry-1',
      status: 'pending',
      type: 'event_handler_failure',
      source: 'identity.created',
      originalPayload: {
        type: 'identity.created',
        aggregateId: 'id-1',
        metadata: { tenantId: 'test' },
      },
      retryCount: 0,
      maxRetries: 3,
      tenantId: 'test',
      ...overrides,
    });
    const stored = (doc: Record<string, unknown>) => {
      model.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(doc) });
      model.findOneAndUpdate.mockReturnValue({ exec: jest.fn().mockResolvedValue(doc) });
    };
    /** The statuses written: the claim's, then the outcome's (always in that order). */
    const statusesWritten = () =>
      [...model.findOneAndUpdate.mock.calls, ...model.updateOne.mock.calls]
        .map(([, update]) => (update as { $set?: { status?: string } }).$set?.status)
        .filter(Boolean);
    const untouched = () => {
      expect(model.findOneAndUpdate).not.toHaveBeenCalled();
      expect(model.updateOne).not.toHaveBeenCalled();
      expect(model.findByIdAndUpdate).not.toHaveBeenCalled();
    };

    it.each([
      ['a workflow step', { type: 'workflow_terminal', originalPayload: { workflowId: 'wf-1' } }],
      [
        'a webhook delivery stored without its event',
        { originalPayload: { subscriptionId: 's-1', eventType: 'identity.created' } },
      ],
    ])('retry and replay refuse %s with 409 and leave it untouched', async (_label, overrides) => {
      stored(eventDoc(overrides));

      await expect(service.retryEntry('entry-1', 'admin')).rejects.toThrow(ConflictException);
      await expect(service.replay('entry-1', 'admin')).rejects.toThrow(ConflictException);

      untouched();
      expect(eventEmitter.emitAsync).not.toHaveBeenCalled();
    });

    it('answers replayed when the re-run succeeded', async () => {
      stored(eventDoc());

      await expect(service.retryEntry('entry-1', 'admin')).resolves.toEqual({
        id: 'entry-1',
        status: 'replayed',
        retryCount: 0,
        maxRetries: 3,
      });
    });

    it('answers pending with the masked error when the re-run failed', async () => {
      stored(eventDoc());
      eventEmitter.emitAsync.mockRejectedValue(new Error('no mailbox for matti@corp.example'));

      const outcome = await service.retryEntry('entry-1', 'admin');

      expect(outcome).toEqual({
        id: 'entry-1',
        status: 'pending',
        retryCount: 1,
        maxRetries: 3,
        error: 'no mailbox for m•••@corp.example',
      });
      expect(statusesWritten()).toEqual(['retrying', 'pending']);
    });

    it('runs only the failed handler of a per-handler entry, and closes it when it succeeds', async () => {
      const run = jest.fn().mockResolvedValue(undefined);
      handlers.register('UserTimelineHandler.handleIdentityCreated', run);
      stored(eventDoc({ handler: 'UserTimelineHandler.handleIdentityCreated' }));

      const outcome = await service.retryEntry('entry-1', 'admin');

      expect(run).toHaveBeenCalledWith(expect.objectContaining({ type: 'identity.created' }));
      expect(eventEmitter.emitAsync).not.toHaveBeenCalledWith(
        'identity.created',
        expect.anything(),
      );
      expect(outcome.status).toBe('replayed');
      expect(eventEmitter.emitAsync).toHaveBeenCalledWith(
        'dlq.entry_retried',
        expect.objectContaining({ aggregateId: 'entry-1' }),
      );
    });

    it('keeps a per-handler entry pending when its handler fails again', async () => {
      handlers.register('UserTimelineHandler.handleIdentityCreated', async () => {
        throw new Error('timeline write failed');
      });
      stored(eventDoc({ handler: 'UserTimelineHandler.handleIdentityCreated' }));

      const outcome = await service.retryEntry('entry-1', 'admin');

      expect(outcome).toMatchObject({ status: 'pending', error: 'timeline write failed' });
      expect(statusesWritten()).not.toContain('replayed');
      expect(eventEmitter.emitAsync).not.toHaveBeenCalledWith(
        'dlq.entry_retried',
        expect.anything(),
      );
    });

    it('refuses a per-handler entry whose handler is not registered', async () => {
      stored(eventDoc({ handler: 'RemovedHandler.handle' }));

      await expect(service.retryEntry('entry-1', 'admin')).rejects.toThrow(/not registered/);
      untouched();
    });

    // 2.0dl: a replay holds the entry ('retrying') while it runs, so the automatic retry cannot
    // run it at the same time; a failure puts it back to pending as it was, not counted.
    it('replay waits for the re-run: a failure keeps the entry pending with the error', async () => {
      const retryAt = new Date('2026-11-23T12:00:00.000Z');
      stored(eventDoc({ nextRetryAt: retryAt }));
      eventEmitter.emitAsync.mockRejectedValue(new Error('still failing'));

      const outcome = await service.replay('entry-1', 'admin');

      expect(outcome).toEqual({
        id: 'entry-1',
        status: 'pending',
        retryCount: 0,
        maxRetries: 3,
        error: 'still failing',
      });
      expect(model.updateOne).toHaveBeenCalledWith(CLAIMED, {
        $set: { status: 'pending', nextRetryAt: retryAt, lastRetryError: 'still failing' },
      });
      expect(statusesWritten()).toEqual(['retrying', 'pending']);
    });

    it('replay closes the entry as replayed when the re-run succeeded', async () => {
      stored(eventDoc());

      const outcome = await service.replay('entry-1', 'admin@test.com');

      expect(outcome.status).toBe('replayed');
      expect(model.updateOne).toHaveBeenCalledWith(
        CLAIMED,
        outcomeSet({ status: 'replayed', resolvedBy: 'admin@test.com' }),
      );
    });

    it('auto-retry picks only entries it can re-run, with the handlers registered here', async () => {
      handlers.register('A.b', async () => undefined);
      let query: Record<string, unknown> | undefined;
      model.find.mockImplementation((q: Record<string, unknown>) => {
        query = q;
        return {
          sort: () => ({ setOptions: () => ({ limit: () => ({ exec: async () => [] }) }) }),
        };
      });

      await service.processAutoRetries();

      expect(query).toMatchObject({
        type: 'event_handler_failure',
        'originalPayload.type': { $exists: true },
        'originalPayload.metadata': { $exists: true },
        $or: [{ handler: null }, { handler: { $in: ['A.b'] } }],
      });
    });
  });

  describe('getStats', () => {
    it('returns aggregated counts by status', async () => {
      const result = await service.getStats();
      expect(result).toEqual({ pending: 5, replayed: 3 });
    });
  });

  describe('getRetryDelayMs', () => {
    it('computes exponential backoff: 1min, 5min, 25min', () => {
      expect(service.getRetryDelayMs(1)).toBe(60_000);
      expect(service.getRetryDelayMs(2)).toBe(300_000);
      expect(service.getRetryDelayMs(3)).toBe(1_500_000);
    });
  });

  describe('batchRetry', () => {
    it('processes matching entries and reports counts', async () => {
      const entries = [
        { _id: 'e1', status: 'pending' },
        { _id: 'e2', status: 'pending' },
      ];
      model.find.mockReturnValue({
        limit: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue(entries),
        }),
      });
      // Mock retryEntry to succeed for both
      model.findById.mockReturnValue({
        exec: jest.fn().mockResolvedValue({
          _id: 'e1',
          status: 'pending',
          type: 'event_handler_failure',
          source: 'test',
          originalPayload: { type: 'identity.created', metadata: { tenantId: 'test' } },
          retryCount: 0,
          maxRetries: 3,
          tenantId: 'test',
        }),
      });
      model.findByIdAndUpdate.mockReturnValue({
        exec: jest.fn().mockResolvedValue({}),
      });

      const result = await service.batchRetry({}, 'admin');
      expect(result).toEqual({ processed: 2, replayed: 2, failed: 0 });
    });

    it('counts a re-run that failed again as processed but not replayed', async () => {
      model.find.mockReturnValue({
        limit: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue([{ _id: 'e1', status: 'pending' }]),
        }),
      });
      model.findById.mockReturnValue({
        exec: jest.fn().mockResolvedValue({
          _id: 'e1',
          status: 'pending',
          type: 'event_handler_failure',
          source: 'test',
          originalPayload: { type: 'identity.created', metadata: { tenantId: 'test' } },
          retryCount: 0,
          maxRetries: 3,
          tenantId: 'test',
        }),
      });
      eventEmitter.emitAsync.mockRejectedValue(new Error('handler error'));

      await expect(service.batchRetry({}, 'admin')).resolves.toEqual({
        processed: 1,
        replayed: 0,
        failed: 0,
      });
    });

    it('re-runs nothing for a type that carries no event', async () => {
      await expect(service.batchRetry({ type: 'workflow_terminal' }, 'admin')).resolves.toEqual({
        processed: 0,
        replayed: 0,
        failed: 0,
      });
      expect(model.find).not.toHaveBeenCalled();
    });
  });
  describe('payload redaction (DLQ-2)', () => {
    function stored(entry: Record<string, unknown>) {
      model.findById.mockReturnValue({
        lean: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(entry) }),
      });
    }

    it("redacts a connector entry by the connector's declared secrets", async () => {
      stored({
        _id: 'dlq-1',
        type: 'connector_non_retryable',
        source: 'discord-webhook',
        originalPayload: { config: { webhookUrl: 'https://discord.com/api/webhooks/1/tok' } },
        error: { message: 'boom' },
      });
      const scim = { config: { oauth2TokenUrl: 'https://auth.example/token', clientSecret: 's' } };

      const discord = await service.findOne('dlq-1');
      stored({
        _id: 'dlq-2',
        type: 'connector_non_retryable',
        source: 'scim',
        originalPayload: scim,
      });
      const scimEntry = await service.findOne('dlq-2');

      // webhookUrl embeds the webhook token but has no "secret"-like name: only the manifest knows.
      expect(discord.originalPayload).toEqual({ config: { webhookUrl: '[REDACTED]' } });
      // oauth2TokenUrl is not declared secret, so it is shown despite "token" in its name.
      expect(scimEntry.originalPayload).toEqual({
        config: { oauth2TokenUrl: 'https://auth.example/token', clientSecret: '[REDACTED]' },
      });
    });

    it('falls back to key names when the entry belongs to no registered connector', async () => {
      stored({
        _id: 'dlq-3',
        type: 'event_handler_failure',
        source: 'identity.created',
        originalPayload: { payload: { accessToken: 'abc', apiKey: 'k', email: 'a@b.example' } },
        error: { message: 'boom' },
      });

      const entry = await service.findOne('dlq-3');

      // The email is not a secret, but the response masks it (personal data, see below).
      expect(entry.originalPayload).toEqual({
        payload: { accessToken: '[REDACTED]', apiKey: '[REDACTED]', email: 'a•••@b.example' },
      });
    });
  });

  describe('personal data in responses (identity-pii)', () => {
    const storedEvent = {
      _id: 'dlq-4',
      type: 'event_handler_failure',
      source: 'identity.created',
      originalPayload: {
        type: 'identity.created',
        aggregateId: 'id-1',
        payload: {
          email: 'matti.meikalainen@corp.example',
          firstName: 'Matti',
          personalEmail: 'matti@home.example',
          mobilePhone: '+358 40 123 4567',
          contracts: [{ manager: 'boss@corp.example', department: 'IT' }],
        },
        metadata: { tenantId: 'tenant-a', actor: 'admin@corp.example' },
      },
      error: { message: 'User matti.meikalainen@corp.example already exists', code: 'E409' },
      lastRetryError: 'Graph rejected matti.meikalainen@corp.example',
      retryCount: 1,
      status: 'pending',
    };

    it('masks emails, PII fields and addresses quoted in errors in GET /dead-letter/:id', async () => {
      model.findById.mockReturnValue({
        lean: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(storedEvent) }),
      });

      const entry = await service.findOne('dlq-4');
      const body = JSON.stringify(entry);

      expect(body).not.toContain('matti.meikalainen@corp.example');
      expect(body).not.toContain('matti@home.example');
      expect(body).not.toContain('boss@corp.example');
      expect(body).not.toContain('123 4567');
      const payload = (entry.originalPayload as { payload: Record<string, unknown> }).payload;
      expect(payload.email).toBe('m•••@corp.example');
      expect(payload.personalEmail).toBe('m•••@home.example');
      expect(payload.mobilePhone).toBe('+358 •• ••• 4567');
      expect(payload.contracts).toEqual([{ manager: 'b•••@corp.example', department: 'IT' }]);
      // Not personal contact data: an operator needs them to find the identity and the event.
      expect(payload.firstName).toBe('Matti');
      expect((entry.originalPayload as { aggregateId: string }).aggregateId).toBe('id-1');
      expect(entry.error.message).toBe('User m•••@corp.example already exists');
      expect(entry.error.code).toBe('E409');
      expect(entry.lastRetryError).toBe('Graph rejected m•••@corp.example');
    });

    it('masks phone fields whatever the event or connector calls them', async () => {
      // 2.0cn: `phone` was returned in clear while the detail view says phone numbers are masked.
      model.findById.mockReturnValue({
        lean: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue({
            ...storedEvent,
            originalPayload: {
              type: 'identity.created',
              payload: {
                phone: '+358501234567',
                telephoneNumber: '+358 9 8765 4321',
                businessPhones: ['+358 9 1111 2222'],
                phoneNumbers: [{ value: '+358 40 333 4444', type: 'work', primary: true }],
                mobile: '0405556666',
                workPhone: '+358 40 123 4567',
                department: 'IT',
              },
            },
          }),
        }),
      });

      const entry = await service.findOne('dlq-4');
      const body = JSON.stringify(entry);

      for (const clear of ['501234', '8765', '1111', '333', '555']) {
        expect(body).not.toContain(clear);
      }
      const payload = (entry.originalPayload as { payload: Record<string, unknown> }).payload;
      expect(payload.phone).toBe('+••••••••4567');
      expect(payload.telephoneNumber).toBe('+358 • •••• 4321');
      expect(payload.businessPhones).toEqual(['+358 • •••• 2222']);
      expect(payload.phoneNumbers).toEqual([
        { value: '+358 •• ••• 4444', type: '••••', primary: true },
      ]);
      expect(payload.mobile).toBe('••••••6666');
      // A PII_FIELDS key is masked once, exactly as in identity responses.
      expect(payload.workPhone).toBe('+358 •• ••• 4567');
      expect(payload.department).toBe('IT');
    });

    it('masks list entries the same way', async () => {
      model.find.mockReturnValue({
        sort: () => ({
          skip: () => ({ limit: () => ({ lean: () => ({ exec: async () => [storedEvent] }) }) }),
        }),
      });

      const [entry] = await service.findAll({});

      expect(JSON.stringify(entry)).not.toContain('matti.meikalainen@corp.example');
    });

    it('retries with the clear stored event: masking is for the response only', async () => {
      const doc = { ...storedEvent, maxRetries: 3, tenantId: 'tenant-a' };
      model.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(doc) });
      model.findOneAndUpdate.mockReturnValue({ exec: jest.fn().mockResolvedValue(doc) });

      await service.retryEntry('dlq-4', 'admin');

      expect(eventEmitter.emitAsync).toHaveBeenCalledWith(
        'identity.created',
        expect.objectContaining({
          payload: expect.objectContaining({ email: 'matti.meikalainen@corp.example' }),
        }),
      );
    });
  });

  describe('findAll filters', () => {
    function captureQuery(): { query?: Record<string, unknown> } {
      const seen: { query?: Record<string, unknown> } = {};
      model.find.mockImplementation((query: Record<string, unknown>) => {
        seen.query = query;
        return {
          sort: () => ({
            skip: () => ({ limit: () => ({ lean: () => ({ exec: async () => [] }) }) }),
          }),
        };
      });
      return seen;
    }

    it('filters by status, type and a case-insensitive source prefix', async () => {
      const seen = captureQuery();

      await service.findAll({
        status: 'pending',
        type: 'event_handler_failure',
        source: 'webhook:',
      });

      expect(seen.query).toEqual({
        status: 'pending',
        type: 'event_handler_failure',
        source: { $regex: '^webhook:', $options: 'i' },
      });
    });

    it('matches the source literally: regex characters are escaped', async () => {
      const seen = captureQuery();

      await service.findAll({ source: 'identity.created(.*)' });

      expect(seen.query?.source).toEqual({
        $regex: '^identity\\.created\\(\\.\\*\\)',
        $options: 'i',
      });
    });
  });
});
