/**
 * The event handlers a dead-letter entry can be re-run on, by key (`Class.method`).
 *
 * Filled at bootstrap by `HandlerFailureCaptureService` (infrastructure/events) with every
 * `@OnEvent` method. Each run calls the handler itself, without Nest's error suppression, so a
 * retry learns whether the handler succeeded. Lives in the dead-letter module so the events
 * infrastructure can fill it and `DeadLetterService` can read it without a circular dependency.
 */
import { Injectable, Logger } from '@nestjs/common';

/** Runs one handler with a stored event; rejects when the handler fails. */
export type DeadLetterHandlerRun = (event: Record<string, unknown>) => Promise<unknown>;

/** `Class.method`, the key a dead-letter entry stores in `handler`. */
export function handlerKey(instance: object, methodKey: string): string {
  return `${instance.constructor.name}.${methodKey}`;
}

@Injectable()
export class DeadLetterHandlerRegistry {
  private readonly logger = new Logger(DeadLetterHandlerRegistry.name);
  private readonly runs = new Map<string, DeadLetterHandlerRun>();

  /** The first registration of a key wins (a class provided in two modules listens twice). */
  register(key: string, run: DeadLetterHandlerRun): void {
    if (this.runs.has(key)) {
      this.logger.debug(`Handler ${key} is already registered; keeping the first`);
      return;
    }
    this.runs.set(key, run);
  }

  get(key: string): DeadLetterHandlerRun | undefined {
    return this.runs.get(key);
  }

  keys(): string[] {
    return [...this.runs.keys()];
  }
}
