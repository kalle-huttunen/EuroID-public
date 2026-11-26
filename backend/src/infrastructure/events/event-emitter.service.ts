import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Model } from 'mongoose';
import { ClientSession } from 'mongoose';
import { randomUUID } from 'crypto';
import { DomainEvent } from './domain-event.interface';
import { DomainEventType } from './event-types';
import { getEventSchema } from './event-payload-schemas';
import { getRequestContext } from '../middleware/get-request-context';
import { DeadLetterService } from '../../modules/dead-letter/dead-letter.service';
import { OutboxEvent, OutboxEventDocument } from './schemas/outbox-event.schema';
import { failedHandlerOf, markAwaited } from './handler-dispatch';
import type { IDomainEventPort } from '@shared/interfaces/domain-event.port';

const MAX_EVENT_DEPTH = 20;

export interface EventOptions {
  causedBy?: string;
  depth?: number;
  actor?: string;
  tenantId?: string;
}

/**
 * Thin wrapper around EventEmitter2 that enforces the domain event envelope,
 * injects correlation metadata, and guards against event chain loops.
 */
@Injectable()
export class DomainEventEmitterService implements IDomainEventPort {
  private readonly logger = new Logger(DomainEventEmitterService.name);
  private readonly isProduction: boolean;

  constructor(
    private readonly emitter: EventEmitter2,
    private readonly deadLetterService: DeadLetterService,
    @InjectModel(OutboxEvent.name) private readonly outboxModel: Model<OutboxEventDocument>,
    private readonly configService: ConfigService,
  ) {
    this.isProduction = this.configService.get<string>('NODE_ENV') === 'production';
  }

  /**
   * Emit a domain event. Wraps payload in the standard envelope.
   *
   * @param type        Event type from the registry
   * @param aggregateId The primary entity ID (identityId, policyId, etc.)
   * @param payload     Event-specific data
   * @param options     Optional: causedBy (parent eventId), depth, actor override
   */
  emit<T>(type: DomainEventType, aggregateId: string, payload: T, options?: EventOptions): void {
    const depth = options?.depth ?? 0;

    if (depth > MAX_EVENT_DEPTH) {
      this.logger.error(
        `Event chain depth exceeded (${depth}) for ${type}. Possible loop. Dropping event.`,
      );
      this.deadLetterService.capture({
        type: 'event_chain_depth_exceeded',
        source: type,
        originalPayload: {
          aggregateId,
          depth,
          payload: payload as unknown as Record<string, unknown>,
        },
        error: { message: `Event chain depth ${depth} exceeded max ${MAX_EVENT_DEPTH}` },
        correlationId: getRequestContext()?.correlationId,
        retryCount: 0,
        tenantId: options?.tenantId ?? getRequestContext()?.tenantId ?? '',
      });
      return;
    }

    const schema = getEventSchema(type);
    const result = schema.safeParse(payload);
    if (!result.success) {
      this.logger.error(`Invalid event payload for ${type}`, {
        errors: result.error.flatten(),
        aggregateId,
      });
      this.deadLetterService.capture({
        type: 'event_validation_failure',
        source: type,
        originalPayload: { aggregateId, payload: payload as unknown as Record<string, unknown> },
        error: { message: JSON.stringify(result.error.flatten()) },
        correlationId: getRequestContext()?.correlationId,
        retryCount: 0,
        tenantId: options?.tenantId ?? getRequestContext()?.tenantId ?? '',
      });
      if (!this.isProduction) {
        throw new Error(
          `Invalid event payload for ${type}: ${JSON.stringify(result.error.flatten())}`,
        );
      }
      return;
    }

    const ctx = getRequestContext();
    const resolvedTenantId = ctx?.tenantId || options?.tenantId || '';
    if (!resolvedTenantId) {
      this.logger.warn(
        `[SECURITY] Emitting ${type} for ${aggregateId} with empty tenantId. ` +
          `Ensure the caller sets tenantId via request context or EventOptions.`,
      );
    }
    const event: DomainEvent<T> = {
      eventId: randomUUID(),
      type,
      aggregateId,
      timestamp: new Date().toISOString(),
      payload: result.data as T,
      metadata: {
        correlationId: ctx?.correlationId ?? 'no-context',
        causedBy: options?.causedBy,
        depth,
        emittedBy: this.constructor.name,
        actor: options?.actor ?? ctx?.actor ?? 'system',
        tenantId: resolvedTenantId,
      },
    };

    this.logger.debug(`Emitting ${type} for ${aggregateId}`);

    // Only a `suppressErrors: false` listener rejects here; HandlerFailureCaptureService
    // dead-letters the failures of all other handlers itself.
    this.emitter.emitAsync(type, event).catch((err) => {
      this.logger.error(`Handler error for ${type}: ${err.message}`, err.stack);
      this.deadLetterService.capture({
        type: 'event_handler_failure',
        source: type,
        handler: failedHandlerOf(err),
        originalPayload: event as unknown as Record<string, unknown>,
        error: { message: err.message, stack: err.stack },
        correlationId: event.metadata?.correlationId,
        retryCount: 0,
        tenantId: event.metadata?.tenantId,
      });
    });
  }

