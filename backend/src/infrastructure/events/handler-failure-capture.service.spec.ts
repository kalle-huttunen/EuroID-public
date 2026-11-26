/**
 * Handler failures reach the dead-letter queue (2.0cu): Nest's event emitter swallows a
 * listener's error unless it sets `suppressErrors: false`, so before 2.0cu `emit()`'s catch never
 * saw them. Real Nest event emitter and DomainEventEmitterService; the DLQ capture is a spy.
 */
import { Global, Injectable, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DiscoveryModule } from '@nestjs/core';
import { EventEmitter2, EventEmitterModule, OnEvent } from '@nestjs/event-emitter';
import { getModelToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { DeadLetterService } from '../../modules/dead-letter/dead-letter.service';
import { DeadLetterHandlerRegistry } from '../../modules/dead-letter/dead-letter-handler.registry';
import { HandlerFailureCaptureService } from './handler-failure-capture.service';
import { DomainEventEmitterService } from './event-emitter.service';
import { DomainEventType } from './event-types';
import type { DomainEvent } from './domain-event.interface';
import { OutboxEvent } from './schemas/outbox-event.schema';
import { trackRerun } from './handler-dispatch';

const CREATED = {
  identityId: 'id-1',
  sourceSystem: 'workday',
  sourceUserId: 'w-1',
  status: 'ACTIVE',
};

/** Which handlers throw is set per test. */
@Injectable()
class FlakyHandlers {
  readonly ran: string[] = [];
  readonly failing = new Set<string>();

  private step(name: string, event: DomainEvent): string {
    this.ran.push(name);
    if (this.failing.has(name)) throw new Error(`${name} failed for ${event.aggregateId}`);
    return `${name} ok`;
  }

  @OnEvent(DomainEventType.IDENTITY_CREATED, { async: true })
  async detached(event: DomainEvent): Promise<string> {
    return this.step('detached', event);
  }

  @OnEvent(DomainEventType.IDENTITY_CREATED)
  async inline(event: DomainEvent): Promise<string> {
    return this.step('inline', event);
  }

  @OnEvent(DomainEventType.IDENTITY_CREATED)
  plain(event: DomainEvent): string {
    return this.step('plain', event);
  }

  @OnEvent(DomainEventType.COMPLIANCE_REPORT_GENERATED, { suppressErrors: false })
  async strict(event: DomainEvent): Promise<string> {
    return this.step('strict', event);
  }
}

/*
 * The production layout, for the startup timing of the wrapper: it lives in the @Global events
 * module, which AppModule imports before the feature modules that hold the handlers. Nest runs a
 * global module's onModuleInit before any feature module's, so the feature handlers must already
 * exist (and be wrapped) at that point, nested modules included.
 */
const layoutCapture = jest.fn().mockResolvedValue(undefined);

@Injectable()
class FeatureHandler {
  // Like the real handlers, it depends on the global events module.
  constructor(readonly events: DomainEventEmitterService) {}

  @OnEvent(DomainEventType.IDENTITY_CREATED, { async: true })
  async onCreated(event: DomainEvent): Promise<void> {
    throw new Error(`feature handler failed for ${event.aggregateId}`);
  }
}

@Injectable()
class NestedFeatureHandler {
  @OnEvent(DomainEventType.IDENTITY_CREATED)
  async onCreated(event: DomainEvent): Promise<void> {
    throw new Error(`nested handler failed for ${event.aggregateId}`);
  }
}

@Module({ providers: [NestedFeatureHandler] })
class NestedFeatureModule {}

@Module({ imports: [NestedFeatureModule], providers: [FeatureHandler] })
class FeatureModule {}

@Module({
  providers: [
    { provide: DeadLetterService, useValue: { capture: layoutCapture } },
    DeadLetterHandlerRegistry,
  ],
  exports: [DeadLetterService, DeadLetterHandlerRegistry],
})
class DeadLetterStubModule {}

@Global()
@Module({
  imports: [
    EventEmitterModule.forRoot({ wildcard: true, delimiter: '.' }),
    DeadLetterStubModule,
    DiscoveryModule,
  ],
  providers: [
    DomainEventEmitterService,
    HandlerFailureCaptureService,
    { provide: getModelToken(OutboxEvent.name), useValue: {} },
    { provide: ConfigService, useValue: { get: () => 'test' } },
  ],
  exports: [DomainEventEmitterService],
})
class GlobalEventsModule {}

/** Lets `async: true` listeners (setImmediate) and the awaited capture finish. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('HandlerFailureCaptureService', () => {
  let moduleRef: TestingModule;
  let handlers: FlakyHandlers;
  let events: DomainEventEmitterService;
  let emitter: EventEmitter2;
  let registry: DeadLetterHandlerRegistry;
  const capture = jest.fn().mockResolvedValue(undefined);

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [EventEmitterModule.forRoot({ wildcard: true, delimiter: '.' }), DiscoveryModule],
      providers: [
        HandlerFailureCaptureService,
        DeadLetterHandlerRegistry,
        DomainEventEmitterService,
        FlakyHandlers,
        { provide: DeadLetterService, useValue: { capture } },
        { provide: getModelToken(OutboxEvent.name), useValue: {} },
        { provide: ConfigService, useValue: { get: () => 'test' } },
      ],
    }).compile();
    await moduleRef.init(); // wraps the handlers, then registers the @OnEvent listeners

    handlers = moduleRef.get(FlakyHandlers);
    events = moduleRef.get(DomainEventEmitterService);
    emitter = moduleRef.get(EventEmitter2);
    registry = moduleRef.get(DeadLetterHandlerRegistry);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(() => {
    capture.mockClear();
    handlers.ran.length = 0;
    handlers.failing.clear();
  });

  const capturedHandlers = () =>
    capture.mock.calls.map(([entry]) => (entry as { handler?: string }).handler);

  it('dead-letters a failing detached handler with its event, and the others still run', async () => {
    handlers.failing.add('detached');

    expect(() =>
      events.emit(DomainEventType.IDENTITY_CREATED, 'id-1', CREATED, { tenantId: 'tenant-a' }),
    ).not.toThrow();
    await settle();

    expect(handlers.ran.sort()).toEqual(['detached', 'inline', 'plain']);
    expect(capture).toHaveBeenCalledTimes(1);
    const [entry] = capture.mock.calls[0] as [Record<string, unknown>];
    expect(entry).toMatchObject({
      type: 'event_handler_failure',
      source: DomainEventType.IDENTITY_CREATED,
      handler: 'FlakyHandlers.detached',
      tenantId: 'tenant-a',
      error: { message: 'detached failed for id-1' },
      originalPayload: {
        type: DomainEventType.IDENTITY_CREATED,
        aggregateId: 'id-1',
        payload: CREATED,
        metadata: expect.objectContaining({ tenantId: 'tenant-a' }),
      },
    });
  });

  it('dead-letters each failing inline handler of a fire-and-forget emit', async () => {
    handlers.failing.add('inline');
    handlers.failing.add('plain');

    events.emit(DomainEventType.IDENTITY_CREATED, 'id-1', CREATED, { tenantId: 'tenant-a' });
    await settle();

    expect(handlers.ran).toContain('detached');
    expect(capturedHandlers().sort()).toEqual(['FlakyHandlers.inline', 'FlakyHandlers.plain']);
  });

  it("leaves an awaited handler's failure to emitAndWait's caller, but dead-letters a detached one", async () => {
    handlers.failing.add('inline');
    handlers.failing.add('detached');

    const results = await events.emitAndWait(DomainEventType.IDENTITY_CREATED, 'id-1', CREATED, {
      tenantId: 'tenant-a',
    });
    await settle();

    // The caller sees the healthy handler's answer and nothing from the failed one, as before.
    expect(results).toContain('plain ok');
    expect(results).not.toContain('inline ok');
    expect(capturedHandlers()).toEqual(['FlakyHandlers.detached']);
  });

  it('dead-letters a suppressErrors: false failure once, through emit(), naming the handler', async () => {
    handlers.failing.add('strict');

    events.emit(
      DomainEventType.COMPLIANCE_REPORT_GENERATED,
      'report-1',
      {},
      { tenantId: 'tenant-a' },
    );
    await settle();

    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture.mock.calls[0][0]).toMatchObject({
      source: DomainEventType.COMPLIANCE_REPORT_GENERATED,
      handler: 'FlakyHandlers.strict',
      tenantId: 'tenant-a',
    });
  });

  it('registers every handler: a run calls only that handler and reports its failure', async () => {
    handlers.failing.add('detached');
    const run = registry.get('FlakyHandlers.detached');
    expect(run).toBeDefined();
    expect(registry.keys()).toEqual(
      expect.arrayContaining([
        'FlakyHandlers.inline',
        'FlakyHandlers.plain',
        'FlakyHandlers.strict',
      ]),
    );

    const event = { type: DomainEventType.IDENTITY_CREATED, aggregateId: 'id-1', metadata: {} };
    await expect(run!(event)).rejects.toThrow('detached failed for id-1');
    expect(handlers.ran).toEqual(['detached']);
    expect(capture).not.toHaveBeenCalled();

    handlers.failing.clear();
    await expect(registry.get('FlakyHandlers.plain')!(event)).resolves.toBe('plain ok');
  });

  it('reports the handler outcomes of a dead-letter re-emit instead of capturing new entries', async () => {
    handlers.failing.add('detached');
    const event = {
      eventId: 'e-1',
      type: DomainEventType.IDENTITY_CREATED,
      aggregateId: 'id-1',
      timestamp: new Date().toISOString(),
      payload: CREATED,
      metadata: {
        correlationId: 'c',
        depth: 0,
        emittedBy: 'test',
        actor: 'test',
        tenantId: 'tenant-a',
      },
    };

    const done = trackRerun(event);
    await emitter.emitAsync(event.type, event);
    const failures = await done();

    expect(failures).toEqual([
      {
        handler: 'FlakyHandlers.detached',
        error: expect.objectContaining({ message: 'detached failed for id-1' }),
      },
    ]);
    expect(handlers.ran.sort()).toEqual(['detached', 'inline', 'plain']);
    expect(capture).not.toHaveBeenCalled();
  });
});

describe('HandlerFailureCaptureService in the production module layout', () => {
  let moduleRef: TestingModule;

  beforeAll(async () => {
    // Events module first, feature modules after it, as in AppModule.
    moduleRef = await Test.createTestingModule({
      imports: [GlobalEventsModule, FeatureModule],
    }).compile();
    await moduleRef.init();
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  it('wraps and registers the handlers of the feature modules, nested ones included', async () => {
    expect(moduleRef.get(DeadLetterHandlerRegistry).keys()).toEqual(
      expect.arrayContaining(['FeatureHandler.onCreated', 'NestedFeatureHandler.onCreated']),
    );

    moduleRef
      .get(DomainEventEmitterService)
      .emit(DomainEventType.IDENTITY_CREATED, 'id-9', CREATED, { tenantId: 'tenant-b' });
    await settle();

    const captured = layoutCapture.mock.calls.map(([entry]) => entry as Record<string, unknown>);
    expect(captured.map((entry) => entry.handler).sort()).toEqual([
      'FeatureHandler.onCreated',
      'NestedFeatureHandler.onCreated',
    ]);
    expect(captured).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tenantId: 'tenant-b',
          error: expect.objectContaining({ message: 'feature handler failed for id-9' }),
        }),
      ]),
    );
  });
});
