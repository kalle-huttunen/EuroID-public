/**
 * Handler failures to the dead-letter queue.
 *
 * `@nestjs/event-emitter` swallows a listener's error unless the listener sets
 * `suppressErrors: false` (it only logs it), and an `async: true` listener runs detached from the
 * emit, so `DomainEventEmitterService.emit()`'s catch never sees most handler failures. At startup
 * this service wraps every `@OnEvent` method: a failure is captured as an `event_handler_failure`
 * entry that stores the event and the handler (`Class.method`), then rethrown, so Nest logs and
 * suppresses it as before (the emitting request and the other handlers carry on). It also
 * registers each handler in `DeadLetterHandlerRegistry`, so a retry runs only the handler that
 * failed.
 *
 * Not captured here (the emitter deals with the failure):
 * - a listener with `suppressErrors: false`: its error reaches the emitter (`emitAndWait`'s caller,
 *   or `emit()`'s catch, which captures it with the handler tagged here);
 * - a listener without `async: true` on an event emitted with `emitAndWait`: it answers that
 *   caller, which gets `undefined` on a failure and reports it;
 * - any handler while a dead-letter retry re-emits the event: the retry collects the outcome.
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';
import type { OnEventMetadata } from '@nestjs/event-emitter';
import { EVENT_LISTENER_METADATA } from '@nestjs/event-emitter/dist/constants';
import { DeadLetterService } from '../../modules/dead-letter/dead-letter.service';
import {
  DeadLetterHandlerRegistry,
  handlerKey,
} from '../../modules/dead-letter/dead-letter-handler.registry';
import { isAwaited, rerunOf, tagFailedHandler } from './handler-dispatch';
import type { DomainEvent } from './domain-event.interface';

type Method = (...args: unknown[]) => unknown;

/** Wrapped methods, so a provider discovered twice is not wrapped twice. */
const wrappedMethods = new WeakSet<Method>();

function asEnvelope(event: unknown): DomainEvent | undefined {
  const candidate = event as Partial<DomainEvent> | undefined;
  return typeof candidate?.type === 'string' &&
    typeof candidate.metadata === 'object' &&
    candidate.metadata !== null
    ? (candidate as DomainEvent)
    : undefined;
}

@Injectable()
export class HandlerFailureCaptureService implements OnModuleInit {
  private readonly logger = new Logger(HandlerFailureCaptureService.name);

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly deadLetterService: DeadLetterService,
    private readonly registry: DeadLetterHandlerRegistry,
  ) {}

  /** Runs before EventSubscribersLoader subscribes the listeners (onApplicationBootstrap). */
  onModuleInit(): void {
    let count = 0;
    for (const wrapper of [...this.discovery.getProviders(), ...this.discovery.getControllers()]) {
      const instance: unknown = wrapper.instance;
      // Request-scoped providers are resolved per event by Nest; none listens to events today.
      if (!instance || typeof instance !== 'object' || wrapper.isAlias) continue;
      if (!wrapper.isDependencyTreeStatic()) continue;
      const prototype: object | null = Object.getPrototypeOf(instance);
      for (const methodKey of this.scanner.getAllMethodNames(prototype)) {
        if (this.wrap(instance as Record<string, unknown>, methodKey)) count++;
      }
    }
    this.logger.log(`Dead-letter capture installed on ${count} event handlers`);
  }

  private wrap(instance: Record<string, unknown>, methodKey: string): boolean {
    const original = instance[methodKey];
    if (typeof original !== 'function' || wrappedMethods.has(original as Method)) return false;
    const method = original as Method;
    const listeners = Reflect.getMetadata(EVENT_LISTENER_METADATA, method) as
      | OnEventMetadata
      | OnEventMetadata[]
      | undefined;
    if (!listeners) return false;
    const options = (Array.isArray(listeners) ? listeners : [listeners]).map((l) => l.options);

    const key = handlerKey(instance, methodKey);
    // A retry calls the handler itself: no Nest error suppression, so it learns the outcome.
    this.registry.register(key, async (event) => method.call(instance, event));

    const propagates = options.some((o) => o?.suppressErrors === false);
    const answersCaller = options.some((o) => !o?.async);
    const capture = (event: unknown, err: unknown) => this.capture(key, event, err);

    const wrapped: Method = (...args: unknown[]) => {
      const event = args[0];
      const rerun = rerunOf(event);
      const run = (async () => method.apply(instance, args))();
      rerun?.push(
        run.then(
          () => undefined,
          (error: unknown) => ({ handler: key, error }),
        ),
      );
      return run.catch(async (err: unknown) => {
        tagFailedHandler(err, key);
        const emitterHandlesIt = propagates || (answersCaller && isAwaited(event));
        if (!rerun && !emitterHandlesIt) await capture(event, err);
        throw err;
      });
    };

    // EventSubscribersLoader reads the @OnEvent metadata from the method it finds on the instance.
    for (const metadataKey of Reflect.getOwnMetadataKeys(method)) {
      Reflect.defineMetadata(metadataKey, Reflect.getOwnMetadata(metadataKey, method), wrapped);
    }
    wrappedMethods.add(wrapped);
    Object.defineProperty(instance, methodKey, {
      value: wrapped,
      writable: true,
      configurable: true,
      enumerable: false,
    });
    return true;
  }

  /** Never throws: DeadLetterService.capture logs its own failures. */
  private async capture(handler: string, event: unknown, err: unknown): Promise<void> {
    const error = err instanceof Error ? err : new Error(String(err));
    const envelope = asEnvelope(event);
    await this.deadLetterService.capture({
      type: 'event_handler_failure',
      source: envelope?.type ?? handler,
      handler,
      originalPayload: (envelope ?? { value: event }) as unknown as Record<string, unknown>,
      error: { message: error.message, stack: error.stack },
      correlationId: envelope?.metadata.correlationId,
      retryCount: 0,
      tenantId: envelope?.metadata.tenantId,
    });
  }
}