  /**
   * Emit and wait for handler results. Use when caller needs the return value (e.g. workflowId).
   * Returns array of return values from all handlers. First truthy value is often the one of interest.
   *
   * @param parentDepth When chaining events, pass the parent event's depth so the child auto-increments.
   *                    Handlers that re-emit MUST pass their event's depth as parentDepth.
   */
  async emitAndWait<T, R = unknown>(
    type: DomainEventType,
    aggregateId: string,
    payload: T,
    options?: EventOptions,
    parentDepth?: number,
  ): Promise<R[]> {
    const depth = (parentDepth ?? options?.depth ?? 0) + (parentDepth != null ? 1 : 0);
    if (depth > MAX_EVENT_DEPTH) {
      this.logger.error(
        `Event chain depth exceeded (${depth}) for ${type}. Possible loop. Dropping event.`,
      );
      this.deadLetterService.capture({
        type: 'event_chain_depth_exceeded',
        source: type,
        originalPayload: {
          aggregateId,
          depth,
          payload: payload as unknown as Record<string, unknown>,
        },
        error: { message: `Event chain depth ${depth} exceeded max ${MAX_EVENT_DEPTH}` },
        correlationId: getRequestContext()?.correlationId,
        retryCount: 0,
        tenantId: options?.tenantId ?? getRequestContext()?.tenantId ?? '',
      });
      return [];
    }

    const schema = getEventSchema(type);
    const result = schema.safeParse(payload);
    if (!result.success) {
      this.logger.error(`Invalid event payload for ${type}`, {
        errors: result.error.flatten(),
        aggregateId,
      });
      this.deadLetterService.capture({
        type: 'event_validation_failure',
        source: type,
        originalPayload: { aggregateId, payload: payload as unknown as Record<string, unknown> },
        error: { message: JSON.stringify(result.error.flatten()) },
        correlationId: getRequestContext()?.correlationId,
        retryCount: 0,
        tenantId: options?.tenantId ?? getRequestContext()?.tenantId ?? '',
      });
      // Throw the validation error so emitAndWait callers get a proper error
      throw new Error(
        `Invalid event payload for ${type}: ${JSON.stringify(result.error.flatten())}`,
      );
    }

    const ctx = getRequestContext();
    const resolvedTenantId = ctx?.tenantId || options?.tenantId || '';
    const event: DomainEvent<T> = {
      eventId: randomUUID(),
      type,
      aggregateId,
      timestamp: new Date().toISOString(),
      payload: result.data as T,
      metadata: {
        correlationId: ctx?.correlationId ?? 'no-context',
        causedBy: options?.causedBy,
        depth,
        emittedBy: this.constructor.name,
        actor: options?.actor ?? ctx?.actor ?? 'system',
        tenantId: resolvedTenantId,
      },
    };

    this.logger.debug(`Emitting (wait) ${type} for ${aggregateId}`);
    // The caller owns a failure of a handler that answers it: not dead-lettered.
    markAwaited(event);
    const results = await this.emitter.emitAsync(type, event);
    return (results ?? []) as R[];
  }

