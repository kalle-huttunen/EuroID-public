import { DomainEventEmitterService } from './event-emitter.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DomainEventType } from './event-types';
import { requestContext } from '../middleware/correlation.middleware';

describe('DomainEventEmitterService', () => {
  let service: DomainEventEmitterService;
  let emitter: jest.Mocked<Partial<EventEmitter2>>;
  let deadLetterService: any;
  let outboxModel: any;

  beforeEach(() => {
    emitter = {
      emitAsync: jest.fn().mockResolvedValue([]),
    };
    deadLetterService = {
      capture: jest.fn(),
    };
    outboxModel = {
      create: jest.fn().mockResolvedValue([]),
    };

    const configService = {
      get: jest.fn().mockReturnValue('test'),
    };

    service = new DomainEventEmitterService(
      emitter as any,
      deadLetterService,
      outboxModel,
      configService as any,
    );
  });

  const validIdentityCreatedPayload = {
    identityId: 'user-123',
    sourceSystem: 'workday',
    sourceUserId: '123',
    status: 'ACTIVE',
  };

  it('should emit event with valid payload and correct envelope structure', () => {
    service.emit(DomainEventType.IDENTITY_CREATED, 'user-123', validIdentityCreatedPayload, {
      causedBy: 'parent-event-id',
    });

    expect(emitter.emitAsync).toHaveBeenCalledTimes(1);
    const [eventType, event] = (emitter.emitAsync as jest.Mock).mock.calls[0];

    expect(eventType).toBe(DomainEventType.IDENTITY_CREATED);
    expect(event.eventId).toBeTruthy();
    expect(event.type).toBe(DomainEventType.IDENTITY_CREATED);
    expect(event.aggregateId).toBe('user-123');
    expect(event.payload).toEqual(validIdentityCreatedPayload);
    expect(event.timestamp).toBeTruthy();
    expect(event.metadata.causedBy).toBe('parent-event-id');
    // No depth given: the event starts a chain.
    expect(event.metadata.depth).toBe(0);
  });

  it('should reject invalid payload and not dispatch (production mode)', () => {
    // Create a production-mode service (ConfigService returns 'production')
    const prodConfigService = { get: jest.fn().mockReturnValue('production') };
    const prodService = new DomainEventEmitterService(
      emitter as any,
      deadLetterService,
      outboxModel,
      prodConfigService as any,
    );
    prodService.emit(DomainEventType.IDENTITY_CREATED, 'user-123', { invalid: 'payload' } as any);

    expect(emitter.emitAsync).not.toHaveBeenCalled();
    expect(deadLetterService.capture).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'event_validation_failure' }),
    );
  });

  it('should throw on invalid payload in non-production mode', () => {
    // Default test service uses ConfigService returning 'test' (non-production)
    expect(() => {
      service.emit(DomainEventType.IDENTITY_CREATED, 'user-123', { invalid: 'payload' } as any);
    }).toThrow(/Invalid event payload/);
  });

  it('should include metadata with correlationId', () => {
    // The request's correlation id (CorrelationMiddleware), so the event traces to its request.
    requestContext.run(
      { correlationId: 'c-1', actor: 'admin@tenant-a.example', tenantId: 'tenant-a', startTime: 0 },
      () => service.emit(DomainEventType.IDENTITY_CREATED, 'user-123', validIdentityCreatedPayload),
    );
    service.emit(DomainEventType.IDENTITY_CREATED, 'user-123', validIdentityCreatedPayload);

    const [inRequest, outside] = (emitter.emitAsync as jest.Mock).mock.calls.map((c) => c[1]);
    expect(inRequest.metadata).toMatchObject({
      correlationId: 'c-1',
      actor: 'admin@tenant-a.example',
      tenantId: 'tenant-a',
    });
    expect(outside.metadata.correlationId).toBe('no-context');
  });

  it('should include tenantId in metadata (from options when no request context)', () => {
    service.emit(DomainEventType.IDENTITY_CREATED, 'user-123', validIdentityCreatedPayload, {
      tenantId: 'tenant-abc',
    });

    const event = (emitter.emitAsync as jest.Mock).mock.calls[0][1];
    expect(event.metadata.tenantId).toBe('tenant-abc');
  });

  it('should drop events when depth exceeds MAX_EVENT_DEPTH (20)', () => {
    service.emit(DomainEventType.IDENTITY_CREATED, 'user-123', validIdentityCreatedPayload, {
      depth: 21,
    });
    expect(emitter.emitAsync).not.toHaveBeenCalled();
    expect(deadLetterService.capture).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'event_chain_depth_exceeded',
        source: DomainEventType.IDENTITY_CREATED,
      }),
    );
  });

  it('should allow events at exactly MAX_EVENT_DEPTH (20)', () => {
    service.emit(DomainEventType.IDENTITY_CREATED, 'user-123', validIdentityCreatedPayload, {
      depth: 20,
    });
    expect(emitter.emitAsync).toHaveBeenCalledTimes(1);
  });

  it('should capture to DLQ when handler throws', async () => {
    const error = new Error('Handler failed');
    (emitter.emitAsync as jest.Mock).mockRejectedValueOnce(error);

    service.emit(DomainEventType.IDENTITY_CREATED, 'user-123', validIdentityCreatedPayload);

    await new Promise(process.nextTick);

    expect(deadLetterService.capture).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'event_handler_failure',
        source: DomainEventType.IDENTITY_CREATED,
        error: expect.objectContaining({ message: 'Handler failed' }),
      }),
    );
  });

  // ── emitAndWait ──────────────────────────────────────────────────

  describe('emitAndWait', () => {
    it('should emit and return handler results', async () => {
      (emitter.emitAsync as jest.Mock).mockResolvedValue(['workflow-123']);

      const results = await service.emitAndWait(
        DomainEventType.IDENTITY_CREATED,
        'user-123',
        validIdentityCreatedPayload,
      );

      expect(results).toEqual(['workflow-123']);
      expect(emitter.emitAsync).toHaveBeenCalledTimes(1);
    });

    it('should drop events when depth exceeds MAX_EVENT_DEPTH', async () => {
      const results = await service.emitAndWait(
        DomainEventType.IDENTITY_CREATED,
        'user-123',
        validIdentityCreatedPayload,
        { depth: 21 },
      );

      expect(results).toEqual([]);
      expect(emitter.emitAsync).not.toHaveBeenCalled();
      expect(deadLetterService.capture).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'event_chain_depth_exceeded' }),
      );
    });

    it('should throw on Zod validation failure', async () => {
      await expect(
        service.emitAndWait(DomainEventType.IDENTITY_CREATED, 'user-123', {
          invalid: 'payload',
        } as any),
      ).rejects.toThrow(/Invalid event payload/);

      expect(emitter.emitAsync).not.toHaveBeenCalled();
      expect(deadLetterService.capture).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'event_validation_failure' }),
      );
    });

    it('should auto-increment depth when parentDepth is provided', async () => {
      (emitter.emitAsync as jest.Mock).mockResolvedValue([]);

      await service.emitAndWait(
        DomainEventType.IDENTITY_CREATED,
        'user-123',
        validIdentityCreatedPayload,
        undefined,
        5,
      );

      const event = (emitter.emitAsync as jest.Mock).mock.calls[0][1];
      expect(event.metadata.depth).toBe(6); // parentDepth 5 + 1
    });
  });

  // ── emitWithTransaction (outbox path) ────────────────────────────

  describe('emitWithTransaction', () => {
    it('inserts an outbox row with the normalized envelope', async () => {
      const session = {} as any;
      await service.emitWithTransaction(
        DomainEventType.IDENTITY_CREATED,
        'user-123',
        validIdentityCreatedPayload,
        session,
        { tenantId: 'tenant-abc' },
      );

      expect(outboxModel.create).toHaveBeenCalledTimes(1);
      const [[doc], opts] = (outboxModel.create as jest.Mock).mock.calls[0];
      expect(doc.type).toBe(DomainEventType.IDENTITY_CREATED);
      expect(doc.aggregateId).toBe('user-123');
      expect(doc.status).toBe('pending');
      expect(doc.retryCount).toBe(0);
      expect(doc.eventId).toBeTruthy();
      expect(doc.payload).toEqual(validIdentityCreatedPayload);
      expect(doc.metadata.tenantId).toBe('tenant-abc');
      expect(opts.session).toBe(session);
      expect(emitter.emitAsync).not.toHaveBeenCalled();
    });

    it('does not write to outbox when payload fails Zod validation (non-prod throws)', async () => {
      await expect(
        service.emitWithTransaction(
          DomainEventType.IDENTITY_CREATED,
          'user-123',
          { invalid: 'payload' } as any,
          {} as any,
        ),
      ).rejects.toThrow(/Invalid event payload/);

      expect(outboxModel.create).not.toHaveBeenCalled();
      expect(deadLetterService.capture).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'event_validation_failure' }),
      );
    });

    it('captures invalid payload to DLQ and returns silently in production', async () => {
      const prodConfigService = { get: jest.fn().mockReturnValue('production') };
      const prodService = new DomainEventEmitterService(
        emitter as any,
        deadLetterService,
        outboxModel,
        prodConfigService as any,
      );
      await prodService.emitWithTransaction(
        DomainEventType.IDENTITY_CREATED,
        'user-123',
        { invalid: 'payload' } as any,
        {} as any,
      );
      expect(outboxModel.create).not.toHaveBeenCalled();
      expect(deadLetterService.capture).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'event_validation_failure' }),
      );
    });

    it('drops the event and captures to DLQ when depth exceeds MAX_EVENT_DEPTH', async () => {
      await service.emitWithTransaction(
        DomainEventType.IDENTITY_CREATED,
        'user-123',
        validIdentityCreatedPayload,
        {} as any,
        { depth: 21 },
      );
      expect(outboxModel.create).not.toHaveBeenCalled();
      expect(deadLetterService.capture).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'event_chain_depth_exceeded' }),
      );
    });
  });
});