  /**
   * Emit a domain event within a MongoDB transaction. Inserts into event_outbox;
   * the outbox poller publishes to the event bus. Use when the event must be
   * atomic with an entity update.
   */
  async emitWithTransaction<T>(
    type: DomainEventType,
    aggregateId: string,
    payload: T,
    session: ClientSession,
    options?: EventOptions,
  ): Promise<void> {
    const depth = options?.depth ?? 0;

    if (depth > MAX_EVENT_DEPTH) {
      this.logger.error(
        `Event chain depth exceeded (${depth}) for ${type}. Possible loop. Dropping event.`,
      );
      this.deadLetterService.capture({
        type: 'event_chain_depth_exceeded',
        source: type,
        originalPayload: {
          aggregateId,
          depth,
          payload: payload as unknown as Record<string, unknown>,
        },
        error: { message: `Event chain depth ${depth} exceeded max ${MAX_EVENT_DEPTH}` },
        correlationId: getRequestContext()?.correlationId,
        retryCount: 0,
        tenantId: options?.tenantId ?? getRequestContext()?.tenantId ?? '',
      });
      return;
    }

    const schema = getEventSchema(type);
    const parseResult = schema.safeParse(payload);
    if (!parseResult.success) {
      this.logger.error(`Invalid event payload for ${type}`, {
        errors: parseResult.error.flatten(),
        aggregateId,
      });
      this.deadLetterService.capture({
        type: 'event_validation_failure',
        source: type,
        originalPayload: { aggregateId, payload: payload as unknown as Record<string, unknown> },
        error: { message: JSON.stringify(parseResult.error.flatten()) },
        correlationId: getRequestContext()?.correlationId,
        retryCount: 0,
        tenantId: options?.tenantId ?? getRequestContext()?.tenantId ?? '',
      });
      if (!this.isProduction) {
        throw new Error(
          `Invalid event payload for ${type}: ${JSON.stringify(parseResult.error.flatten())}`,
        );
      }
      return;
    }

    const ctx = getRequestContext();
    const resolvedTenantId = ctx?.tenantId || options?.tenantId || '';
    if (!resolvedTenantId) {
      this.logger.warn(
        `[SECURITY] Outbox event ${type} for ${aggregateId} with empty tenantId. ` +
          `Ensure the caller sets tenantId via request context or EventOptions.`,
      );
    }
    const event: DomainEvent<T> = {
      eventId: randomUUID(),
      type,
      aggregateId,
      timestamp: new Date().toISOString(),
      payload: parseResult.data as T,
      metadata: {
        correlationId: ctx?.correlationId ?? 'no-context',
        causedBy: options?.causedBy,
        depth,
        emittedBy: this.constructor.name,
        actor: options?.actor ?? ctx?.actor ?? 'system',
        tenantId: resolvedTenantId,
      },
    };

    this.logger.debug(`Outbox: ${type} for ${aggregateId}`);

    await this.outboxModel.create(
      [
        {
          eventId: event.eventId,
          type: event.type,
          aggregateId: event.aggregateId,
          payload: event.payload as unknown as Record<string, unknown>,
          metadata: event.metadata,
          status: 'pending',
          retryCount: 0,
        },
      ],
      { session },
    );
  }
}

// ── TASK 106 RECAP ──
// Added: emitWithTransaction() — inserts event into event_outbox within caller's MongoDB session.
// Injects OutboxEvent model. Original emit() unchanged for backward compatibility.
